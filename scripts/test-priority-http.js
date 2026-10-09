import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import { Document, Packer, Paragraph } from 'docx'
import mammoth from 'mammoth'
dotenv.config()
const config = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', charset: 'utf8mb4' }
const database = 'contract_http_test_' + Date.now()
assert.match(database, /^contract_http_test_\d+$/)
const quoted = String.fromCharCode(96) + database + String.fromCharCode(96)
const children = [], results = [], browserErrors = []
let browser, connection, created = false
const admin = await mysql.createConnection(config)
const directory = path.resolve('tmp/priority-repairs')
await fs.mkdir(directory, { recursive: true })
const check = async (name, run) => { await run(); results.push({ name, passed: true }); console.log('PASS ' + name) }
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
const apiPort = await freePort(), uiPort = await freePort()
const api = 'http://127.0.0.1:' + apiPort, ui = 'http://127.0.0.1:' + uiPort
function start(args, env) {
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stdout.on('data', (data) => { diagnostics = (diagnostics + data).slice(-3000) })
  child.stderr.on('data', (data) => { diagnostics = (diagnostics + data).slice(-3000) })
  child.diagnostics = () => diagnostics
  children.push(child)
  return child
}
async function ready(url, child) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error('Test service exited: ' + child.diagnostics())
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw Error('Test service readiness timeout: ' + child.diagnostics())
}
const post = (route, payload) => fetch(api + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const upload = (name, buffer) => { const form = new FormData(); form.append('contract', new Blob([buffer]), name); return fetch(ui + '/api/contracts/parse', { method: 'POST', body: form }) }
const lines = ['模拟服务合同', '甲方为模拟科技有限公司；乙方为模拟服务有限公司。', '合同金额人民币12345元，甲方应于验收后三个工作日付款。', '乙方交付软件成果，甲方按质量标准验收；不合格应整改。', '乙方承担一切责任，赔偿甲方全部损失。', '双方发生争议先协商，协商不成向人民法院起诉。']
const word = await Packer.toBuffer(new Document({ sections: [{ children: lines.map((text) => new Paragraph(text)) }] }))
let contract, audit, match, report
try {
  await admin.query('CREATE DATABASE ' + quoted + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  const env = { ...process.env, DB_NAME: database, PORT: String(apiPort), VITE_PORT: String(uiPort), HOST: '127.0.0.1', UI_ORIGINS: ui,
    LOCAL_LLM_MODE: 'disabled', LOCAL_EMBEDDING_MODE: 'disabled', DEEPSEEK_API_DISABLED: 'true' }
  const apiProcess = start(['backend/server.js'], env)
  const viteProcess = start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort'], env)
  await Promise.all([ready(api + '/api/health', apiProcess), ready(ui, viteProcess)])
  connection = await mysql.createConnection({ ...config, database })
  await check('live API health and explicit untrusted-origin rejection', async () => {
    const health = await (await fetch(api + '/api/health')).json()
    assert.equal(health.status, 'ok'); assert.notEqual(health.localModel.state, 'ready')
    assert.equal((await fetch(api + '/api/health', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403)
  })
  await check('all downstream routes reject empty/demo/failed input without operation records', async () => {
    for (const route of ['/api/contracts/risk-audit', '/api/contracts/standard-clause-match', '/api/contracts/report', '/api/contracts/preview-segments', '/api/report-management/prepare', '/api/assistant/chat']) {
      for (const state of ['empty', 'demo', 'failed']) {
        assert.equal((await post(route, { contract: { sourceFile: '模拟.docx', analysisState: state, paragraphStructure: [{ content: lines.join('\n') }] } })).status, 422, route)
      }
    }
    const [rows] = await connection.query('SELECT COUNT(*) AS n FROM operation_records'); assert.equal(Number(rows[0].n), 0)
  })
  await check('real upload rejects absent, unsupported, empty and corrupt documents', async () => {
    assert.equal((await upload('不支持.txt', Buffer.from(lines.join('\n')))).status, 400)
    assert.equal((await upload('损坏.docx', Buffer.from('not a word document'))).status, 422)
    assert.equal((await upload('损坏.doc', Buffer.from('not a legacy document'))).status, 422)
    const empty = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('')] }] }))
    assert.equal((await upload('空白.docx', empty)).status, 422)
    assert.equal((await fetch(api + '/api/contracts/parse', { method: 'POST' })).status, 422)
  })
  await check('20 MB multipart and 16 MB structured-body limits return actionable 413', async () => {
    const oversized = await upload('超大.pdf', Buffer.alloc(21 * 1024 * 1024, 32))
    assert.equal(oversized.status, 413); assert.match((await oversized.json()).message, /20 MB/)
    const structured = await post('/api/contracts/risk-audit', { padding: 'a'.repeat(17 * 1024 * 1024) })
    assert.equal(structured.status, 413)
  })
  await check('Chinese Word upload persists identity and truthful cloud fallback', async () => {
    const response = await upload('脱敏中文测试合同.docx', word)
    assert.equal(response.status, 200)
    contract = (await response.json()).parsed
    assert.equal(contract.sourceFile, '脱敏中文测试合同.docx'); assert.equal(contract.ai.used, false)
    assert.equal(contract.parseSnapshotId.length, 36); assert.equal(contract.paragraphStructure.length, lines.length)
  })
  await check('body tampering is rejected and preview preserves original text', async () => {
    const changed = structuredClone(contract); changed.paragraphStructure[0].content = '伪造的另一份合同内容'
    assert.equal((await post('/api/contracts/risk-audit', { contract: changed })).status, 409)
    const response = await post('/api/contracts/preview-segments', { contract })
    assert.equal(response.status, 200)
    const preview = await response.json()
    const flattened = JSON.stringify(preview.sections)
    for (const line of lines) assert.ok(flattened.includes(line))
    assert.doesNotMatch(preview.provider, /^DeepSeek$/)
  })
  await check('risk and match APIs persist run IDs and default cloud consent is false', async () => {
    audit = (await (await post('/api/contracts/risk-audit', { contract })).json()).audit
    match = (await (await post('/api/contracts/standard-clause-match', { contract })).json()).match
    assert.equal(audit.analysisRunId.length, 36); assert.equal(match.analysisRunId.length, 36)
    assert.equal(audit.engine.stages.cloud.status, 'not_requested'); assert.equal(match.engine.stages.cloud.status, 'not_requested')
    assert.doesNotMatch(audit.engine.provider, /Qwen|DeepSeek/)
  })
  await check('export ignores forged result body and rejects another result kind', async () => {
    const response = await post('/api/contracts/risk-audit/export', { contract, audit: { ...audit, risks: [{ title: '伪造审核结论', evidence: '伪造原文', level: '低' }] } })
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/)
    const text = (await mammoth.extractRawText({ buffer: Buffer.from(await response.arrayBuffer()) })).value
    assert.doesNotMatch(text, /伪造审核结论|伪造原文/); assert.match(text, /全部损失/)
    assert.equal((await post('/api/contracts/risk-audit/export', { contract, audit: match })).status, 409)
  })
  await check('report API reuses both exact runs and each format downloads', async () => {
    const response = await post('/api/report-management/prepare', { contract, auditRunId: audit.analysisRunId, matchRunId: match.analysisRunId })
    assert.equal(response.status, 201); report = (await response.json()).report
    assert.deepEqual(report.snapshot.audit, audit); assert.deepEqual(report.snapshot.match, match)
    for (const format of ['word', 'pdf', 'html']) {
      const response = await fetch(api + '/api/report-management/' + report.id + '/export?format=' + format)
      assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/)
      assert.ok((await response.arrayBuffer()).byteLength > 1000)
    }
    const backup = await fetch(api + '/api/operations/backup'); assert.equal(backup.status, 200)
    assert.ok((await backup.text()).includes('contract_analysis_runs'))
  })
  await check('report list API reads large snapshots through Vite without HTTP 500', async () => {
    const snapshot = { ...report.snapshot, regressionPadding: '模拟条款，仅供排序回归。'.repeat(24000) }
    await connection.execute('UPDATE managed_reports SET report_json = ? WHERE id = ?', [JSON.stringify(snapshot), report.id])
    for (let i = 0; i < 3; i++) {
      const response = await fetch(ui + '/api/report-management')
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.deepEqual(payload.reports.find((item) => item.id === report.id).snapshot, snapshot)
      assert.ok(payload.versions.length > 0)
    }
  })
  const require = createRequire(import.meta.url)
  const playwrightPath = process.env.PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
  const { chromium } = require(playwrightPath)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.goto(ui)
  await check('repeated report-module navigation renders large saved reports without read errors', async () => {
    for (let i = 0; i < 3; i++) {
      const loaded = page.waitForResponse((response) => response.url().endsWith('/api/report-management'))
      await page.getByRole('button', { name: '审核报告生成', exact: true }).click()
      assert.equal((await loaded).status(), 200)
      await page.locator('.recent-reports').getByText(report.sourceFile, { exact: true }).waitFor()
      assert.equal(await page.getByText(/报告记录读取失败/).count(), 0)
      await page.getByRole('button', { name: '合同智能解析', exact: true }).click()
    }
  })
  await check('browser failure clears old/demo state and disables all downstream actions', async () => {
    await page.route('**/api/contracts/parse', (route) => route.abort('connectionrefused'))
    await page.locator('input[type=file]').first().setInputFiles({ name: '失败的脱敏合同.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: word })
    await page.getByText(/无法连接|不可用|连接失败/).first().waitFor()
    assert.equal(await page.getByRole('button', { name: '导出 JSON', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '风险审核预警', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '开始风险审核', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '标准条款比对', exact: true }).first().click()
    assert.equal(await page.getByRole('button', { name: '开始匹配', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '审核报告生成', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '生成统一审核报告', exact: true }).isDisabled(), true)
    await page.unroute('**/api/contracts/parse')
    await page.screenshot({ path: path.join(directory, 'browser-failed-contract.png'), fullPage: true })
  })
  await check('browser upload, JSON download, risk/match and report preserve one contract and both runs', async () => {
    await page.getByRole('button', { name: '合同智能解析', exact: true }).click()
    const parsedResponse = page.waitForResponse((response) => response.url().endsWith('/api/contracts/parse') && response.status() === 200)
    await page.locator('input[type=file]').first().setInputFiles({ name: '浏览器脱敏合同.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: word })
    const browserContract = (await (await parsedResponse).json()).parsed
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
    const download = await downloadPromise
    await download.saveAs(path.join(directory, 'browser-contract.json'))
    const exported = JSON.parse((await fs.readFile(path.join(directory, 'browser-contract.json'), 'utf8')).replace(/^\uFEFF/, ''))
    assert.equal(exported.parseSnapshotId, browserContract.parseSnapshotId)
    await page.getByRole('button', { name: '风险审核预警', exact: true }).click()
    assert.equal(await page.locator('.risk-actions input[type=checkbox]').isChecked(), false)
    const auditResponse = page.waitForResponse((response) => response.url().endsWith('/api/contracts/risk-audit') && response.status() === 200)
    await page.getByRole('button', { name: '开始风险审核', exact: true }).click()
    const browserAudit = (await (await auditResponse).json()).audit
    await page.getByRole('button', { name: '标准条款比对', exact: true }).first().click()
    assert.equal(await page.locator('.match-actions input[type=checkbox]').isChecked(), false)
    const matchResponse = page.waitForResponse((response) => response.url().endsWith('/api/contracts/standard-clause-match') && response.status() === 200)
    await page.getByRole('button', { name: '开始匹配', exact: true }).click()
    const browserMatch = (await (await matchResponse).json()).match
    await page.getByRole('button', { name: '审核报告生成', exact: true }).click()
    const reportResponse = page.waitForResponse((response) => response.url().endsWith('/api/report-management/prepare') && response.status() === 201)
    await page.getByRole('button', { name: '生成统一审核报告', exact: true }).click()
    const browserReport = (await (await reportResponse).json()).report
    assert.deepEqual(browserReport.snapshot.audit, browserAudit); assert.deepEqual(browserReport.snapshot.match, browserMatch)
    assert.equal(browserReport.snapshot.contract.parseSnapshotId, browserContract.parseSnapshotId)
    await page.getByText(/统一审核报告已生成/).waitFor()
    await page.screenshot({ path: path.join(directory, 'browser-report.png'), fullPage: true })
    assert.deepEqual(browserErrors, [])
  })
  await check('history browser pagination, selection clearing, deletion cancel and contract cascade', async () => {
    for(let i=0;i<45;i++)await connection.execute('INSERT INTO operation_records (id,operation_type,payload_json,created_at) VALUES (UUID(),?,?,NOW(3))',['history_ui_test',JSON.stringify({sourceFile:'分页模拟'+i+'.pdf'})])
    await page.getByRole('button',{name:'历史操作记录',exact:true}).click()
    await page.locator('.operation-row').first().waitFor()
    await page.locator('.row-check input').first().check()
    await page.getByRole('button',{name:'下一页',exact:true}).click()
    await page.getByText('已选择本页 0 条',{exact:true}).waitFor()
    await page.getByRole('button',{name:'上一页',exact:true}).waitFor()
    const search=page.getByPlaceholder('检索全部记录的文件名或内容')
    await search.fill('分页模拟0.pdf')
    await page.waitForFunction(()=>document.querySelectorAll('.operation-row').length===1 && document.querySelector('.operation-file strong')?.textContent==='分页模拟0.pdf')
    page.once('dialog',dialog=>dialog.dismiss())
    await page.locator('.operation-row .delete-button').click()
    await page.waitForFunction(()=>!document.querySelector('.operation-row .delete-button')?.disabled)
    assert.equal(await page.locator('.operation-row').count(),1)
    page.once('dialog',dialog=>dialog.accept())
    const deleted=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith('/api/operations'))
    await page.locator('.operation-row .delete-button').click();assert.equal((await deleted).status(),200)
    await page.getByText('没有符合当前条件的操作记录。',{exact:true}).waitFor()
    await search.fill('浏览器脱敏合同.docx')
    await page.locator('.operation-row').first().waitFor()
    await page.locator('.operation-row').first().getByTitle('展开详情',{exact:true}).click()
    const confirm=async dialog=>{await dialog.accept(dialog.type()==='prompt'?'浏览器脱敏合同.docx':undefined)}
    page.on('dialog',confirm)
    const purged=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith('/api/operations'))
    await page.getByRole('button',{name:'预览删除该合同业务数据',exact:true}).click()
    assert.equal((await purged).status(),200)
    page.off('dialog',confirm)
    const [snapshots]=await connection.query("SELECT COUNT(*) n FROM contract_parse_snapshots WHERE source_file='浏览器脱敏合同.docx'")
    assert.equal(snapshots[0].n,0)
    await page.getByRole('button',{name:'风险审核预警',exact:true}).click()
    assert.equal(await page.getByRole('button',{name:'开始风险审核',exact:true}).isDisabled(),true)
    assert.deepEqual(browserErrors,[])
  })
  await fs.writeFile(path.join(directory, 'http-browser-results.json'), JSON.stringify({ passed: results.length, results, browser: 'headless Microsoft Edge', cloudCalls: 0, testDatabaseRemovedAfterRun: true }, null, 2), 'utf8')
  console.log(JSON.stringify({ passed: results.length, browserErrors }))
} finally {
  if (browser) await browser.close()
  await Promise.all(children.map((child) => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill() })))
  if (connection) await connection.end()
  if (created) await admin.query('DROP DATABASE ' + quoted)
  await admin.end()
}
