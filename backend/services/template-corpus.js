import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
const extensions = new Set(['.doc', '.docx', '.pdf', '.wps'])

function parseIsolated(filePath, fileName) {
  return new Promise((resolve) => {
    const worker = fork(fileURLToPath(new URL('./template-parser-worker.js', import.meta.url)), [filePath, fileName], { windowsHide: true, execArgv: ['--no-experimental-webstorage'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let settled = false
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); worker.kill(); resolve(result) }
    const failed = (message) => finish({ fileName, fileType: path.extname(fileName).slice(1), text: '', paragraphs: [], coverage: { complete: false }, warnings: [message] })
    const timer = setTimeout(() => failed('单文件解析超过 120 秒，已终止隔离解析器；须人工核对或转换格式。'), 120000)
    worker.once('message', finish)
    worker.once('error', (error) => failed(String(error.message).slice(0, 400)))
    worker.once('exit', () => { if (!settled) failed('隔离解析器提前退出。') })
  })
}

// Keep meaningful edition qualifiers (预售/现售, 包干制/酬金制). Only remove a copy suffix.
export function templateFamily(fileName) {
  return path.basename(fileName, path.extname(fileName)).normalize('NFKC')
    .replace(/\s*\(\d+\)$/, '').replace(/\s+/g, '').toLowerCase()
}

export async function analyzeTemplateCorpus({ directory = path.resolve('match'), cacheDirectory = path.resolve('data/template-corpus'), onProgress = () => {} } = {}) {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const parserVersion = hash(await fs.readFile(new URL('./document-parser.js', import.meta.url)))
  await fs.mkdir(path.join(cacheDirectory, 'parsed'), { recursive: true })
  const records = [], documents = []
  for (const [index, entry] of entries.entries()) {
    const buffer = await fs.readFile(path.join(directory, entry.name))
    const contentHash = hash(buffer), family = templateFamily(entry.name)
    const cacheKey = hash(contentHash + path.extname(entry.name).toLowerCase() + parserVersion)
    const cachePath = path.join(cacheDirectory, 'parsed', cacheKey + '.json')
    let parsed, cached = false
    try { parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')); cached = true } catch {}
    if (parsed?.warnings?.some((w) => /隔离解析器|120 秒|spawn.*(?:EPERM|EACCES)/.test(w))) parsed = null
    if (!parsed) {
      cached = false
      try { parsed = await parseIsolated(path.join(directory, entry.name), entry.name) }
      catch (error) { parsed = { text: '', paragraphs: [], coverage: { complete: false }, warnings: [String(error.message).slice(0, 400)] } }
      await fs.writeFile(cachePath, JSON.stringify(parsed), 'utf8')
    }
    const status = !parsed.text?.trim() ? 'text_unavailable' : parsed.coverage?.complete === false ? 'partial' : 'parsed'
    const record = { sourceKey: 'file:' + hash(entry.name), fileName: entry.name, fileType: path.extname(entry.name).slice(1),
      contentHash, textHash: hash(String(parsed.text || '').normalize('NFKC').replace(/\s+/g, '')), family,
      parseStatus: status, textLength: parsed.text?.length || 0, paragraphCount: parsed.paragraphs?.length || 0,
      coverage: { ...parsed.coverage, complete: status === 'parsed' }, warnings: parsed.warnings || [], cacheKey }
    records.push(record)
    documents.push({ ...record, parsed })
    onProgress({ current: index + 1, total: entries.length, fileName: entry.name, status, cached })
  }
  const manifest = { checkedAt: new Date().toISOString(), parserVersion, directory, totalFiles: records.length,
    parsedFiles: records.filter((r) => r.parseStatus === 'parsed').length,
    partialFiles: records.filter((r) => r.parseStatus === 'partial').length,
    unavailableFiles: records.filter((r) => r.parseStatus === 'text_unavailable').map((r) => r.fileName),
    familyCount: new Set(records.map((r) => r.family)).size,
    uniqueRecognizedTexts: new Set(records.filter((r) => r.textLength).map((r) => r.textHash)).size, files: records }
  await fs.writeFile(path.join(cacheDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { manifest, documents }
}
