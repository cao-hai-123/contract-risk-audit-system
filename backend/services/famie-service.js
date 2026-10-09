import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRoot = path.join(projectRoot, 'third_party', 'famie', 'source', 'famie-main')
const sourceReadme = path.join(sourceRoot, 'README.md')
const defaultBaseUrl = 'http://127.0.0.1:9000'

export const famieEntityTypes = [
  'CONTRACT_PARTY',
  'CONTRACT_TITLE',
  'CONTRACT_NUMBER',
  'SIGN_DATE',
  'EFFECTIVE_DATE',
  'AMOUNT',
  'CURRENCY',
  'PAYMENT_TERM',
  'PERFORMANCE_PERIOD',
  'DELIVERY_OR_SERVICE',
  'DISPUTE_RESOLUTION',
  'JURISDICTION',
  'CONTACT',
  'ADDRESS'
]

export function getFamieConfiguration() {
  const baseUrl = String(process.env.FAMIE_BASE_URL || defaultBaseUrl).replace(/\/$/, '')
  const enabled = !['0', 'false', 'off'].includes(String(process.env.FAMIE_ENABLED || 'true').toLowerCase())
  return {
    enabled,
    baseUrl,
    uiUrl: baseUrl,
    sourceAvailable: fs.existsSync(sourceReadme),
    sourcePath: 'third_party/famie/source/famie-main',
    license: 'GPL-3.0-only',
    version: 'FAMIE 0.3.0'
  }
}

export async function getFamieStatus({ fetchImpl = fetch } = {}) {
  const configuration = getFamieConfiguration()
  if (!configuration.enabled) {
    return { ...configuration, state: 'disabled', ready: false, message: 'FAMIE 标注服务已在配置中关闭。' }
  }
  if (!configuration.sourceAvailable) {
    return { ...configuration, state: 'source_missing', ready: false, message: '未发现项目内 FAMIE 源码，无法启动标注服务。' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(process.env.FAMIE_HEALTH_TIMEOUT_MS || 2500))
  try {
    const response = await fetchImpl(`${configuration.baseUrl}/api/health`, { signal: controller.signal })
    const payload = response.ok ? await response.json().catch(() => null) : null
    const reachable = response.ok && payload?.service === 'famie' && payload?.status === 'ready'
    return {
      ...configuration,
      state: reachable ? 'ready' : 'unavailable',
      ready: reachable,
      message: reachable ? 'FAMIE 本地标注服务已响应，可在独立工作台创建标注项目。' : `FAMIE 服务返回 HTTP ${response.status}。`,
      httpStatus: response.status
    }
  } catch (error) {
    return {
      ...configuration,
      state: 'unavailable',
      ready: false,
      message: describeFamieConnectionError(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

export function buildFamieAnnotationDataset(contract) {
  const sourceFile = normalizeText(contract?.sourceFile || '未命名合同')
  const paragraphs = Array.isArray(contract?.paragraphStructure) ? contract.paragraphStructure : []
  const units = []

  for (const paragraph of paragraphs) {
    const content = normalizeText(paragraph?.content || paragraph?.text || paragraph?.title || '')
    if (!content || isPageMarker(content)) continue
    for (const sentence of splitForAnnotation(content)) {
      if (sentence.length >= 2) units.push(sentence)
    }
  }

  const deduplicated = [...new Set(units)].slice(0, 2000)
  if (!deduplicated.length) {
    throw new Error('当前合同没有可导出为 FAMIE 标注样本的有效段落。')
  }

  return {
    text: deduplicated.join('\n'),
    fileName: `${safeFileStem(sourceFile)}-famie-unlabeled-contract-elements.txt`,
    sourceFile,
    unitCount: deduplicated.length,
    paragraphCount: paragraphs.length,
    format: 'utf-8 plain text, one semantic unit per line',
    entityTypeCount: famieEntityTypes.length
  }
}

export function buildFamieEntityTypeFile() {
  return {
    text: `${famieEntityTypes.join('\n')}\n`,
    fileName: 'famie-contract-element-entity-types.txt',
    entityTypes: famieEntityTypes
  }
}

function splitForAnnotation(value) {
  const units = []
  let pending = ''
  const sentences = String(value || '').split(/(?<=[。！？；!?;])/u)
  for (const item of sentences) {
    const text = normalizeText(item)
    if (!text) continue
    if (!pending) {
      pending = text
    } else if (pending.length + text.length <= 260) {
      pending += text
    } else {
      units.push(pending)
      pending = text
    }
    if (pending.length >= 180 || /[。！？；!?;]$/u.test(pending)) {
      units.push(pending)
      pending = ''
    }
  }
  if (pending) units.push(pending)
  return units
}

function describeFamieConnectionError(error) {
  if (error?.name === 'AbortError') return '无法在限定时间内连接 FAMIE 服务。请确认 Docker Desktop 已启动，并执行 FAMIE 服务启动命令。'
  if (error?.cause?.code === 'ECONNREFUSED') return 'FAMIE 服务尚未启动。当前合同解析不受影响；启动服务后可进行人工标注训练。'
  if (error?.cause?.code === 'ENOTFOUND') return '无法解析 FAMIE 服务地址。请检查 FAMIE_BASE_URL 配置。'
  return `无法连接 FAMIE 服务：${error?.message || '未知错误'}。`
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
}

function isPageMarker(value) {
  return /^--\s*\d+\s+of\s+\d+\s*--$/i.test(value) || /^第\s*\d+\s*页\s*共\s*\d+\s*页$/.test(value)
}

function safeFileStem(value) {
  return String(value || 'contract').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'contract'
}
