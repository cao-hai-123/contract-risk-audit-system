import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import 'dotenv/config'
import { ensureEmbeddedModelServer, stopEmbeddedModelServer, reviewContractRisksWithEmbeddedModel, reviewStandardClauseMatchWithEmbeddedModel } from '../backend/services/embedded-llm-service.js'
import { runRuleAudit, mergeAiReview } from '../backend/services/risk-audit-service.js'
import { matchClause, mergeModelReview } from '../backend/services/standard-clause-service.js'

process.env.LOCAL_LLM_MODE = 'embedded'
process.env.DEEPSEEK_API_DISABLED = 'true'
const contract = { sourceFile: '本地模型脱敏测试.docx', contractType: { predicted: '服务外包合同' },
  paragraphStructure: [{ index: 1, content: '乙方承担一切责任并赔偿甲方全部损失。' }, { index: 2, content: '乙方向甲方交付软件成果，其他交付要求待双方协商。' }] }
try {
  const state = await ensureEmbeddedModelServer()
  assert.equal(state.state, 'ready', 'Real local model health must succeed')
  assert.equal((await fetch(state.endpoint + '/health')).ok, true)
  console.log('PASS real local Qwen health on ' + state.endpoint)
  const initial = runRuleAudit(contract)
  const candidate = initial.risks.find((item) => item.ruleId === 'unlimited_liability')
  assert.ok(candidate)
  const review = await reviewContractRisksWithEmbeddedModel({ contract, candidateFindings: [candidate] })
  const merged = mergeAiReview(review, { ...initial, risks: [candidate], missingClauses: [] }, contract)
  await fs.mkdir('tmp/priority-repairs', { recursive: true })
  await fs.writeFile('tmp/priority-repairs/local-model-diagnostic.json', JSON.stringify({ review, stage: merged.stage }, null, 2), 'utf8')
  assert.equal(review.status, 'success'); assert.equal(review.coverage.plannedComplete, true); assert.equal(review.coverage.scope, 'candidate_evidence')
  assert.ok(merged.stage.acceptedDecisions >= 1, 'Local output must contain verifiable candidate evidence')
  assert.equal(merged.audit.risks.length, 1)
  console.log('PASS real local risk candidate protocol and original-quote verification')
  const definition = { code: 'delivery_acceptance', title: '交付验收', category: '交付验收', keywords: ['交付', '验收'], requirements: ['交付物', '验收标准', '验收期限', '不合格处理'], suggestion: '明确验收与整改。' }
  const item = matchClause(definition, contract)
  const standardReview = await reviewStandardClauseMatchWithEmbeddedModel({ contract, candidates: [item] })
  const standardMerged = mergeModelReview([item], standardReview, contract, [definition])
  assert.equal(standardReview.status, 'success'); assert.equal(standardReview.coverage.plannedComplete, true); assert.equal(standardReview.coverage.scope, 'candidate_evidence')
  assert.notEqual(standardMerged.items[0].status, '完整', 'No invented completeness for the partial source')
  console.log('PASS real local standard-candidate protocol and no unsupported completeness')
  await fs.mkdir('tmp/priority-repairs', { recursive: true })
  await fs.writeFile('tmp/priority-repairs/local-model-results.json', JSON.stringify({ passed: 3, model: state.model, endpoint: state.endpoint,
    risk: merged.stage, standard: standardMerged.stage, cloudCalls: 0 }, null, 2), 'utf8')
} finally { await stopEmbeddedModelServer() }
