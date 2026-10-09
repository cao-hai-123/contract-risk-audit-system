import fs from 'node:fs/promises'
import { assertUsableContract } from '../../shared/contract-content.js'
import { clauseContexts } from './clause-context.js'
import { findSourceEvidence, reviewEngine, safeReview } from './model-review-protocol.js'
import path from 'node:path'
import { getStandardClauseDefinitions, saveStandardClauseDefinitions, saveStandardContractSources, publishTemplateLibrary } from '../db.js'
import { analyzeStandardTemplateBatchWithDeepSeek, reviewStandardClauseMatchWithDeepSeek } from './deepseek-client.js'
import { parseContractDocument } from './document-parser.js'
import { reviewStandardClauseMatchWithEmbeddedModel } from './embedded-llm-service.js'
import { analyzeTemplateCorpus } from './template-corpus.js'
import { extendedStandardClauses, appliesToProfiles, libraryVersion } from './enhanced-contract-library.js'
import { getLocalModelProvider } from './local-model-config.js'
import { getCorpusSupport } from './real-contract-corpus.js'

const allTypes = ['采购合同', '销售合同', '服务外包合同', '劳动合同', '租赁合同', '工程施工合同', '旅游服务合同', '物业服务合同', '其他']

const requirementMatchers = {
  parties: requirementSet(['名称', ['甲方', '乙方', '出租人', '承租人', '委托人', '受托人', '买方', '卖方']], ['主体信息', ['统一社会信用代码', '身份证', '法定代表人', '营业执照', '证件号码']], ['联系方式或送达信息', ['联系电话', '通讯地址', '住所', '电子邮箱', '联系地址']]),
  subject_scope: requirementSet(['标的或服务内容', ['标的', '服务内容', '租赁房屋', '房屋坐落', '项目内容', '货物名称', '培训服务']], ['范围或数量', ['面积', '数量', '范围', '规格', '课程', '服务事项']], ['质量或技术要求', ['质量标准', '验收标准', '技术要求', '使用要求', '符合']]),
  price_payment: requirementSet(['金额或计价方式', ['合同金额', '合同价款', '价款', '租金', '服务费', '收费标准', '单价', '费用']], ['付款节点', ['付款', '支付', '结算', '按月', '按季', '期限内']], ['付款条件', ['验收后', '约定', '到期', '应于', '收款']], ['发票或结算凭证', ['发票', '收据', '结算凭证']]),
  term_performance: requirementSet(['生效条件', ['生效', '签订之日', '签署之日', '自双方']], ['起止期限', ['期限', '起至', '起止', '届满', '年', '月', '日']], ['延期或续期安排', ['续租', '续期', '延长', '延期', '期满']]),
  delivery_acceptance: requirementSet(['交付物', ['交付', '交房', '交接', '返还', '成果']], ['验收标准', ['验收', '检查', '确认', '交接文件']], ['验收期限', ['日前', '期限内', '工作日', '交付后']], ['不合格处理', ['整改', '修复', '不合格', '返工', '赔偿']]),
  rights_obligations: requirementSet(['双方主要义务', ['甲方应', '乙方应', '出租人应', '承租人应', '权利和义务']], ['协作事项', ['配合', '协助', '通知', '告知']], ['资料或条件提供', ['提供', '资料', '条件', '证明']]),
  confidentiality: requirementSet(['保密范围', ['保密', '秘密信息', '商业秘密']], ['使用限制', ['不得泄露', '不得向', '使用限制', '保密义务']], ['期限或例外', ['保密期限', '除外', '期限']], ['成果或数据归属', ['知识产权', '数据', '成果归属']]),
  change_termination: requirementSet(['变更方式', ['变更', '书面', '协商一致']], ['解除条件', ['解除', '终止', '提前退租']], ['通知期限', ['通知', '提前', '日内']], ['终止后的结算或交接', ['返还', '结清', '交接', '退还']]),
  breach_liability: requirementSet(['违约情形', ['违约', '逾期', '未按', '违反']], ['责任方式', ['违约金', '赔偿', '承担责任', '损失']], ['责任边界或上限', ['损失', '责任', '金额', '倍']], ['救济程序', ['催告', '要求', '追究', '解除']]),
  force_majeure: requirementSet(['事件范围', ['不可抗力', '自然灾害', '政府行为']], ['通知义务', ['通知', '告知']], ['证明材料', ['证明', '证据']], ['后续履行安排', ['免除责任', '延期履行', '解除', '协商']]),
  dispute_resolution: requirementSet(['协商程序', ['协商', '调解']], ['仲裁或诉讼方式', ['仲裁', '诉讼', '人民法院']], ['管辖或仲裁机构', ['管辖', '仲裁委员会', '所在地法院']]),
  notice: requirementSet(['送达地址', ['通讯地址', '联系地址', '送达地址', '住所']], ['送达方式', ['书面通知', '电子邮件', '送达', '通知']], ['变更通知', ['地址变更', '联系方式变更', '通知']])
}

const baselineClauses = [
  clause('parties', '合同主体', '合同主体与授权信息', ['甲方', '乙方', '统一社会信用代码', '住所', '法定代表人'], ['名称', '主体信息', '联系方式或送达信息'], '明确双方名称、主体资格、授权代表及可送达联系方式。'),
  clause('subject_scope', '交易内容', '合同标的与服务范围', ['标的', '服务内容', '项目内容', '工作内容', '货物'], ['标的或服务内容', '范围或数量', '质量或技术要求'], '明确交易标的、服务范围、数量、质量标准及不包含事项。'),
  clause('price_payment', '价款结算', '价款、计价与付款安排', ['合同价款', '合同金额', '价款', '付款', '支付', '结算'], ['金额或计价方式', '付款节点', '付款条件', '发票或结算凭证'], '明确含税或不含税口径、计价依据、付款节点、付款条件、发票要求及逾期责任。'),
  clause('term_performance', '履行管理', '合同期限与履行安排', ['履行期限', '合同期限', '有效期', '生效', '起止'], ['生效条件', '起止期限', '延期或续期安排'], '明确生效条件、履行起止时间、里程碑及延期或续期处理方式。'),
  clause('delivery_acceptance', '交付验收', '交付、验收与整改机制', ['交付', '验收', '成果', '质量标准', '整改'], ['交付物', '验收标准', '验收期限', '不合格处理'], '明确交付物、验收标准、验收期限、整改期限、异议提出方式及验收确认规则。'),
  clause('rights_obligations', '权利义务', '双方权利义务', ['甲方权利', '乙方义务', '双方权利', '双方义务', '应当'], ['双方主要义务', '协作事项', '资料或条件提供'], '分别列明双方核心权利义务、配合事项、资料提供和责任边界。'),
  clause('confidentiality', '保密与数据', '保密、数据与知识产权', ['保密', '秘密信息', '数据', '知识产权', '个人信息'], ['保密范围', '使用限制', '期限或例外', '成果或数据归属'], '结合业务性质补充保密信息范围、使用限制、期限、例外、数据处理与知识产权归属。'),
  clause('change_termination', '变更解除', '合同变更、解除与终止', ['变更', '解除', '终止', '协商一致', '通知'], ['变更方式', '解除条件', '通知期限', '终止后的结算或交接'], '明确书面变更机制、解除条件、通知期限、违约解除程序及终止后的结算、交接和资料返还。'),
  clause('breach_liability', '违约责任', '违约责任与损失承担', ['违约责任', '违约金', '赔偿', '损失', '逾期'], ['违约情形', '责任方式', '责任边界或上限', '救济程序'], '明确不同违约情形、违约金或赔偿计算、损失范围、责任限制及救济程序。'),
  clause('force_majeure', '不可抗力', '不可抗力与情势处理', ['不可抗力', '不能履行', '通知', '证明'], ['事件范围', '通知义务', '证明材料', '后续履行安排'], '明确不可抗力事件范围、通知与证明期限、责任减免和合同继续履行或解除安排。'),
  clause('dispute_resolution', '争议解决', '争议解决与适用规则', ['争议解决', '协商', '仲裁', '人民法院', '管辖'], ['协商程序', '仲裁或诉讼方式', '管辖或仲裁机构'], '明确协商程序、仲裁或诉讼路径、管辖法院或仲裁机构以及适用规则。'),
  clause('notice', '通知送达', '通知与送达', ['通知', '送达', '联系方式', '电子邮件', '地址'], ['送达地址', '送达方式', '变更通知'], '明确通知送达地址、电子送达方式、送达视为完成规则及联系方式变更的告知义务。')
]

// Stable offline baseline for reproducible corpus builds and isolated evaluations.
export function getEmbeddedStandardClauses() {
  return structuredClone([...baselineClauses, ...extendedStandardClauses])
}

export async function syncStandardClauseLibrary() {
  const saved = await getStandardClauseDefinitions()
  const existing = new Set(saved.map((c) => c.code))
  const additions = [...baselineClauses, ...extendedStandardClauses].filter((c) => !existing.has(c.code))
  if (additions.length) await saveStandardClauseDefinitions(additions)
  return { count: saved.length + additions.length, source: saved.length ? 'mysql' : 'baseline' }
}

export async function getStandardClauseLibrary() {
  const clauses = await getStandardClauseDefinitions()
  return clauses.length ? clauses : [...baselineClauses, ...extendedStandardClauses]
}

export async function matchStandardClauses(contract, { allowCloudReview = false, dependencies = {} } = {}) {
  assertUsableContract(contract)
  const clauses = await (dependencies.loadClauses || getStandardClauseLibrary)()
  const initial = clauses.filter((item) => isApplicable(item, contract)).map((item) => matchClause(item, contract))
  const localReview = await safeReview(dependencies.localReview || reviewStandardClauseMatchWithEmbeddedModel,
    { contract, clauses, candidates: initial.filter((item) => item.status !== '完整').map((item) => ({ ...item, reviewKeywords: clauses.find((c) => c.code === item.code)?.keywords })) })
  const local = mergeModelReview(initial, localReview, contract, clauses, getLocalModelProvider())
  let items = local.items, cloud
  if (allowCloudReview) {
    const cloudReview = await safeReview(dependencies.cloudReview || reviewStandardClauseMatchWithDeepSeek,
      { contract, clauses, candidates: items.filter((item) => item.status !== '完整') })
    cloud = mergeModelReview(items, cloudReview, contract, clauses, 'DeepSeek')
    items = cloud.items
  }
  const result = buildMatchResult(contract, items, reviewEngine('标准条款库', local.stage, cloud?.stage, allowCloudReview))
  result.corpusSupport = await (dependencies.loadCorpusSupport || (dependencies.loadClauses ? async () => ({ status: 'not_requested', topics: [] }) : getCorpusSupport))()
  return result
}

export async function rebuildStandardClauseLibrary({ matchDirectory = path.resolve(process.cwd(), 'match'), allowCloudAnalysis = false } = {}) {
  const { manifest, documents } = await analyzeTemplateCorpus({ directory: matchDirectory })
  const definitions = [...baselineClauses, ...extendedStandardClauses]
  const clauses = definitions.map((item) => {
    const evidence = [], families = new Set(), files = new Set(), requirementSources = {}
    for (const doc of documents) {
      if (doc.parseStatus !== 'parsed') continue
      const contract = { sourceFile: doc.fileName, paragraphStructure: doc.parsed.paragraphs }
      if (item.metadata?.profiles && !appliesToProfiles(item.metadata.profiles, contract)) continue
      const hit = doc.parsed.paragraphs.find((p) => item.keywords.some((word) => p.content.includes(word)))
      if (!hit) continue
      families.add(doc.family); files.add(doc.fileName)
      for (const span of matchClause(item, contract).requirementEvidence) {
        const list = requirementSources[span.label] ||= []
        if (list.length < 3) list.push({ fileName: doc.fileName, sourceHash: doc.contentHash, paragraphIndex: span.paragraphIndex, quote: span.quote.slice(0, 500) })
      }
      if (evidence.length < 12) evidence.push({ sourceKey: doc.sourceKey, fileName: doc.fileName, sourceHash: doc.contentHash,
        paragraphIndex: hit.index, quote: hit.content.slice(0, 350) })
    }
    return { ...item, sourceCount: families.size, sourceExamples: [...files].slice(0, 5),
      origin: families.size ? '200文件本地语料核验' : '审阅基线；语料未发现支持',
      metadata: { ...item.metadata, version: libraryVersion, evidence, requirementSources, sourceFileCount: files.size,
        sourceFamilyCount: families.size, coverageMeaning: '主题出现次数，不等于法律准确率或条款完整覆盖' } }
  })
  // Template cloud analysis remains explicit and bounded. It only enriches suggestions.
  let cloudReviewedBatches = 0
  if (allowCloudAnalysis) {
    const summaries = documents.filter((d) => d.parseStatus === 'parsed').map((d) => summarizeTemplate(d.fileName, inferTemplateType(d.fileName), d.parsed))
    for (let start = 0; start < summaries.length; start += 10) {
      const observations = await analyzeStandardTemplateBatchWithDeepSeek(summaries.slice(start, start + 10))
      if (!Array.isArray(observations) || !observations.length) continue
      cloudReviewedBatches++
      for (const result of observations) {
        const item = clauses.find((c) => c.code === result.code)
        if (item && typeof result.suggestion === 'string') item.suggestion = result.suggestion.slice(0, 360)
      }
    }
  }
  const sources = documents.map(({ parsed, ...record }) => ({ ...record, contractTypeHint: inferTemplateType(record.fileName),
    metadata: { contentHash: record.contentHash, textHash: record.textHash, family: record.family, coverage: record.coverage, parserVersion: manifest.parserVersion } }))
  await publishTemplateLibrary(sources, clauses)
  return { ...manifest, files: undefined, clauseCount: clauses.length, cloudReviewedBatches, cloudUsed: cloudReviewedBatches > 0 }

}

function clause(code, category, title, keywords, requirements, suggestion) {
  return { code, category, title, keywords, requirements, applicableTypes: allTypes, suggestion, sourceCount: 0, sourceExamples: [], origin: '内置基线' }
}

function isApplicable(clauseItem, contract) {
  if (clauseItem.metadata?.profiles?.length) return appliesToProfiles(clauseItem.metadata.profiles, contract)
  const type = deriveContractType(contract)
  if (type === '租赁合同' && clauseItem.code === 'confidentiality') return false
  if (['租赁合同', '旅游服务合同'].includes(type) && clauseItem.code === 'subject_scope') return true
  return !clauseItem.applicableTypes?.length || clauseItem.applicableTypes.includes(type) || clauseItem.applicableTypes.includes('其他')
}

const clauseFocus = {
  parties: /甲方|乙方|出租人|承租人|法定代表人|身份证|统一社会信用|通讯地址|住所|联系人|联系电话|电子邮箱/,
  subject_scope: /标的|服务|项目|租赁|房屋|货物|规格|数量|质量标准|使用要求/,
  price_payment: /价款|金额|租金|付款|支付|结算|发票|收据/,
  term_performance: /期限|生效|有效期|续租|续期|期满|届满|起止|自.{0,18}至/,
  delivery_acceptance: /交付|交房|交接|验收|整改|不合格|修复|返工|返还.{0,8}房屋|房屋.{0,8}返还/,
  rights_obligations: /甲方|乙方|出租人|承租人|双方|权利|义务/,
  confidentiality: /保密|秘密信息|商业秘密|知识产权|个人信息|数据安全/,
  change_termination: /变更|解除|终止|续租|退租/,
  breach_liability: /违约|逾期|违约金|赔偿|催告|损失/,
  force_majeure: /不可抗力|自然灾害|不能预见|不能避免|不能克服/,
  dispute_resolution: /争议|仲裁|诉讼|法院|调解/,
  notice: /送达|通讯地址|联系地址|电子邮件|联系方式|通知|告知/
}

export function matchClause(clauseItem, contract) {
  const paragraphs = contract.paragraphStructure || []
  const contexts = clauseContexts(contract).filter(({ text }) =>
    clauseFocus[clauseItem.code]?.test(text) || (!clauseFocus[clauseItem.code] && clauseItem.keywords.some((word) => text.includes(word))))
  const source = contexts.map((context) => context.text).join('\n')
  const descriptors = clauseItem.metadata?.matchers || requirementMatchers[clauseItem.code] || clauseItem.requirements.map((label) => ({ label, terms: [label] }))
  const presentKeywords = clauseItem.keywords.filter((keyword) => source.includes(keyword))
  const requirementEvidence = []
  const presentRequirements = descriptors.filter((descriptor) => {
    const verified = contexts.flatMap((entry) => entry.paragraphs).map((paragraph) => {
      const quote = String(paragraph.content || paragraph.text || '')
      if (!supportsRequirement(clauseItem.code, descriptor, quote)) return null
      return findSourceEvidence(contract, { paragraphIndex: paragraph.index ?? paragraphs.indexOf(paragraph) + 1, quote })
    }).find(Boolean)
    if (!verified) return false
    requirementEvidence.push({ label: descriptor.label, ...verified })
    return true
  }).map((descriptor) => descriptor.label)
  const missingRequirements = descriptors.filter((descriptor) => !presentRequirements.includes(descriptor.label)).map((descriptor) => descriptor.label)
  const keywordScore = presentKeywords.length / Math.max(clauseItem.keywords.length, 1)
  const requirementScore = presentRequirements.length / Math.max(descriptors.length, 1)
  const completeness = Number((keywordScore * 0.42 + requirementScore * 0.58).toFixed(2))
  // A high keyword score cannot replace evidence for an explicitly missing requirement.
  const status = descriptors.length > 0 && missingRequirements.length === 0 ? '完整' : presentRequirements.length > 0 ? '部分具备' : '缺失'
  const span = requirementEvidence.find((entry) => entry.quote)
  return {
    candidateId: clauseItem.code, code: clauseItem.code, category: clauseItem.category, title: clauseItem.title,
    status, completeness, evidence: span?.quote || '未在相关条款中识别到可核验的要素。',
    paragraphIndex: span?.paragraphIndex ?? null, requirementEvidence, presentRequirements, missingRequirements,
    suggestion: clauseItem.suggestion, sourceCount: clauseItem.sourceCount || 0, sourceExamples: clauseItem.sourceExamples || [],
    origin: clauseItem.origin, libraryEvidence: clauseItem.metadata?.evidence || [], reviewKeywords: clauseItem.keywords, evaluationMethod: 'clause_context_keyword_heuristic'
  }
}

function requirementSet(...entries) {
  return entries.map(([label, terms]) => ({ label, terms }))
}

function supportsRequirement(code, descriptor, text) {
  if (descriptor.pattern) return new RegExp(descriptor.pattern).test(text) && !/(?:另行约定|尚未明确|待定)/.test(text)
  if (code !== 'delivery_acceptance' || descriptor.label === '交付物') return descriptor.terms.some((term) => text.includes(term))
  // A payment due after acceptance is not an acceptance deadline. Routine maintenance
  // is not a remedy for failed acceptance. Apply the same checks to model-supplied quotes.
  const relevant = text.split(/[。；;\n]/).filter((part) => !/验收(?:合格)?后.{0,40}(?:付款|支付|结算|发票)/.test(part)).join('；')
  if (descriptor.label === '验收标准') {
    if (/(?:验收|检查|交接).{0,12}(?:待定|另行协商|另行约定|尚未明确)/.test(relevant)) return false
    return /按.{0,30}(?:标准|要求|清单).{0,12}(?:验收|检查|确认)|(?:验收|交接).{0,12}(?:标准|清单|文件)|(?:标准|清单).{0,12}(?:验收|交接)|查验.{0,15}(?:状况|数量|设备|设施)/.test(relevant)
  }
  if (descriptor.label === '验收期限') return /(?:验收|检查|确认)(?:期限|时间|应于|应在|须在).{0,18}(?:日|天)|(?:交付|交接|收到).{0,30}(?:日|天).{0,15}(?:验收|检查|确认)|(?:\d+|[一二三四五六七八九十]+)个?(?:工作)?(?:日|天)内.{0,12}(?:验收|检查|确认)/.test(relevant)
  if (descriptor.label === '不合格处理') return /(?:不合格|未通过|不符合|瑕疵|缺陷|验收异议).{0,35}(?:整改|修复|返工|更换|退货|赔偿)|(?:整改|返工).{0,20}(?:验收|复验)|(?:验收|交接).{0,25}(?:整改|返工|修复)/.test(relevant)
  return descriptor.terms.some((term) => relevant.includes(term))
}

function deriveContractType(contract) {
  const configuredType = contract?.contractType?.predicted || ''
  if (allTypes.includes(configuredType) && configuredType !== '其他') return configuredType
  const text = `${contract?.sourceFile || ''}\n${(contract?.paragraphStructure || []).slice(0, 80).map((item) => item.content || item.title || '').join('\n')}`
  if (/租赁|出租人|承租人|租金|房屋/.test(text)) return '租赁合同'
  if (/施工|工程|建设/.test(text)) return '工程施工合同'
  if (/旅游|旅行社|导游/.test(text)) return '旅游服务合同'
  if (/物业/.test(text)) return '物业服务合同'
  return configuredType || '其他'
}

export function mergeModelReview(items, review, contract, clauses, provider = '模型复核') {
  let accepted = 0, ignored = 0
  const allowed = new Set(items.filter((item) => item.status !== '完整').map((item) => item.code))
  const grouped = new Map()
  for (const decision of review?.decisions || []) {
    if (!allowed.has(decision?.candidateId)) { ignored++; continue }
    const group = grouped.get(decision.candidateId) || []
    group.push(decision); grouped.set(decision.candidateId, group)
  }
  const result = items.map((item) => {
    const decisions = grouped.get(item.code)
    if (!decisions) return item
    const spans = decisions.flatMap((decision) => (Array.isArray(decision.evidence) ? decision.evidence : []).map((entry) => findSourceEvidence(contract, entry)).filter(Boolean))
    if (!spans.length) { ignored += decisions.length; return item }
    accepted++
    const requested = decisions.map((entry) => entry.status).filter((value) => ['完整', '部分具备', '缺失'].includes(value))
    const modelStatus = requested[0] || item.status
    const clause = clauses.find((entry) => entry.code === item.code)
    const descriptors = clause.metadata?.matchers || requirementMatchers[item.code] || clause.requirements.map((label) => ({ label, terms: [label] }))
    const proved = decisions.flatMap((decision) => Array.isArray(decision.requirementEvidence) ? decision.requirementEvidence : []).flatMap((entry) => {
      const span = findSourceEvidence(contract, entry)
      const descriptor = descriptors.find((requirement) => requirement.label === entry?.label)
      if (!span || !descriptor || !supportsRequirement(item.code, descriptor, span.quote) || !(clauseFocus[item.code]?.test(span.quote) || clause.keywords.some((word) => span.quote.includes(word)))) return []
      return [{ label: entry.label, ...span }]
    })
    const evidence = [...item.requirementEvidence, ...proved]
    const presentRequirements = descriptors.filter((descriptor) => evidence.some((entry) => entry.label === descriptor.label)).map((entry) => entry.label)
    const missingRequirements = descriptors.filter((descriptor) => !presentRequirements.includes(descriptor.label)).map((entry) => entry.label)
    // A model cannot manufacture completeness: every formerly missing requirement needs source proof.
    const upgrade = new Set(requested).size <= 1 && rankStatus(modelStatus) > rankStatus(item.status) &&
      missingRequirements.length === 0 && proved.length > 0
    return { ...item, status: upgrade ? modelStatus : item.status,
      completeness: upgrade ? 1 : item.completeness,
      presentRequirements: upgrade ? presentRequirements : item.presentRequirements,
      missingRequirements: upgrade ? missingRequirements : item.missingRequirements,
      requirementEvidence: upgrade ? evidence : item.requirementEvidence,
      suggestion: String(decisions.find((entry) => entry.suggestion)?.suggestion || item.suggestion).slice(0, 600),
      modelReviewed: true, modelStatus, reviewProvider: provider,
      reviewStatus: requested.some((value) => rankStatus(value) < rankStatus(item.status)) ? 'needs_human_review' : 'evidence_checked' }
  })
  const stage = { status: review?.status || 'invalid_output', failureClass: review?.failureClass, coverage: review?.coverage,
    acceptedDecisions: accepted, ignoredDecisions: ignored }
  if (stage.status === 'success' && accepted === 0) stage.status = 'no_verifiable_decisions'
  return { items: result, stage }
}

function rankStatus(status) {
  return ({ 缺失: 0, 部分具备: 1, 完整: 2 })[status] ?? 0
}

function buildMatchResult(contract, items, engine) {
  const counts = { 完整: 0, 部分具备: 0, 缺失: 0 }
  items.forEach((item) => { counts[item.status] += 1 })
  const score = items.length ? Math.round((counts.完整 + counts.部分具备 * 0.5) / items.length * 100) : 0
  return {
    contract: { sourceFile: contract?.sourceFile || '未命名合同', contractType: contract?.contractType?.predicted || '未识别' },
    engine,
    summary: { total: items.length, complete: counts.完整, partial: counts.部分具备, missing: counts.缺失, completenessScore: score, overall: score >= 80 ? '较完整' : score >= 55 ? '需完善' : '缺失较多' },
    items,
    boundary: '本结果依据标准模板条款库、文本匹配与模型辅助复核生成，仅用于合同完整性审阅参考，不构成法律意见或适用于所有交易的强制模板。'
  }
}

function summarizeTemplate(fileName, contractType, parsed) {
  const headingTexts = parsed.paragraphs.filter((item) => item.type === 'section' || item.type === 'clause').slice(0, 24).map((item) => item.content.slice(0, 80))
  return { fileName, contractType, headings: headingTexts, excerpt: parsed.text.slice(0, 1200) }
}

function inferTemplateType(fileName) {
  const name = String(fileName || '')
  if (/租赁|出租|住房|停车/.test(name)) return '租赁合同'
  if (/施工|工程|建筑|装修/.test(name)) return '工程施工合同'
  if (/旅游|婚宴|培训|餐饮|家政|养老|物业/.test(name)) return '服务外包合同'
  if (/买卖|采购|销售|供应/.test(name)) return '采购合同'
  if (/劳动|聘用/.test(name)) return '劳动合同'
  return '其他'
}
