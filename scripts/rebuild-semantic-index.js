import { pool, initializeDatabase, getStandardClauseDefinitions } from '../backend/db.js'
import { riskRuleLibrary } from '../backend/services/risk-audit-service.js'
import { indexSemanticSources } from '../backend/services/semantic-retrieval-service.js'

const includeContractRecords = process.argv.includes('--include-contract-records')
const purgePriorRebuildContractIds = process.argv.includes('--purge-prior-rebuild-contract-ids')
await initializeDatabase()

const clauses = await getStandardClauseDefinitions()
const sources = [
  ...riskRuleLibrary.map((rule) => ({
    id: `R-${rule.id}`,
    type: 'database',
    title: `风险规则库 · ${rule.title}`,
    excerpt: `${rule.reason} 建议：${rule.suggestion}`
  })),
  ...clauses.map((clause) => ({
    id: `S-${clause.code}`,
    type: 'database',
    title: `标准条款库 · ${clause.title}`,
    excerpt: `适用范围：${(clause.applicableTypes || []).join('、') || '通用'}。完善建议：${clause.suggestion || '请结合交易情形补充具体约定。'}`
  }))
]

if (includeContractRecords) {
  if (purgePriorRebuildContractIds) {
    await pool.execute(
      `DELETE FROM semantic_vector_index
       WHERE embedding_model = ? AND embedding_model_version = ? AND source_kind = 'contract' AND source_key LIKE 'P-%'`,
      ['Qwen3-Embedding-0.6B-Q8_0', 'Qwen3-Embedding-0.6B-GGUF-Q8_0']
    )
  }
  const [records] = await pool.query('SELECT id, file_name, paragraph_json FROM contract_parse_records ORDER BY id DESC LIMIT 100')
  for (const record of records) {
    const paragraphs = typeof record.paragraph_json === 'string' ? JSON.parse(record.paragraph_json) : record.paragraph_json
    for (const [index, paragraph] of (paragraphs || []).entries()) {
      const excerpt = String(paragraph?.content || paragraph?.text || paragraph?.title || '').trim()
      if (!excerpt) continue
      sources.push({ id: `C${index + 1}`, type: 'contract', title: `${record.file_name} · 第 ${paragraph?.index || index + 1} 段`, excerpt })
    }
  }
}

const result = await indexSemanticSources(sources)
console.log(JSON.stringify({ status: 'passed', includeContractRecords, purgePriorRebuildContractIds, ...result }))
await pool.end()
