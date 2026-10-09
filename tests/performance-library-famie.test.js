import test from 'node:test'
import assert from 'node:assert/strict'
import { templateFamily } from '../backend/services/template-corpus.js'
import { extendedStandardClauses, extendedPatternRules, contractProfiles } from '../backend/services/enhanced-contract-library.js'
import { matchClause, mergeModelReview } from '../backend/services/standard-clause-service.js'
import { runRuleAudit } from '../backend/services/risk-audit-service.js'
import { planLocalReview } from '../backend/services/local-review-plan.js'
import { reviewCandidates } from '../backend/services/model-review-protocol.js'
import { getFamieStatus } from '../backend/services/famie-service.js'
const contract = (file, lines) => ({ sourceFile: file, paragraphStructure: lines.map((content, i) => ({ index: i + 1, content })) })

test('short template headings cannot create proof without a verifiable source span', () => {
  const def = { code: 'notice', keywords: ['通知'], requirements: ['通知'], applicableTypes: [] }
  const headingOnly = matchClause(def, contract('模拟合同.docx', ['通知']))
  assert.equal(headingOnly.requirementEvidence.length, 0)
  const withText = matchClause(def, contract('模拟合同.docx', ['通知', '双方应以书面通知方式告知地址变更。']))
  assert.ok(withText.requirementEvidence.length > 0)
  assert.ok(withText.requirementEvidence.every((span) => span.quote && span.paragraphIndex === 2))
})

test('template families preserve substantive edition distinctions', () => {
  assert.notEqual(templateFamily('商品房合同（预售）.doc'), templateFamily('商品房合同（现售）.pdf'))
  assert.notEqual(templateFamily('物业合同（包干制）.doc'), templateFamily('物业合同（酬金制）.pdf'))
  assert.equal(templateFamily('数据中介合同 (1).pdf'), templateFamily('数据中介合同.docx'))
})

test('sector rules do not turn a rental contract into data, food or tourism review', () => {
  const c = contract('房屋租赁合同.docx', ['出租人与承租人约定房屋用于居住，租金按月支付。'])
  assert.deepEqual([...contractProfiles(c)], ['rental'])
  const missing = runRuleAudit(c).missingClauses.map((r) => r.ruleId)
  assert.ok(missing.includes('coverage_rental_security'))
  assert.ok(!missing.includes('coverage_data_security'))
  assert.ok(!missing.includes('coverage_food_safety'))
})

test('data obligations need independently verified original evidence and cannot be invented by model', () => {
  const authorization = extendedStandardClauses.find((c) => c.code === 'data_authorization')
  const transfer = matchClause(authorization, contract('数据委托处理合同.docx', ['未经甲方书面同意，乙方不得向未经授权的第三方披露或转让数据。']))
  assert.ok(transfer.presentRequirements.includes('转供限制'))
  const unrelated = matchClause(authorization, contract('数据委托处理合同.docx', ['乙方确保数据处理不侵害任何第三方的知识产权。']))
  assert.ok(!unrelated.presentRequirements.includes('转供限制'))
  const def = extendedStandardClauses.find((c) => c.code === 'data_security')
  const c = contract('数据委托处理合同.docx', ['双方采取数据加密、访问控制等安全措施。', '数据泄露时应立即通知委托方并采取补救措施。', '委托方有权对数据处理活动进行监督审计。'])
  const item = matchClause(def, c)
  assert.equal(item.status, '完整'); assert.equal(item.requirementEvidence.length, 3)
  const incomplete = contract(c.sourceFile, [c.paragraphStructure[0].content])
  const partial = matchClause(def, incomplete)
  assert.equal(partial.status, '部分具备')
  const merged = mergeModelReview([partial], { status: 'success', decisions: [{ candidateId: def.code, status: '完整',
    evidence: [{ paragraphIndex: 1, quote: incomplete.paragraphStructure[0].content }],
    requirementEvidence: [{ label: '事件处置', paragraphIndex: 1, quote: '发生泄露时通知委托方。' }] }] }, incomplete, [def])
  assert.equal(merged.items[0].status, '部分具备')
})

test('food and rental requirements recognize actionable obligations', () => {
  for (const [code, file, lines] of [
    ['food_safety', '学校供餐合同.docx', ['乙方持食品经营许可证，人员持有效健康证明。', '建立进货查验与采购台账追溯机制。', '食品应留样并落实清洁消毒制度。', '发生食品安全事故须立即报告并启动应急处置。']],
    ['rental_security', '房屋租赁合同.docx', ['押金为一个月租金，期满返还余额，损失凭证核实后扣除。', '承租人承担水费、电费，出租人承担物业费。']]
  ]) assert.equal(matchClause(extendedStandardClauses.find((d) => d.code === code), contract(file, lines)).status, '完整', code)
})

test('all twelve new risk patterns detect the designated adverse clause and respect preceding prohibition', () => {
  const cases = [
    ['personal_injury_exemption', '普通合同', '发生人身伤害，甲方概不负责。'],
    ['blanket_no_refund', '体育健身服务合同', '会员充值费用一律不退。'],
    ['forced_consumer_waiver', '培训服务合同', '消费者不得申请退款。'],
    ['data_unrestricted_use', '数据提供合同', '乙方对数据享有永久使用权限。'],
    ['data_retention_after_end', '数据提供合同', '合同终止后乙方有权永久保留全部数据。'],
    ['silent_acceptance', '普通合同', '甲方未回复即视为验收合格。'],
    ['payment_third_party_dependency', '普通合同', '甲方收到业主回款后才支付费用。'],
    ['deposit_forfeiture', '房屋租赁合同', '租赁押金一律不退。'],
    ['unapproved_subcontract', '工程施工合同', '乙方有权全部转包本工程。'],
    ['travel_forced_shopping', '旅游合同', '游客必须参加自费项目。'],
    ['vehicle_hidden_history', '二手车买卖合同', '车辆事故情况无需披露。'],
    ['broker_unearned_fee', '中介合同', '未成交仍支付全额佣金。']
  ]
  assert.equal(cases.length, extendedPatternRules.length)
  for (const [id, file, text] of cases) {
    const rule = extendedPatternRules.find((r) => r.id === id)
    const positive = runRuleAudit(contract(file, [text]), [rule])
    assert.equal(positive.risks.length, 1, id)
    assert.ok(positive.risks[0].evidenceSpans.length)
    assert.equal(runRuleAudit(contract(file, ['禁止约定：' + text]), [rule]).risks.length, 0, id + ' negation')
  }
})

test('focused model plan includes late evidence, cuts irrelevant work and reports scope honestly', async () => {
  const c = contract('模拟合同', Array.from({ length: 300 }, (_, i) => i === 299 ? '乙方承担一切责任并赔偿全部损失。' : '双方按约定履行日常服务并保留履约记录。'))
  const candidate = runRuleAudit(c).risks.find((r) => r.ruleId === 'unlimited_liability')
  const plan = planLocalReview(c, [candidate])
  assert.equal(plan.jobs.length, 1)
  assert.ok(plan.jobs[0].chunk.some((p) => p.paragraphIndex === 300))
  let calls = 0
  const result = await reviewCandidates({ contract: c, candidates: [candidate], kind: 'risk', plan,
    request: async () => { calls++; return { decisions: [] } } })
  assert.equal(calls, 1); assert.equal(result.coverage.scope, 'candidate_evidence')
  assert.equal(result.coverage.complete, false); assert.equal(result.coverage.plannedComplete, true)
})

test('FAMIE readiness rejects unrelated pages, 404 and malformed health bodies', async () => {
  for (const response of [new Response('OK'), new Response('missing', { status: 404 }), Response.json({ service: 'other', status: 'ready' })]) {
    assert.equal((await getFamieStatus({ fetchImpl: async () => response })).ready, false)
  }
  assert.equal((await getFamieStatus({ fetchImpl: async () => Response.json({ service: 'famie', status: 'ready' }) })).ready, true)
})
