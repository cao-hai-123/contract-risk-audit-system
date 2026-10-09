import assert from 'node:assert/strict'
import { answerContractQuestion, buildAssistantContext } from '../backend/services/contract-assistant-service.js'
import { buildLegalSearchQuery } from '../backend/services/legal-web-search-service.js'
import { getLocalModelProvider } from '../backend/services/local-model-config.js'

const contract = {
  sourceFile: '脱敏-服务合同.docx',
  contractType: { predicted: '服务外包合同' },
  paragraphStructure: [
    { index: 1, type: 'clause', content: '甲方委托乙方提供系统运维服务，服务期限自2026年9月1日至2027年8月31日。' },
    { index: 2, type: 'clause', content: '服务费用分两期支付，乙方完成阶段验收后提交付款申请。' },
    { index: 3, type: 'clause', content: '双方因履行本合同发生争议，应先友好协商解决。' }
  ]
}

const clauses = [{ code: 'dispute_resolution', title: '争议解决', category: '争议处理', keywords: ['争议', '仲裁', '法院'], applicableTypes: ['服务外包合同'], suggestion: '明确协商期限、仲裁机构或有管辖权的人民法院。' }]

const legalQuery = buildLegalSearchQuery('某敏感项目的合同解除通常需要注意哪些法律规则？')
assert.ok(legalQuery.includes('合同解除'), 'should preserve legal search intent')
assert.ok(!legalQuery.includes('某敏感项目'), 'should not include project names in the web search query')

const semanticSearch = async () => ({ status: 'ready', provider: '本地 Qwen 向量检索 + 词法排序', scores: new Map([['C3', 0.97], ['S-dispute_resolution', 0.89]]) })
const webSearch = async () => ({ status: 'success', sources: [{ id: 'W1', type: 'web', title: '某官方公开法律页面', url: 'https://www.court.gov.cn/example', excerpt: '公开法律检索结果摘要。' }] })
const context = await buildAssistantContext({ question: '争议解决条款是否完整，如何完善？', contract, loadStandardClauses: async () => clauses, semanticSearch, webSearch, allowWebSearch: true })
assert.ok(context.sources.some((item) => item.type === 'contract'), 'should retrieve contract evidence')
assert.ok(context.sources.some((item) => item.type === 'database'), 'should retrieve MySQL-backed library evidence')
assert.ok(context.sources.some((item) => item.type === 'official'), 'should retrieve vetted official source')
assert.ok(context.sources.some((item) => item.id === 'W1'), 'should include explicitly requested live legal source')
assert.equal(context.retrieval.semantic.status, 'ready')
assert.equal(context.retrieval.web.status, 'success')

const localReply = { answer: '本地草稿：当前仅约定协商，建议补充争议解决路径。', citations: ['C3', 'S-dispute_resolution'], suggestions: ['明确协商期限和管辖方式。'] }
const cloudReply = { answer: '合同现有条款仅写明协商解决，尚未明确协商未果后的争议解决路径，建议补充仲裁或诉讼管辖约定。', citations: ['C3', 'S-dispute_resolution', 'official-contract-interpretation'], suggestions: ['约定协商期限，并明确仲裁机构或有管辖权的人民法院。'] }

const retrievalDependencies = { loadStandardClauses: async () => clauses, semanticSearch, webSearch }
const polished = await answerContractQuestion({ question: '争议解决条款是否完整，如何完善？', contract, allowWebSearch: true, dependencies: { ...retrievalDependencies, localAsk: async () => localReply, cloudAsk: async ({ draft }) => { assert.equal(draft.answer, localReply.answer); return cloudReply } } })
assert.equal(polished.engine.status, 'cloud_polished')
assert.equal(polished.engine.provider, getLocalModelProvider() + ' + DeepSeek')
assert.equal(polished.engine.stages.cloud.receivedLocalDraft, true)
assert.equal(polished.citations.length, 3)

const localFallback = await answerContractQuestion({ question: '争议解决条款是否完整，如何完善？', contract, dependencies: { ...retrievalDependencies, localAsk: async () => localReply, cloudAsk: async () => ({ errorStatus: 'network_unavailable' }) } })
assert.equal(localFallback.engine.status, 'local_fallback')
assert.equal(localFallback.engine.fallback, true)

const deterministic = await answerContractQuestion({ question: '争议解决条款是否完整，如何完善？', contract, dependencies: { ...retrievalDependencies, localAsk: async () => null, cloudAsk: async () => ({ errorStatus: 'missing_api_key' }) } })
assert.equal(deterministic.engine.status, 'deterministic_fallback')
assert.ok(deterministic.answer.includes('合同原文'))

console.log('Contract assistant self-test passed: evidence retrieval, cloud polish, local fallback, and deterministic fallback are correct.')
