import 'dotenv/config'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { reviewCandidates, requestJson } from '../backend/services/model-review-protocol.js'
import { planLocalReview } from '../backend/services/local-review-plan.js'
import { getLocalModelConfig, probeGenerationModel } from '../backend/services/local-model-config.js'
import { runRuleAudit, mergeAiReview } from '../backend/services/risk-audit-service.js'
const config = getLocalModelConfig()
assert.equal(await probeGenerationModel(config), 'ready')
const lines = Array.from({ length: 48 }, (_, i) => `服务记录${i + 1}：双方按约开展常规巡检，记录设备运行状态、处理进度和联络情况，并保存服务记录以供后续核对。`)
lines.push('乙方承担一切责任并赔偿甲方全部损失。')
const contract = { sourceFile: '模拟性能验收合同.docx', paragraphStructure: lines.map((content, i) => ({ index: i + 1, content })) }
const audit = runRuleAudit(contract), candidate = audit.risks.find((r) => r.ruleId === 'unlimited_liability')
assert.ok(candidate)
const receipt = { checkedAt: new Date().toISOString(), model: config.model, threads: config.threads, batchThreads: config.batchThreads, cloudCalls: 0, results: [] }
for (const mode of ['full_cross_product', 'candidate_evidence']) {
  let requests = 0
  const start = Date.now()
  const review = await reviewCandidates({ contract, candidates: [candidate], kind: 'risk', timeBudgetMs: 300000, requestTimeoutMs: 120000,
    ...(mode === 'candidate_evidence' ? { plan: planLocalReview(contract, [candidate]) } : {}),
    request: (input) => { requests++; return requestJson({ ...input, jsonSchema: input.outputSchema,
      endpoint: config.baseUrl + '/v1/chat/completions', model: config.model, maxTokens: 900,
      system: '只复核给定候选。逐字引用证据；retain表示风险成立，reject表示候选是误报。仅输出 JSON。/no_think' }) } })
  const merged = mergeAiReview(review, { ...audit, risks: [candidate], missingClauses: [] }, contract)
  assert.equal(review.status, 'success')
  assert.ok(merged.stage.acceptedDecisions >= 1, mode + ': exact risk evidence required')
  assert.equal(merged.audit.risks.length, 1)
  receipt.results.push({ mode, elapsedMs: Date.now() - start, requests, acceptedDecisions: merged.stage.acceptedDecisions, coverage: review.coverage })
  console.log(JSON.stringify(receipt.results.at(-1)))
}
assert.ok(receipt.results[1].requests < receipt.results[0].requests)
receipt.speedup = Number((receipt.results[0].elapsedMs / receipt.results[1].elapsedMs).toFixed(2))
receipt.faster = receipt.speedup > 1
await fs.mkdir('tmp/performance-library-famie', { recursive: true })
await fs.writeFile('tmp/performance-library-famie/review-performance.json', JSON.stringify(receipt, null, 2) + '\n')
assert.ok(receipt.faster, 'Optimized real review must be faster for this controlled workload')
