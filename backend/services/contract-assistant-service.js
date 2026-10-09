import { getStandardClauseLibrary } from './standard-clause-service.js'
import { riskRuleLibrary } from './risk-audit-service.js'
import { askContractAssistantWithDeepSeek } from './deepseek-client.js'
import { askContractAssistantWithEmbeddedModel } from './embedded-llm-service.js'
import { rankSourcesBySemanticSimilarity } from './semantic-retrieval-service.js'
import { searchTrustedLegalWeb } from './legal-web-search-service.js'
import { getLocalModelProvider } from './local-model-config.js'

const officialReferenceCatalog = [
  {
    id: 'official-contract-interpretation',
    title: '最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释',
    url: 'https://www.court.gov.cn/zixun/xiangqing/419382.html',
    keywords: ['解释', '条款', '合同', '成立', '效力', '履行', '解除', '争议', '诚信'],
    excerpt: '合同条款解释应结合词句通常含义、相关条款、合同性质和目的、习惯、诚信原则以及缔约背景、磋商过程和履行行为等因素。'
  },
  {
    id: 'official-contract-cases',
    title: '最高人民法院发布民法典合同编通则司法解释相关典型案例',
    url: 'https://www.court.gov.cn/zixun/xiangqing/419392.html',
    keywords: ['案例', '租赁', '买卖', '履行', '解除', '违约', '争议', '合同'],
    excerpt: '最高人民法院公开发布与民法典合同编通则司法解释相关的典型案例，供理解合同争议处理规则时参考。'
  }
]

export async function answerContractQuestion({ question, contract, history = [], allowWebSearch = false, dependencies = {} }) {
  const normalizedQuestion = normalizeQuestion(question)
  if (!normalizedQuestion) throw new Error('请输入需要咨询的合同问题。')

  const context = await buildAssistantContext({
    question: normalizedQuestion,
    contract,
    loadStandardClauses: dependencies.loadStandardClauses || getStandardClauseLibrary,
    semanticSearch: dependencies.semanticSearch || rankSourcesBySemanticSimilarity,
    webSearch: dependencies.webSearch || searchTrustedLegalWeb,
    allowWebSearch
  })
  const recentHistory = normalizeHistory(history)
  const cloudAsk = dependencies.cloudAsk || askContractAssistantWithDeepSeek
  const localAsk = dependencies.localAsk || askContractAssistantWithEmbeddedModel

  // The local draft makes the "local analysis + cloud review" status truthful instead of
  // merely claiming that both providers were used.
  const local = await localAsk({ question: normalizedQuestion, context, history: recentHistory })
  const cloud = await cloudAsk({ question: normalizedQuestion, context, history: recentHistory, draft: local?.answer ? local : null })
  const localProvider = local?.provider || getLocalModelProvider()
  const stages = {
    local: { status: local?.answer ? 'success' : local?.errorStatus || 'unavailable', provider: localProvider, model: local?.model || null },
    cloud: { status: cloud?.answer ? 'success' : cloud?.errorStatus || 'unavailable', model: cloud?.model || null, receivedLocalDraft: Boolean(local?.answer) }
  }
  if (cloud?.answer) {
    return normalizeAssistantReply(cloud, context, {
      provider: local?.answer ? localProvider + ' + DeepSeek' : 'DeepSeek',
      stages,
      status: local?.answer ? 'cloud_polished' : 'cloud_success',
      fallback: false,
      notice: local?.answer
        ? `已由${localProvider}基于${context.retrieval.semantic.provider}生成草稿，并由 DeepSeek 云端复核和润色。${context.retrieval.web.notice}`
        : `${localProvider}未完成（${stages.local.status}），已由 DeepSeek 结合合同原文、系统知识库和可信公开来源生成答复。${context.retrieval.web.notice}`
    })
  }

  if (local?.answer) {
    return normalizeAssistantReply(local, context, {
      provider: localProvider,
      stages,
      status: 'local_fallback',
      fallback: true,
      notice: `DeepSeek 云端处理未完成（${cloud?.errorStatus || '服务不可用'}），已降级为${localProvider}基于同一证据集作答。${context.retrieval.web.notice}`
    })
  }

  const fallback = buildDeterministicFallback(normalizedQuestion, context, cloud?.errorStatus)
  fallback.engine.stages = stages
  fallback.engine.notice += ` 本地失败分类：${stages.local.status}。`
  return fallback
}

export async function buildAssistantContext({ question, contract, loadStandardClauses = getStandardClauseLibrary, semanticSearch = rankSourcesBySemanticSimilarity, webSearch = searchTrustedLegalWeb, allowWebSearch = false }) {
  const contractSources = collectContractSources(question, contract)
  const [standardClauses] = await Promise.all([loadStandardClauses().catch(() => [])])
  const databaseSources = collectDatabaseSources(question, standardClauses)
  const officialSources = collectOfficialSources(question)
  const lexicalSources = [...contractSources, ...databaseSources, ...officialSources]
  const semanticCandidates = lexicalSources
  const [semantic, web] = await Promise.all([
    semanticSearch({ question, sources: semanticCandidates }).catch(() => ({ status: 'embedding_unavailable', provider: '词法相关性排序', scores: new Map() })),
    allowWebSearch ? webSearch(question).catch(() => ({ status: 'search_unavailable', sources: [] })) : Promise.resolve({ status: 'not_requested', sources: [] })
  ])
  const sources = rankHybridSources([...lexicalSources, ...(web.sources || [])], semantic.scores || new Map())
  const webNotice = buildWebSearchNotice(allowWebSearch, web)

  return {
    contractName: String(contract?.sourceFile || '当前合同文件'),
    contractType: String(contract?.contractType?.predicted || '未识别'),
    question,
    mode: detectQuestionMode(question),
    sources,
    sourceText: sources.map((source) => `[${source.id}] ${source.title}\n${source.excerpt}`).join('\n\n'),
    retrieval: {
      semantic: { status: semantic.status || 'embedding_unavailable', provider: semantic.provider || '词法相关性排序', coverage: semantic.coverage || { totalChunks: semanticCandidates.length, complete: false } },
      web: { requested: allowWebSearch, status: web.status || 'search_unavailable', resultCount: (web.sources || []).length, notice: webNotice }
    },
    boundary: '答复仅基于可识别合同文本、系统规则和所列公开来源提供审阅辅助，不构成法律意见或最终法律结论。'
  }
}

export function collectContractSources(question, contract) {
  const paragraphs = Array.isArray(contract?.paragraphStructure) ? contract.paragraphStructure : []
  const candidates = paragraphs
    .flatMap((paragraph, index) => {
      const text = String(paragraph?.content || paragraph?.text || paragraph?.title || '')
      const chunks = []
      for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + 650)
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
        const excerpt = text.slice(start, end)
        chunks.push({
        id: start === 0 ? `C${index + 1}` : `C${index + 1}-${start}`,
        type: 'contract',
        title: `${String(contract?.sourceFile || '当前合同')} · 第 ${paragraph?.index || index + 1} 段${paragraph.page ? ` · 第 ${paragraph.page} 页` : ''} · 字符 ${start + 1}–${end}`,
        excerpt, paragraphIndex: paragraph.index ?? index + 1, page: paragraph.page ?? null, charStart: start, charEnd: end,
        score: relevanceScore(question, excerpt) + (paragraph?.type === 'clause' ? 0.08 : 0)
        })
        if (end === text.length) break
        start = end - 80
        if (/[\uDC00-\uDFFF]/.test(text[start])) start--
      }
      return chunks
    })
    .filter((item) => item.excerpt)
    .sort((left, right) => right.score - left.score)
  return candidates
}

function collectDatabaseSources(question, clauses) {
  const rules = riskRuleLibrary.map((rule) => ({
    id: `R-${rule.id}`,
    type: 'database',
    title: `风险规则库 · ${rule.title}`,
    excerpt: `${rule.reason} 建议：${rule.suggestion}`,
    score: relevanceScore(question, `${rule.title} ${rule.category} ${rule.reason} ${rule.suggestion}`)
  }))
  const standard = (clauses || []).map((clause) => ({
    id: `S-${clause.code}`,
    type: 'database',
    title: `标准条款库 · ${clause.title}`,
    excerpt: `适用范围：${(clause.applicableTypes || []).join('、') || '通用'}。完善建议：${clause.suggestion || '请结合交易情形补充具体约定。'}`,
    score: relevanceScore(question, `${clause.title} ${clause.category} ${(clause.keywords || []).join(' ')} ${clause.suggestion || ''}`)
  }))
  return [...rules, ...standard].sort((left, right) => right.score - left.score)
}

function collectOfficialSources(question) {
  return officialReferenceCatalog
    .map((source) => ({ ...source, type: 'official', score: relevanceScore(question, `${source.title} ${source.keywords.join(' ')} ${source.excerpt}`) }))
    .filter((source) => source.score > 0.05 || /合同|条款|效力|解除|履行|争议|法律|法规/.test(question))
    .sort((left, right) => right.score - left.score)
    .map(({ keywords, ...item }) => item)
}

function rankHybridSources(sources, semanticScores) {
  // Reciprocal rank fusion combines independently ranked full-text and vector recalls.
  const lexical = [...sources].sort((a,b) => b.score-a.score)
  const semantic = sources.filter(s => Number.isFinite(semanticScores.get(s.id))).sort((a,b) => semanticScores.get(b.id)-semanticScores.get(a.id))
  const fused = new Map()
  lexical.forEach((s,i) => fused.set(s.id, s.score > 0 ? 1/(60+i+1) : 0))
  semantic.forEach((s,i) => fused.set(s.id, (fused.get(s.id)||0)+1/(60+i+1)))
  const ranked = sources.map(s => ({...s, score:fused.get(s.id)||0})).sort((a,b)=>b.score-a.score)
  const limits = { contract: 5, database: 3, official: 2, web: 4 }
  const selected = []
  const counts = new Map()
  for (const item of ranked) {
    if (item.type === 'contract' && selected.some(s => s.type === 'contract' && s.paragraphIndex === item.paragraphIndex && Math.max(s.charStart,item.charStart) < Math.min(s.charEnd,item.charEnd))) continue
    const type = item.type || 'other'
    if ((counts.get(type) || 0) >= (limits[type] || 1)) continue
    selected.push(stripInternalScore(item))
    counts.set(type, (counts.get(type) || 0) + 1)
    if (selected.length >= 12) break
  }
  return selected
}

function stripInternalScore({ score, ...source }) { return source }

function buildWebSearchNotice(requested, web) {
  if (!requested) return ''
  if (web.status === 'success') return `已启用全网法律检索并加入 ${web.sources.length} 条官方公开来源。`
  if (web.status === 'no_trusted_results') return '全网法律检索未返回可核验的官方来源，未将不可信网页加入答复。'
  return `全网法律检索未完成（${web.status || '服务不可用'}），已继续使用本地与内置可信来源。`
}

function normalizeAssistantReply(reply, context, engine) {
  const sourceById = new Map(context.sources.map((source) => [source.id, source]))
  const citationIds = Array.isArray(reply.citations) ? reply.citations.filter((id) => sourceById.has(id)).slice(0, 6) : []
  const resolvedCitationIds = citationIds
  return {
    answer: normalizeText(reply.answer || '').slice(0, 4000) || '未能形成可核验的答复，请结合下方来源重新提问。',
    suggestions: Array.isArray(reply.suggestions) ? reply.suggestions.map((item) => normalizeText(item)).filter(Boolean).slice(0, 5) : [],
    summary: normalizeText(reply.summary || ''),
    citations: resolvedCitationIds.map((id) => sourceById.get(id)).filter(Boolean),
    citationStatus: citationIds.length ? 'source_ids_verified' : 'no_verified_citations',
    engine: { ...engine, notice: (engine.notice || '') + (citationIds.length ? '' : ' 本次模型未提供有效引用，答复尚无可核验的来源支持。'), reviewedAt: new Date().toISOString() },
    retrieval: context.retrieval,
    boundary: context.boundary
  }
}

function buildDeterministicFallback(question, context, cloudErrorStatus) {
  const contractEvidence = context.sources.filter((item) => item.type === 'contract')
  const lead = contractEvidence.length
    ? `围绕“${question}”，当前可检索到的合同原文要点如下：${contractEvidence.map((item) => `【${item.id}】${item.excerpt}`).join('；')}`
    : `当前未在已解析合同中检索到与“${question}”直接对应的原文段落。`
  const databaseEvidence = context.sources.filter((item) => item.type === 'database')
  const additions = databaseEvidence.length ? `系统知识库提示：${databaseEvidence.map((item) => `【${item.id}】${item.excerpt}`).join('；')}` : ''
  return {
    answer: `${lead}${additions ? `\n\n${additions}` : ''}\n\n建议以原合同、完整交易背景及专业审阅意见为准。`,
    suggestions: ['补充明确的权利义务、履行标准和通知方式。', '对涉及金额、期限、责任或解除条件的约定，建议保留可核验的书面证据。'],
    summary: '当前由本地检索摘要生成。',
    citations: context.sources.slice(0, 5),
    engine: {
      provider: '本地检索摘要',
      status: 'deterministic_fallback',
      fallback: true,
      notice: `DeepSeek 与本地 Qwen 均未完成可用答复（${cloudErrorStatus || '服务不可用'}），已返回不含模型推断的检索摘要。${context.retrieval.web.notice}`,
      reviewedAt: new Date().toISOString()
    },
    retrieval: context.retrieval,
    boundary: context.boundary
  }
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return []
  return history.slice(-6).map((item) => ({ role: item?.role === 'assistant' ? 'assistant' : 'user', content: normalizeText(item?.content || '').slice(0, 1200) })).filter((item) => item.content)
}

function normalizeQuestion(value) {
  return normalizeText(value).slice(0, 2000)
}

function detectQuestionMode(question) {
  if (/修改|优化|改写|补充|完善|建议/.test(question)) return 'amendment_suggestion'
  if (/摘要|概括|总结|重点/.test(question)) return 'summary'
  if (/解释|含义|理解|什么意思/.test(question)) return 'clause_explanation'
  if (/风险|违约|责任|解除|争议/.test(question)) return 'risk_question'
  return 'contract_question'
}

function relevanceScore(query, text) {
  const queryTerms = extractTerms(query)
  const source = String(text || '').toLowerCase()
  if (!source) return 0
  const matches = queryTerms.filter((term) => source.includes(term)).length
  const phraseBonus = source.includes(String(query || '').toLowerCase()) ? 0.45 : 0
  return Math.min(1, matches / Math.max(3, queryTerms.length) + phraseBonus)
}

function extractTerms(value) {
  const source = String(value || '').toLowerCase()
  const cjkSequences = source.match(/[\u4e00-\u9fff]+/g) || []
  const cjkTerms = cjkSequences.flatMap((sequence) => {
    const terms = []
    for (let size = 2; size <= Math.min(4, sequence.length); size += 1) {
      for (let index = 0; index <= sequence.length - size; index += 1) terms.push(sequence.slice(index, index + size))
    }
    return terms
  })
  const latinTerms = source.match(/[a-z0-9]{2,}/g) || []
  return [...new Set([...cjkTerms, ...latinTerms].filter((term) => !['请问', '合同', '这个', '怎么', '可以', '是否', '什么'].includes(term)))].slice(0, 16)
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
}

function shorten(value, length) {
  const source = normalizeText(value)
  return source.length > length ? `${source.slice(0, length)}...` : source
}
