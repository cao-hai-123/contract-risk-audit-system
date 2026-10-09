import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { createServer } from 'vite'
import { createApiProxy } from '../scripts/dev-proxy.js'
import { getLocalModelConfig, generationArguments, probeGenerationModel } from '../backend/services/local-model-config.js'
import { analyzeContractWithDeepSeek } from '../backend/services/deepseek-client.js'
import { splitParagraphs, requestJson, candidateReviewSchema } from '../backend/services/model-review-protocol.js'
import { matchClause, mergeModelReview } from '../backend/services/standard-clause-service.js'

test('payment after acceptance and maintenance repairs cannot become acceptance requirements, even via model quotes', () => {
  const contract = { paragraphStructure: [
    { index: 1, content: '乙方交付软件成果，具体的验收安排另行协商。' },
    { index: 2, content: '甲方在验收后十五个工作日向乙方账户付款。' },
    { index: 3, content: '服务范围包括日常巡检和故障修复，质量标准为系统正常运行。' }
  ] }
  const clause = { code: 'delivery_acceptance', keywords: ['交付', '验收', '成果', '质量标准', '整改'], requirements: ['交付物', '验收标准', '验收期限', '不合格处理'] }
  const item = matchClause(clause, contract)
  assert.equal(item.status, '部分具备')
  assert.deepEqual(item.missingRequirements, ['验收标准', '验收期限', '不合格处理'])
  const result = mergeModelReview([item], { status: 'success', decisions: [{ candidateId: clause.code, decision: 'retain', status: '完整',
    evidence: [{ paragraphIndex: 1, quote: contract.paragraphStructure[0].content }],
    requirementEvidence: [
      { label: '验收标准', paragraphIndex: 2, quote: contract.paragraphStructure[1].content },
      { label: '验收期限', paragraphIndex: 2, quote: contract.paragraphStructure[1].content },
      { label: '不合格处理', paragraphIndex: 3, quote: contract.paragraphStructure[2].content }
    ] }] }, contract, [clause])
  assert.equal(result.items[0].status, '部分具备')
  assert.deepEqual(result.items[0].missingRequirements, item.missingRequirements)
})

test('local schema constrains root decisions while plain cloud JSON mode stays unchanged', async () => {
  const bodies = []
  const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{"decisions":[]}' } }] })) }
  await requestJson({ endpoint: 'http://127.0.0.1/local-test', prompt: 'synthetic', jsonSchema: candidateReviewSchema('standard'), fetchImpl })
  await requestJson({ endpoint: 'https://synthetic.invalid', prompt: 'synthetic', fetchImpl })
  assert.deepEqual(bodies[0].response_format.schema.required, ['decisions'])
  assert.equal(bodies[0].response_format.schema.additionalProperties, false)
  assert.ok(bodies[0].response_format.schema.properties.decisions.items.required.includes('requirementEvidence'))
  assert.deepEqual(bodies[1].response_format, { type: 'json_object' })
})

test('short PDF lines pack into bounded chunks without dropping any paragraph', () => {
  const paragraphs = Array.from({ length: 1299 }, (_, index) => ({ index: index + 1, content: '第' + index + '行：模拟合同的完整原文。' }))
  const chunks = splitParagraphs(paragraphs, 8000, 200)
  assert.equal(chunks.length, 7)
  assert.deepEqual(chunks.flat().map((unit) => unit.text), paragraphs.map((p) => p.content))
  assert.ok(chunks.every((chunk) => chunk.reduce((n, unit) => n + unit.text.length, 0) <= 8000))
})

test('null extraction fields retain valid DeepSeek results but invalid/missing fields remain rejected', async () => {
  const text = '甲方模拟甲公司委托乙方模拟乙公司提供软件维护服务，价款人民币12345元。'
  const parserResult = { text, paragraphs: [{ index: 1, content: text }], warnings: [], ocr: {}, coverage: { complete: true } }
  const output = { contractType: { predicted: '服务外包合同' }, keyElements: {
    parties: '模拟甲公司；模拟乙公司', signedDate: null, amount: '12345元', performancePeriod: null, disputeResolution: null
  } }
  const analyze = (result) => analyzeContractWithDeepSeek({ text, fileName: '模拟合同.docx', parserResult,
    dependencies: { apiKey: 'synthetic', request: async () => structuredClone(result) } })
  const valid = await analyze(output)
  assert.equal(valid.ai.used, true)
  assert.equal(valid.keyElements.signedDate, '未识别')
  assert.equal(valid.keyElements.amount, '12345元')
  for (const value of [{}, ['date'], 123]) {
    assert.equal((await analyze({ ...output, keyElements: { ...output.keyElements, signedDate: value } })).ai.status, 'invalid_output')
  }
  const missing = structuredClone(output); delete missing.keyElements.signedDate
  assert.equal((await analyze(missing)).ai.status, 'invalid_output')
})

test('CPU model defaults reserve memory and disable unneeded generation embeddings', () => {
  const config = getLocalModelConfig({})
  assert.equal(config.model, 'Qwen3-8B-Q4_K_M')
  assert.equal(config.gpuLayers, 0)
  const args = generationArguments(config)
  assert.equal(args[args.indexOf('-np') + 1], '1')
  assert.equal(args[args.indexOf('--reasoning') + 1], 'off')
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
  assert.ok(!args.includes('--embedding'))
  assert.equal(getLocalModelConfig({ LOCAL_LLM_CONTEXT_SIZE: 'invalid' }).contextSize, 8192)
})

test('a healthy wrong model cannot be reported as the configured model', async () => {
  const config = getLocalModelConfig({})
  const reply = (model) => async (url) => new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : { data: [{ id: model }] }))
  assert.equal(await probeGenerationModel(config, reply('Qwen3-4B-Q4_K_M')), 'model_mismatch')
  assert.equal(await probeGenerationModel(config, reply(config.model)), 'ready')
  assert.equal(await probeGenerationModel(config, async () => { throw Error('offline') }), 'unavailable')
})

test('only actual browser cancellation marks a proxy error as expected', () => {
  const proxy = new EventEmitter()
  createApiProxy('http://127.0.0.1:1').configure(proxy)
  const cancelled = Object.assign(Error('aborted'), { code: 'ECONNABORTED' })
  proxy.emit('error', cancelled, { aborted: true }, { destroyed: true })
  assert.equal(cancelled.contractClientCancelled, true)
  const upstream = Object.assign(Error('reset'), { code: 'ECONNRESET' })
  let status, data
  proxy.emit('error', upstream, {}, { writeHead(code) { status = code }, end(body) { data = JSON.parse(body) } })
  assert.equal(upstream.contractClientCancelled, undefined)
  assert.equal(status, 503)
  assert.equal(data.code, 'api_connection_interrupted')
})

test('real Vite proxy handles multipart concurrency, upstream reset/refusal and later recovery', { timeout: 30000 }, async () => {
  let mode = 'ok', requests = 0
  const upstream = http.createServer((request, response) => {
    requests++
    if (mode === 'reset') { request.socket.destroy(); return }
    let size = 0
    request.on('data', (data) => { size += data.length })
    request.on('end', () => {
      setTimeout(() => { if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ size, multipart: request.headers['content-type']?.startsWith('multipart/form-data; boundary=') })) }, 50)
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const vite = await createServer({ configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0,
    proxy: { '/api': createApiProxy('http://127.0.0.1:' + upstream.address().port) } } })
  try {
    await vite.listen()
    const url = 'http://127.0.0.1:' + vite.httpServer.address().port + '/api/contracts/parse'
    const upload = () => {
      const form = new FormData(); form.append('contract', new Blob([Buffer.alloc(512 * 1024, 65)]), '模拟.docx')
      return fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) })
    }
    for (let batch = 0; batch < 4; batch++) {
      const responses = await Promise.all(Array.from({ length: 4 }, upload))
      for (const response of responses) { assert.equal(response.status, 200); const payload = await response.json(); assert.ok(payload.multipart && payload.size > 512 * 1024) }
    }
    mode = 'reset'
    const before = requests
    const reset = await upload()
    assert.equal(reset.status, 503)
    assert.equal((await reset.json()).code, 'api_connection_interrupted')
    assert.equal(requests, before + 1, 'Uploads must never be automatically replayed')
    mode = 'ok'
    assert.equal((await upload()).status, 200)
    await new Promise((resolve) => upstream.close(resolve))
    const refused = await upload()
    assert.equal(refused.status, 503)
    assert.match((await refused.json()).message, /MySQL/)
  } finally {
    upstream.closeAllConnections()
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve))
    await vite.close()
  }
})
