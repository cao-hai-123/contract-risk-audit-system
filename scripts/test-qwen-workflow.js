import 'dotenv/config'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { analyzeContract } from '../backend/services/contract-analysis-service.js'
import { auditContractRisk } from '../backend/services/risk-audit-service.js'
import { matchStandardClauses } from '../backend/services/standard-clause-service.js'
import { answerContractQuestion } from '../backend/services/contract-assistant-service.js'
import { prepareManagedReport } from '../backend/services/report-management-service.js'
import { saveParseSnapshot, saveAnalysisRun } from '../backend/services/contract-integrity-service.js'
import { getLocalInferenceDiagnostics } from '../backend/services/local-inference-transport.js'
import { pool } from '../backend/db.js'

const text = '服务外包合同。甲方为模拟甲公司，乙方为模拟乙公司。双方于2026年9月1日签订合同。服务总价为10000元，甲方应在收到发票后10日内支付。乙方承担一切责任并赔偿甲方全部损失。服务履行期限为2026年9月1日至2026年12月31日。争议由双方协商，协商不成向甲方所在地人民法院起诉。'
const receipt = { checkedAt: new Date().toISOString(), stages: {} }
let contract, report
async function measure(name, action) { const start = Date.now(); const result = await action(); receipt.stages[name] = { elapsedMs: Date.now() - start, ...(result.ai || result.engine || {}) }; console.log(name, JSON.stringify(receipt.stages[name])); return result }
try {
  contract = await saveParseSnapshot(await measure('parse', () => analyzeContract({ text, fileName: '模拟-Qwen验收-' + randomUUID() + '.docx', parserResult: { text, paragraphs: [{ index: 1, content: text }], ocr: { required: false }, warnings: [], coverage: { complete: true } } })))
  assert.equal(contract.ai.stages.local.used, true)
  const audit = await saveAnalysisRun(contract, 'risk', await measure('risk', () => auditContractRisk(contract)))
  assert.ok(audit.engine.stages.local.completedRequests > 0)
  assert.ok(['success', 'no_verifiable_decisions'].includes(audit.engine.stages.local.status))
  const match = await saveAnalysisRun(contract, 'standard', await measure('standard', () => matchStandardClauses(contract)))
  assert.ok(match.engine.stages.local.completedRequests > 0)
  assert.ok(['success', 'no_verifiable_decisions'].includes(match.engine.stages.local.status))
  const answer = await measure('assistant', () => answerContractQuestion({ question: '乙方承担的赔偿责任有什么问题？请引用原文。', contract }))
  assert.equal(answer.engine.stages.local.status, 'success')
  const before = JSON.stringify(getLocalInferenceDiagnostics())
  report = await prepareManagedReport(contract, { auditRunId: audit.analysisRunId, matchRunId: match.analysisRunId })
  assert.equal(report.report.snapshot.audit.engine.stages.local.completedRequests, audit.engine.stages.local.completedRequests)
  assert.equal(report.report.snapshot.match.engine.stages.local.completedRequests, match.engine.stages.local.completedRequests)
  assert.equal(JSON.stringify(getLocalInferenceDiagnostics()), before)
  receipt.stages.report = { status: 'passed', reusedVerifiedAnalysis: true }
  receipt.inference = getLocalInferenceDiagnostics()
  receipt.status = 'passed'
} catch (error) {
  receipt.status = 'failed'; receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1
} finally {
  // Delete only this run's uniquely identified simulated fixtures, never user records.
  if (report) { await pool.execute('DELETE FROM managed_reports WHERE id = ?', [report.report.id]); await pool.execute('DELETE FROM contract_versions WHERE id = ?', [report.version.id]) }
  if (contract) { await pool.execute('DELETE FROM contract_analysis_runs WHERE parse_snapshot_id = ?', [contract.parseSnapshotId]); await pool.execute('DELETE FROM contract_parse_snapshots WHERE id = ?', [contract.parseSnapshotId]) }
  await pool.end()
  await fs.mkdir('tmp/qwen-validation', { recursive: true })
  await fs.writeFile('tmp/qwen-validation/workflow.json', JSON.stringify(receipt, null, 2))
  console.log('workflow', receipt.status)
}
