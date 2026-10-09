import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeContract } from '../backend/services/contract-analysis-service.js'
import { reviewCandidates, reviewEngine, requestJson, classifyModelError } from '../backend/services/model-review-protocol.js'
import { requestLocalJson, getLocalInferenceDiagnostics } from '../backend/services/local-inference-transport.js'

const input = { text: '甲方为模拟甲公司，乙方为模拟乙公司，服务费用为10000元。', fileName: '模拟测试.docx',
  parserResult: { text: '甲方为模拟甲公司，乙方为模拟乙公司，服务费用为10000元。', paragraphs: [{ index: 1, content: '甲方为模拟甲公司，乙方为模拟乙公司，服务费用为10000元。' }], ocr: {}, warnings: [] } }
const extraction = { contractType: { predicted: '服务外包合同', confidence: .8 }, keyElements: { parties: '模拟甲公司、模拟乙公司', signedDate: null, amount: '10000元', performancePeriod: null, disputeResolution: null } }
test('parse runs local extraction, retains local output when cloud fails', async () => {
  let calls = 0
  const result = await analyzeContract(input, { ensureLocal: async () => ({ state: 'ready' }), localRequest: async () => { calls++; return structuredClone(extraction) }, cloudAnalyze: async () => ({ ai: { used: false, status: 'timeout' } }) })
  assert.equal(calls, 1)
  assert.equal(result.ai.stages.local.used, true)
  assert.equal(result.keyElements.amount, '10000元')
  assert.equal(result.ai.stages.cloud.status, 'timeout')
  assert.match(result.ai.provider, /Qwen/)
})
test('parse never claims local participation when disabled', async () => {
  const result = await analyzeContract(input, { ensureLocal: async () => ({ state: 'disabled' }), localRequest: async () => assert.fail('local disabled'), cloudAnalyze: async () => ({ ai: { provider: 'DeepSeek', used: true, status: 'success' } }) })
  assert.equal(result.ai.stages.local.used, false)
  assert.equal(result.ai.provider, 'DeepSeek')
})
test('zero planned jobs is not successful inference; rejected output remains visible as called', async () => {
  const result = await reviewCandidates({ contract: {}, candidates: [{ code: 'a' }], plan: { jobs: [], skipped: ['a'] }, request: async () => assert.fail('no job') })
  assert.equal(result.status, 'no_relevant_evidence')
  const engine = reviewEngine('标准条款库', { status: 'no_verifiable_decisions', coverage: { completedChunks: 1 }, acceptedDecisions: 0 }, null, false)
  assert.equal(engine.stages.local.invoked, true)
  assert.match(engine.notice, /模型已调用/)
  assert.equal(engine.provider, '标准条款库')
})
test('token-truncated JSON is rejected even if syntactically valid', async () => {
  await assert.rejects(requestJson({ endpoint: 'mock', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) }) }), e => classifyModelError(e) === 'output_truncated')
})
test('local callers serialize and queue recovers after a failed request without recording text', async () => {
  let active = 0, peak = 0, calls = 0
  const fetchImpl = async () => {
    active++; peak = Math.max(peak, active); const index = ++calls
    await new Promise(r => setTimeout(r, 10)); active--
    return { ok: true, json: async () => ({ choices: [{ message: { content: index === 1 ? '' : '{"ok":true}' } }] }) }
  }
  const results = await Promise.allSettled([1, 2].map(() => requestLocalJson({ task: 'test', prompt: 'private-test-text', fetchImpl })))
  assert.equal(peak, 1); assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled')
  assert.equal(getLocalInferenceDiagnostics().pending, 0)
  assert.ok(!JSON.stringify(getLocalInferenceDiagnostics()).includes('private-test-text'))
})
