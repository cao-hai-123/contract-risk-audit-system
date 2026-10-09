import 'dotenv/config'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'

const config = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', charset: 'utf8mb4' }
const runtime = await mysql.createConnection({ ...config, database: process.env.DB_NAME || 'contract_audit' })
const database = 'contract_library_test_' + Date.now()
assert.match(database, /^contract_library_test_\d+$/)
const quoted = '`' + database + '`'
const results = [], gaps = []
let pool, created = false, quotations = 0
const json = (value) => typeof value === 'string' ? JSON.parse(value) : value
const check = async (name, run) => { await run(); results.push({ name, passed: true }); console.log('PASS ' + name) }
try {
  const manifest = JSON.parse(await fs.readFile('data/template-corpus/manifest.json', 'utf8'))
  const [sources] = await runtime.query('SELECT * FROM standard_contract_sources')
  const [clauses] = await runtime.query('SELECT * FROM standard_clause_library WHERE is_active=1')
  const documents = new Map()
  await check('all 200 source files persist exact hashes and truthful parse coverage', async () => {
    assert.equal(manifest.totalFiles, 200); assert.equal(sources.length, 200)
    assert.equal(new Set(sources.map((s) => s.file_name)).size, 200)
    for (const file of manifest.files) {
      const row = sources.find((s) => s.source_key === file.sourceKey)
      assert.ok(row, file.fileName); assert.equal(row.parse_status, file.parseStatus)
      const metadata = json(row.metadata_json)
      assert.equal(metadata.contentHash, crypto.createHash('sha256').update(await fs.readFile('match/' + file.fileName)).digest('hex'))
      assert.equal(metadata.coverage.complete, file.parseStatus === 'parsed')
      documents.set(file.fileName, { ...file, parsed: JSON.parse(await fs.readFile('data/template-corpus/parsed/' + file.cacheKey + '.json', 'utf8')) })
    }
    for (const family of new Set(manifest.files.map((f) => f.family))) {
      assert.ok(manifest.files.some((f) => f.family === family && f.parseStatus === 'parsed'), family)
    }
  })
  await check('every published topic and requirement quote resolves to the hashed original paragraph', async () => {
    assert.equal(clauses.length, 40)
    for (const clause of clauses) {
      const metadata = json(clause.metadata_json)
      assert.equal(metadata.version, 'contract-library-2026.09.16-v3')
      const spans = [...metadata.evidence, ...Object.values(metadata.requirementSources).flat()]
      for (const span of spans) {
        const doc = documents.get(span.fileName)
        assert.equal(doc.parseStatus, 'parsed'); assert.equal(doc.contentHash, span.sourceHash)
        const paragraph = doc.parsed.paragraphs.find((p, index) => (p.index ?? index + 1) === span.paragraphIndex)
        assert.ok(span.quote.length > 0 && paragraph?.content.includes(span.quote), clause.clause_code + ': ' + span.fileName)
        quotations++
      }
      const missing = json(clause.requirements_json).filter((label) => !metadata.requirementSources[label]?.length)
      if (!clause.source_count || missing.length) gaps.push({ code: clause.clause_code, sourceFamilies: clause.source_count, requirementsWithoutCorpusEvidence: missing })
    }
    assert.ok(quotations > 100)
  })
  await check('56 active MySQL rules include 28 linked coverage topics', async () => {
    const [rules] = await runtime.query('SELECT * FROM risk_rule_library WHERE is_active=1')
    assert.equal(rules.length, 56)
    const linked = rules.filter((r) => json(r.matcher_json).clauseCode)
    assert.equal(linked.length, 28)
    for (const rule of linked) assert.ok(clauses.some((c) => c.clause_code === json(rule.matcher_json).clauseCode))
  })
  await runtime.query('CREATE DATABASE ' + quoted + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  process.env.DB_NAME = database
  const db = await import('../backend/db.js'); pool = db.pool
  await db.initializeDatabase()
  const { syncRiskRuleLibrary, auditContractRisk } = await import('../backend/services/risk-audit-service.js')
  await syncRiskRuleLibrary()
  await check('runtime auditing respects the active MySQL rule definitions', async () => {
    const contract = { sourceFile: '模拟数据库规则测试.docx', paragraphStructure: [{ index: 1, content: '乙方承担一切责任并赔偿甲方全部损失。' }] }
    const options = { dependencies: { localReview: async () => ({ status: 'disabled', decisions: [] }) } }
    assert.ok((await auditContractRisk(contract, options)).risks.some((r) => r.ruleId === 'unlimited_liability'))
    await pool.query("UPDATE risk_rule_library SET is_active=0 WHERE rule_code='unlimited_liability'")
    assert.ok(!(await auditContractRisk(contract, options)).risks.some((r) => r.ruleId === 'unlimited_liability'))
  })
  await check('failed corpus publication rolls back source replacement atomically', async () => {
    const source = { sourceKey: 'synthetic-before', fileName: '模拟旧模板.docx', fileType: 'docx', contractTypeHint: '其他', parseStatus: 'parsed', textLength: 10 }
    await db.saveStandardContractSources([source])
    await assert.rejects(() => db.publishTemplateLibrary([{ ...source, sourceKey: 'synthetic-after' }], [{ code: 'invalid', category: null }]))
    const [rows] = await pool.query('SELECT source_key FROM standard_contract_sources')
    assert.deepEqual(rows.map((r) => r.source_key), ['synthetic-before'])
  })
  const receipt = { checkedAt: new Date().toISOString(), results, quotations, corpus: { total: manifest.totalFiles, parsed: manifest.parsedFiles, partial: manifest.partialFiles, unavailable: manifest.unavailableFiles, families: manifest.familyCount }, gaps, cloudCalls: 0 }
  await fs.writeFile('tmp/performance-library-famie/library-integrity.json', JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ quotations, gaps }))
} finally {
  if (pool) await pool.end()
  if (created) await runtime.query('DROP DATABASE ' + quoted)
  await runtime.end()
}
