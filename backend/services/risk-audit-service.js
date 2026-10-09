import { assertUsableContract } from '../../shared/contract-content.js'
import { findSourceEvidence, reviewEngine, safeReview } from './model-review-protocol.js'
import { clauseContexts } from './clause-context.js'
import { saveRiskRuleDefinitions, getRiskRuleDefinitions } from '../db.js'
import { reviewContractRisksWithDeepSeek } from './deepseek-client.js'
import { reviewContractRisksWithEmbeddedModel } from './embedded-llm-service.js'
import { extendedPatternRules, extendedMissingRules, extendedStandardClauses, appliesToProfiles, libraryVersion } from './enhanced-contract-library.js'
import { matchClause } from './standard-clause-service.js'
import { getLocalModelProvider } from './local-model-config.js'

export const riskRuleLibrary = [
  rule('unlimited_liability', '责任边界', '无限或兜底责任', '高', /无限责任|承担一切责任|全部损失|任何损失均由.*承担/, '责任范围未设置上限或明确边界。', '建议明确可赔偿损失范围、责任上限及可归责条件。'),
  rule('excessive_liquidated_damages', '违约责任', '违约金约定异常', '高', /违约金.{0,30}(?:[2-9]\d|\d{3,})%|每日.{0,20}(?:[2-9]\d|\d{3,})‰/, '违约金比例或日累计比例可能明显偏高。', '建议结合交易金额、实际损失和违约情形，设置合理违约金上限。'),
  rule('unilateral_termination', '解除权', '单方解除权失衡', '高', /单方解除|有权随时解除|任何时候解除|无需.*同意.*解除/, '一方可能享有缺少对等条件的解除权。', '建议补充双方对等的解除条件、通知期限和善后安排。'),
  rule('unfavorable_jurisdiction', '争议解决', '管辖约定可能不利', '中', /乙方所在地.{0,20}(?:法院|仲裁)|对方所在地.{0,20}(?:法院|仲裁)/, '争议解决地点可能偏向对方所在地。', '建议约定合同履行地、双方可接受地点或中立仲裁机构。'),
  rule('automatic_renewal', '期限管理', '自动续期约定', '中', /自动续期|自动延长|期满后自动/, '合同可能在未再次确认的情况下自动延续。', '建议明确续期确认方式、提前通知期限及退出机制。'),
  rule('rights_transfer', '权利义务', '未经同意转让权利义务', '中', /转让.{0,30}(?:无需|不需|无须).{0,10}同意|有权将.{0,30}转让/, '一方可能可未经同意转让合同权利义务。', '建议约定转让须经对方书面同意，并明确例外情形。'),
  rule('unilateral_change', '变更控制', '单方变更权过宽', '高', /有权单方变更|可自行修改.{0,20}(?:条款|规则|价格)|以通知为准.{0,20}(?:变更|调整)|最终解释权归/, '一方可在缺少协商或退出机制的情况下变更核心权利义务。', '建议明确变更范围、书面通知期限、生效条件以及不同意时的协商或解除机制。'),
  rule('broad_ip_assignment', '知识产权', '知识产权归属过宽', '中', /全部知识产权归.{0,20}所有|无偿转让.{0,30}知识产权|永久不可撤销.{0,30}许可/, '知识产权归属或许可范围可能超出必要履约范围。', '建议区分既有知识产权、项目成果、改进成果与使用许可的范围、期限和费用。'),
  rule('waiver_of_claim', '权利救济', '权利救济放弃或限制', '中', /放弃.{0,20}(?:索赔|追究|诉讼|救济)|不得提出.{0,20}(?:异议|索赔)|最终决定.{0,20}不得异议/, '条款可能不当限制一方提出异议、索赔或救济的权利。', '建议限定放弃的具体事项和期限，保留法定权利及重大违约情形下的救济。'),
  missingRule('missing_confidentiality', '保密义务', '保密条款缺失', '中', ['保密', '秘密信息', '保密义务'], '未发现明确的保密范围、期限或违约责任安排。', '建议补充保密信息定义、使用限制、期限、例外及违约责任。'),
  missingRule('missing_payment_terms', '付款结算', '付款结算条款缺失', '中', ['付款', '支付', '结算', '价款'], '未发现明确的付款节点、方式或结算安排。', '建议明确付款条件、付款节点、发票要求、账户信息及逾期责任。'),
  missingRule('ambiguous_amount', '价款金额', '合同金额不明确', '高', ['人民币', '金额', '价款', '费用'], '未识别到可核验的合同金额或计价依据。', '建议明确含税金额、计价口径、币种及金额调整条件。'),
  missingRule('missing_acceptance', '交付验收', '交付或验收条款缺失', '中', ['验收', '交付', '成果'], '未发现可操作的交付标准或验收机制。', '建议约定交付物、验收标准、验收期限、整改和视为验收条件。'),
  missingRule('missing_performance_period', '履行期限', '履行期限不明确', '中', ['履行期限', '有效期', '起止', '期限'], '未发现明确的履行起止时间或期限安排。', '建议明确生效时间、履行期限、里程碑及延期处理规则。'),
  missingRule('missing_dispute_resolution', '争议解决', '争议解决条款缺失', '中', ['争议', '仲裁', '法院', '管辖'], '未发现争议解决方式或管辖约定。', '建议明确协商期限、诉讼或仲裁方式及适用管辖。'),
  missingRule('missing_force_majeure', '不可抗力', '不可抗力条款缺失', '低', ['不可抗力'], '未发现不可抗力的通知、证明和责任减免安排。', '建议补充不可抗力定义、通知时限、证明材料及后续履行处理。'),
  ...extendedPatternRules, ...extendedMissingRules
]

const clauseDetailRequirements = {
  missing_confidentiality: ['范围', '期限', '例外', '违约', '使用'],
  missing_payment_terms: ['期限', '节点', '发票', '账户', '验收', '逾期'],
  ambiguous_amount: ['含税', '不含税', '总额', '单价', '计价', '元', '万元'],
  missing_acceptance: ['标准', '期限', '整改', '确认', '不合格'],
  missing_performance_period: ['年', '月', '日', '工作日', '届满'],
  missing_dispute_resolution: ['协商', '诉讼', '仲裁委员会', '所在地'],
  missing_force_majeure: ['通知', '证明', '减免', '履行', '期限']
}

export async function syncRiskRuleLibrary() {
  await saveRiskRuleDefinitions(riskRuleLibrary)
  return { version: libraryVersion, count: riskRuleLibrary.length }
}

export async function auditContractRisk(contract, { allowCloudReview = false, dependencies = {} } = {}) {
  assertUsableContract(contract)
  const rules = await (dependencies.loadRules || getRiskRuleDefinitions)()
  if (!rules.length) throw new Error('MySQL 风险规则库为空，请重启服务同步规则基线。')
  let audit = runRuleAudit(contract, rules)
  const localReview = await safeReview(dependencies.localReview || reviewContractRisksWithEmbeddedModel, {
    contract, ruleLibrary: rules, candidateFindings: [...audit.risks, ...audit.missingClauses]
  })
  const local = mergeAiReview(localReview, audit, contract, getLocalModelProvider(), rules)
  audit = local.audit
  let cloud
  if (allowCloudReview) {
    const review = await safeReview(dependencies.cloudReview || reviewContractRisksWithDeepSeek, {
      contract, ruleLibrary: rules, candidateFindings: [...audit.risks, ...audit.missingClauses]
    })
    cloud = mergeAiReview(review, audit, contract, 'DeepSeek', rules)
    audit = cloud.audit
  }
  audit.engine = { ...reviewEngine('增强规则库', local.stage, cloud?.stage, allowCloudReview), offlineMatcher: 'clause_context_evidence_v3' }
  audit.coverage = { complete: true, paragraphs: contract.paragraphStructure.length, characters: getContractText(contract).length }
  return audit
}

export function runRuleAudit(contract, rules = riskRuleLibrary) {
  const source = getContractText(contract)
  const risks = []
  const missingClauses = []

  for (const ruleItem of rules) {
    if (!appliesToProfiles(ruleItem.matcher?.profiles, contract)) continue
    if (ruleItem.kind === 'pattern') {
      const evidence = findEvidence(contract, ruleItem.pattern)
      if (evidence) risks.push(buildFinding(ruleItem, evidence.text, { paragraphIndex: evidence.paragraphIndex, confidence: evidence.confidence, matching: evidence.matching, evidenceSpans: evidence.spans }))
    } else if (isApplicableMissingRule(ruleItem, contract) && !hasCompleteClause(ruleItem, source, contract)) {
      missingClauses.push(buildFinding(ruleItem, missingClauseEvidence(ruleItem, source), { confidence: 0.72, matching: { method: 'clause_coverage' } }))
    }
  }

  return buildAuditResult({ risks, missingClauses, provider: '增强规则库', status: 'hybrid_rule_based' })
}

export function mergeAiReview(review, fallbackAudit, contract, provider = '模型复核', definitions = riskRuleLibrary) {
  const findings = [...fallbackAudit.risks, ...fallbackAudit.missingClauses]
  const candidates = new Map(findings.map((item) => [item.candidateId || item.ruleId, item]))
  const rules = new Map(definitions.map((item) => [item.id, item]))
  const decisions = Array.isArray(review?.decisions) ? review.decisions : []
  const groups = new Map()
  let ignored = 0, accepted = 0
  for (const item of decisions) {
    if (!candidates.has(item?.candidateId)) { ignored++; continue }
    const candidate = candidates.get(item.candidateId)
    const rule = rules.get(candidate.ruleId)
    const spans = (Array.isArray(item.evidence) ? item.evidence : []).map((entry) => findSourceEvidence(contract, entry)).filter(Boolean)
    const related = rule.kind === 'missing' ? spans : spans.filter((entry) =>
      entry.paragraphIndex === candidate.paragraphIndex && new RegExp(rule.matcher.pattern, rule.matcher.flags).test(entry.quote))
    const keepMissing = rule.kind === 'missing' && item.decision === 'retain' && review.coverage?.complete === true
    if (!related.length && !keepMissing) { ignored++; continue }
    if (!['retain', 'reject', 'needs_review'].includes(item.decision)) { ignored++; continue }
    const group = groups.get(item.candidateId) || []
    group.push({ ...item, spans: related })
    groups.set(item.candidateId, group)
  }
  const rejected = [...(fallbackAudit.rejectedFindings || [])]
  const remaining = []
  for (const candidate of findings) {
    const group = groups.get(candidate.candidateId || candidate.ruleId)
    if (!group?.length) { remaining.push(candidate); continue }
    const kinds = new Set(group.map((item) => item.decision))
    if (kinds.size > 1) {
      remaining.push({ ...candidate, reviewStatus: 'needs_human_review', reviewNote: '模型复核意见不一致，保留规则结果。' })
      accepted++
      continue
    }
    const item = group[0], rule = rules.get(candidate.ruleId)
    if (item.decision === 'reject') {
      const evidenceContract = { ...contract, paragraphStructure: item.spans.map((span) => ({ index: span.paragraphIndex, content: span.quote })) }
      const canReject = rule.kind === 'missing'
        ? item.reasonCode === 'clause_present' && hasCompleteClause(rule, item.spans.map((span) => span.quote).join('\n'), evidenceContract)
        : (item.reasonCode === 'reciprocal' && rule.id === 'unilateral_termination' && item.spans.some((span) => /双方(?:均|都|各自|平等).{0,12}(?:单方)?解除/.test(span.quote))) || item.reasonCode === 'negated' && item.spans.some((span) => {
          const match = new RegExp(rule.matcher.pattern, rule.matcher.flags).exec(span.quote)
          return match && isNegated(span.quote, match.index)
        })
      if (canReject) {
        rejected.push({ ...candidate, rejectedBy: provider, rejectionReason: item.reasonCode, evidenceSpans: item.spans })
        accepted++
        continue
      }
      remaining.push({ ...candidate, reviewStatus: 'needs_human_review', reviewNote: '未获得可验证的撤销依据，保留规则结果。' })
      ignored++
      continue
    }
    remaining.push({ ...candidate, source: provider,
      suggestion: typeof item.suggestion === 'string' && item.spans.length ? item.suggestion.slice(0, 600) : candidate.suggestion,
      evidenceSpans: item.spans.length ? item.spans : candidate.evidenceSpans,
      reviewStatus: item.decision === 'needs_review' ? 'needs_human_review' : 'retained' })
    accepted++
  }
  const result = buildAuditResult({
    risks: remaining.filter((item) => rules.get(item.ruleId)?.kind === 'pattern'),
    missingClauses: remaining.filter((item) => rules.get(item.ruleId)?.kind === 'missing'),
    provider: fallbackAudit.engine.provider, status: fallbackAudit.engine.status
  })
  result.rejectedFindings = rejected
  const stage = { status: review?.status || 'invalid_output', failureClass: review?.failureClass, coverage: review?.coverage,
    acceptedDecisions: accepted, ignoredDecisions: ignored }
  if (stage.status === 'success' && accepted === 0) stage.status = 'no_verifiable_decisions'
  return { audit: result, stage }
}

function buildAuditResult({ risks, missingClauses, provider, status }) {
  const allFindings = [...risks, ...missingClauses]
  const levels = { 高: 0, 中: 0, 低: 0 }
  allFindings.forEach((item) => { levels[item.level] += 1 })
  const score = Math.min(100, levels.高 * 28 + levels.中 * 12 + levels.低 * 5)

  return {
    ruleLibraryVersion: libraryVersion,
    engine: { provider, status, reviewedAt: new Date().toISOString(), offlineMatcher: 'pattern_context_coverage' },
    summary: {
      total: allFindings.length,
      high: levels.高,
      medium: levels.中,
      low: levels.低,
      missing: missingClauses.length,
      score,
      overallLevel: levels.高 ? '高' : levels.中 ? '中' : levels.低 ? '低' : '低'
    },
    risks,
    missingClauses,
    reviewBoundary: '审核结果基于已解析文本、规则库与模型辅助分析生成，仅供合同审阅参考，不构成法律意见。'
  }
}

function buildFinding(ruleItem, evidence, override = {}) {
  return {
    candidateId: ruleItem.id,
    kind: ruleItem.kind,
    reviewKeywords: ruleItem.keywords || [],
    ruleId: ruleItem.id,
    category: ruleItem.category,
    title: ruleItem.title,
    level: normalizeLevel(override.level, ruleItem.level),
    evidence: String(evidence).slice(0, 420),
    reason: String(override.reason || ruleItem.reason).slice(0, 300),
    suggestion: String(override.suggestion || ruleItem.suggestion).slice(0, 300),
    paragraphIndex: Number.isInteger(override.paragraphIndex) ? override.paragraphIndex : null,
    confidence: Number(override.confidence || 0.7),
    matching: override.matching || { method: 'rule_library' },
    evidenceSpans: override.evidenceSpans || [],
    source: override.source || '增强规则库'
  }
}

function findEvidence(contract, pattern) {
  const paragraphs = contract?.paragraphStructure || []
  for (let position = 0; position < paragraphs.length; position += 1) {
    const paragraph = paragraphs[position]
    const text = String(paragraph.content || paragraph.title || '')
    const match = pattern.exec(text)
    pattern.lastIndex = 0
    if (!match || isNegated(text, match.index)) continue
    const contextHits = ['责任', '赔偿', '损失', '违约', '解除', '终止', '义务', '费用', '承担', '不利'].filter((term) => text.includes(term)).length
    const quote = text.slice(Math.max(0, match.index - 90), Math.min(text.length, match.index + match[0].length + 160))
    const span = findSourceEvidence(contract, { paragraphIndex: paragraph.index ?? position + 1, quote })
    return {
      text: quote,
      spans: span ? [span] : [],
      paragraphIndex: Number.isInteger(paragraph.index) ? paragraph.index : position + 1,
      confidence: Math.min(0.96, 0.76 + Math.min(contextHits, 4) * 0.04),
      matching: { method: 'pattern_context', pattern: pattern.source, contextHits }
    }
  }
  return null
}

export function hasCompleteClause(ruleItem, source, contract) {
  if (ruleItem.matcher?.clauseCode) {
    const clause = extendedStandardClauses.find((c) => c.code === ruleItem.matcher.clauseCode)
    return clause ? matchClause(clause, contract).missingRequirements.length === 0 : false
  }
  const contexts = clauseContexts(contract).filter((context) => ruleItem.keywords.some((word) => context.text.includes(word)))
  if (ruleItem.id === 'ambiguous_amount') return contexts.some(({ text }) =>
    /(?:人民币|价款|金额|费用|单价|总额|租金)[^\n。；]{0,35}\d[\d,.，]*(?:\s*(?:元|万元))|(?:每|按)[^\n。；]{0,20}\d+(?:元|万元)/.test(text))
  if (ruleItem.id === 'missing_dispute_resolution') return contexts.some(({ text }) => /人民法院|法院|仲裁委员会|仲裁机构/.test(text) && /协商|诉讼|仲裁|起诉/.test(text))
  const detailTerms = clauseDetailRequirements[ruleItem.id] || []
  return contexts.some(({ text }) => {
    if (text.length < 12) return false
    const hits = detailTerms.filter((term) => text.includes(term))
    return hits.length >= Math.min(2, detailTerms.length)
  })
}

function missingClauseEvidence(ruleItem, source) {
  const topicHit = ruleItem.keywords.some((keyword) => source.includes(keyword))
  return topicHit ? '已发现相关主题词，但未识别到足够的可执行要素。' : '未在已解析合同文本中检索到对应条款主题。'
}

function isNegated(text, index) {
  const context = text.slice(0, index).split(/[。；;！？\n，,]/).pop().slice(-40)
  return ['不得', '禁止', '不应', '不可', '无权', '不再', '排除'].some((term) => context.includes(term))
}

function isApplicableMissingRule(ruleItem, contract) {
  const type = String(contract?.contractType?.predicted || '')
  return true
}

function getContractText(contract) {
  return (contract?.paragraphStructure || []).map((item) => item.content || item.title || '').join('\n')
}

function normalizeLevel(value, fallback) {
  return ['高', '中', '低'].includes(value) ? value : fallback
}

function rule(id, category, title, level, pattern, reason, suggestion) {
  return { id, category, title, level, pattern, reason, suggestion, kind: 'pattern', matcher: { pattern: pattern.source, flags: pattern.flags }, sourceNote: '合同风险审阅通用规则，结合民法典格式条款、公平与权利义务平衡原则。' }
}

function missingRule(id, category, title, level, keywords, reason, suggestion) {
  return { id, category, title, level, keywords, reason, suggestion, kind: 'missing', matcher: { keywords }, sourceNote: '合同风险审阅通用规则，结合民法典格式条款、公平与权利义务平衡原则。' }
}
