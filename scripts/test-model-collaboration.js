import 'dotenv/config'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'
import { Document, Packer, Paragraph } from 'docx'
import { apiRuntimeArguments } from './api-runtime.js'

// Explicit opt-in: this test sends only synthetic contract text to the configured DeepSeek API.
if (!process.argv.includes('--allow-cloud')) throw Error('Live DeepSeek testing requires --allow-cloud')
const database = 'contract_models_test_' + Date.now()
assert.match(database, /^contract_models_test_\d+$/)
const quoted = '`' + database + '`'
const config = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', charset: 'utf8mb4' }
const freePort = () => new Promise((resolve, reject) => {
  const reservation = net.createServer(); reservation.once('error', reject)
  reservation.listen(0, '127.0.0.1', () => { const port = reservation.address().port; reservation.close(() => resolve(port)) })
})
const port = await freePort(), api = 'http://127.0.0.1:' + port
const admin = await mysql.createConnection(config)
const receipt = { checkedAt: new Date().toISOString(), database, cloudExplicitlyAuthorized: true, results: [], cleanedUp: false }
let created = false, child, db
const check = async (name, run) => {
  const start = Date.now(); const details = await run()
  const entry = { name, passed: true, elapsedMs: Date.now() - start, ...details }
  receipt.results.push(entry); console.log(JSON.stringify(entry))
}
const post = async (route, body) => {
  const response = await fetch(api + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(480000) })
  const payload = await response.json()
  assert.ok(response.ok, route + ': HTTP ' + response.status + ' ' + (payload.code || payload.message || ''))
  return payload
}
try {
  await admin.query('CREATE DATABASE ' + quoted + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  process.env.DB_NAME = database
  process.env.DEEPSEEK_API_DISABLED = 'false'
  db = await import('../backend/db.js')
  child = spawn(process.execPath, apiRuntimeArguments(), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DB_NAME: database, PORT: String(port), HOST: '127.0.0.1', DEEPSEEK_API_DISABLED: 'false' } })
  let diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { diagnostics = (diagnostics + data).slice(-3000) })
  const deadline = Date.now() + 30000
  while (true) {
    if (child.exitCode !== null) throw Error('Isolated API exited: ' + diagnostics)
    try { if ((await fetch(api + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
    if (Date.now() > deadline) throw Error('Isolated API readiness timeout')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await check('new generation and dedicated embedding identities are ready', async () => {
    const health = await (await fetch(api + '/api/health')).json()
    assert.equal(health.localModel.state, 'ready'); assert.equal(health.localModel.model, 'Qwen3-8B-Q4_K_M')
    assert.equal(health.embeddingModel.state, 'ready'); assert.equal(health.embeddingModel.dimensions, 1024)
    return { generation: health.localModel.model, embeddings: health.embeddingModel.model }
  })
  const lines = [
    '模拟软件服务外包合同，仅用于系统测试。',
    '甲方：模拟甲科技有限公司；乙方：模拟乙服务有限公司。统一社会信用代码仅为测试占位，联系地址为模拟路一号，联系电话为测试号码。',
    '乙方向甲方提供系统软件维护服务，服务范围包括日常巡检和故障修复，数量为一套，质量标准为系统正常运行。',
    '合同含税总价人民币12345元。付款方式为银行转账，甲方在验收后十五个工作日向乙方账户付款；乙方开具发票，逾期付款按约承担违约责任。',
    '本合同签署日期为2026年9月16日，生效日期为2026年9月16日，履行期限至2027年9月15日，期满终止。',
    '乙方交付软件成果，具体的验收安排另行协商。',
    '甲方有权监督服务，义务是按期付款；乙方有权收取费用，义务是按约服务并配合甲方检查。',
    '保密信息范围包括商业秘密，保密期限为三年，限履约使用；公开信息除外，泄露方承担违约责任。',
    '变更须双方书面同意；违约未整改时，双方均有解除权，解除应提前书面通知并结算费用。',
    '违约责任：乙方承担一切责任并赔偿甲方全部损失。',
    '不可抗力发生后五日内通知对方并提供证明，按影响减免责任，协商后续履行。',
    '争议先协商十五日，协商不成向甲方所在地有管辖权的人民法院提起诉讼。',
    '通知以书面快递送达上述联系地址，签收即视为送达；联系方式变更应通知对方。'
  ]
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: lines.map((line) => new Paragraph(line)) }] }))
  let contract, audit, match, assistant
  await check('real DeepSeek parses synthetic Word into a persisted contract', async () => {
    const form = new FormData(); form.append('contract', new Blob([buffer]), '模型协作模拟合同.docx')
    const response = await fetch(api + '/api/contracts/parse', { method: 'POST', body: form, signal: AbortSignal.timeout(180000) })
    assert.equal(response.status, 200); contract = (await response.json()).parsed
    assert.equal(contract.ai.used, true); assert.equal(contract.ai.status, 'success'); assert.equal(contract.ai.coverage.complete, true)
    assert.equal(contract.paragraphStructure.length, lines.length); assert.equal(contract.parseSnapshotId.length, 36)
    return { provider: contract.ai.provider, coverage: contract.ai.coverage }
  })
  await check('rules then real Qwen then authorized DeepSeek preserve evidenced risk', async () => {
    audit = (await post('/api/contracts/risk-audit', { contract, allowCloudReview: true })).audit
    assert.equal(audit.engine.stages.local.status, 'success'); assert.equal(audit.engine.stages.cloud.status, 'success')
    assert.ok(audit.engine.stages.local.acceptedDecisions > 0); assert.ok(audit.engine.stages.cloud.acceptedDecisions > 0)
    assert.match(audit.engine.provider, /Qwen3-8B.*DeepSeek/)
    assert.ok(audit.risks.some((item) => item.ruleId === 'unlimited_liability'))
    assert.ok(audit.risks.some((item) => item.evidenceSpans?.some((span) => lines.some((line) => line.includes(span.quote)))))
    return { engine: audit.engine }
  })
  await check('real local/cloud standard review cannot invent acceptance terms', async () => {
    match = (await post('/api/contracts/standard-clause-match', { contract, allowCloudReview: true })).match
    assert.equal(match.engine.stages.local.status, 'success'); assert.equal(match.engine.stages.cloud.status, 'success')
    assert.ok(match.engine.stages.local.acceptedDecisions > 0); assert.ok(match.engine.stages.cloud.acceptedDecisions > 0)
    assert.match(match.engine.provider, /Qwen3-8B.*DeepSeek/)
    assert.notEqual(match.items.find((item) => item.code === 'delivery_acceptance').status, '完整')
    return { engine: match.engine, acceptanceStatus: match.items.find((item) => item.code === 'delivery_acceptance').status }
  })
  await check('real 1024-dimensional retrieval, Qwen draft and DeepSeek polish return verified citations', async () => {
    assistant = (await post('/api/assistant/chat', { contract, question: '请引用原文说明乙方承担一切责任的风险，并简要建议怎样限制责任。', allowWebSearch: false })).reply
    assert.equal(assistant.engine.status, 'cloud_polished'); assert.match(assistant.engine.provider, /Qwen3-8B.*DeepSeek/)
    assert.equal(assistant.engine.stages.local.status, 'success'); assert.equal(assistant.engine.stages.cloud.receivedLocalDraft, true)
    assert.equal(assistant.retrieval.semantic.status, 'ready'); assert.equal(assistant.citationStatus, 'source_ids_verified')
    assert.ok(assistant.citations.some((source) => source.type === 'contract'))
    assert.equal(assistant.retrieval.web.requested, false)
    const [[row]] = await db.pool.query('SELECT COUNT(*) AS count FROM semantic_vector_index WHERE embedding_dimension = 1024')
    assert.ok(Number(row.count) > 0)
    return { engine: assistant.engine, retrieval: assistant.retrieval, verifiedCitations: assistant.citations.length, vectors: Number(row.count) }
  })
  await check('report snapshot preserves both real model runs and formal Word export', async () => {
    const report = (await post('/api/report-management/prepare', { contract, auditRunId: audit.analysisRunId, matchRunId: match.analysisRunId })).report
    assert.equal(report.snapshot.audit.analysisRunId, audit.analysisRunId); assert.equal(report.snapshot.match.analysisRunId, match.analysisRunId)
    const response = await fetch(api + '/api/report-management/' + report.id + '/export?format=word')
    assert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.subarray(0, 2).toString(), 'PK')
    return { wordBytes: bytes.length }
  })
  await check('live local answer survives classified cloud failure and default-off review stays offline', async () => {
    const { answerContractQuestion } = await import('../backend/services/contract-assistant-service.js')
    const reply = await answerContractQuestion({ contract, question: '请简短指出乙方无限责任的原文，并建议责任上限。',
      dependencies: { cloudAsk: async () => ({ errorStatus: 'provider_unavailable' }) } })
    assert.equal(reply.engine.status, 'local_fallback'); assert.equal(reply.engine.stages.local.status, 'success')
    assert.equal(reply.engine.stages.cloud.status, 'provider_unavailable'); assert.ok(reply.citations.length > 0)
    const { auditContractRisk } = await import('../backend/services/risk-audit-service.js')
    let cloudCalls = 0
    const offline = await auditContractRisk(contract, { dependencies: { localReview: async () => ({ status: 'unavailable', decisions: [] }),
      cloudReview: async () => { cloudCalls++; throw Error('Cloud must not be called without per-request consent') } } })
    assert.equal(cloudCalls, 0)
    assert.equal(offline.engine.stages.cloud.status, 'not_requested'); assert.ok(offline.risks.length > 0)
    return { fallback: reply.engine.status, cloudFailure: reply.engine.stages.cloud.status, ruleFallback: offline.engine.status }
  })
  await check('MySQL history records consent and stages but not assistant question/answer bodies', async () => {
    const [rows] = await db.pool.query("SELECT operation_type, payload_json FROM operation_records WHERE operation_type IN ('contract_assistant_chat','contract_risk_audit','standard_clause_match')")
    assert.ok(rows.length >= 3)
    const assistantRows = rows.filter((row) => row.operation_type === 'contract_assistant_chat')
    assert.ok(assistantRows.length)
    for (const row of assistantRows) {
      const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
      assert.equal(payload.engine.stages.cloud.receivedLocalDraft, true)
      assert.equal(payload.question, undefined); assert.equal(payload.answer, undefined)
      assert.equal(payload.retrieval.web.requested, false)
    }
    for (const row of rows.filter((row) => row.operation_type !== 'contract_assistant_chat')) {
      const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
      assert.equal(payload.cloudReviewRequested, true)
    }
    return { records: rows.length }
  })
} catch (error) {
  receipt.failure = { code: error.code || 'test_failed', message: error.message }
  console.error('FAIL live model collaboration:', error.message); process.exitCode = 1
} finally {
  if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
  await db?.pool.end()
  try {
    if (created) { await admin.query('DROP DATABASE ' + quoted); receipt.cleanedUp = true }
  } finally {
    await admin.end()
    await fs.mkdir('tmp/model-upgrade', { recursive: true })
    await fs.writeFile('tmp/model-upgrade/live-collaboration.json', JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  }
}
