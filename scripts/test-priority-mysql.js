import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()
const config = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', charset: 'utf8mb4' }
const database = 'contract_repair_test_' + Date.now()
const created = new Set(), restoreConnections = []
const quote = (value) => {
  if (!/^contract_repair_test_\d+(?:_restore_[ab])?$/.test(value)) throw Error('Refusing non-test database operation')
  return String.fromCharCode(96) + value + String.fromCharCode(96)
}
const admin = await mysql.createConnection(config)
let pool
const results = []
const check = async (name, run) => { await run(); results.push({ name, passed: true }); console.log('PASS ' + name) }
process.env.DB_NAME = database
process.env.LOCAL_LLM_MODE = 'disabled'
process.env.DEEPSEEK_API_DISABLED = 'true'
try {
  await admin.query('CREATE DATABASE ' + quote(database) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created.add(database)
  const db = await import('../backend/db.js'); pool = db.pool
  await db.initializeDatabase()
  const { publishEvidenceBundle } = await import('../backend/services/real-contract-corpus.js')
  await publishEvidenceBundle({ buildId: 'f'.repeat(64), version: 'synthetic-backup-test', sources: [], evidence: [], topics: [], legalReview: 'pending' })
  const { syncRiskRuleLibrary, auditContractRisk } = await import('../backend/services/risk-audit-service.js')
  const { syncStandardClauseLibrary, matchStandardClauses } = await import('../backend/services/standard-clause-service.js')
  const { saveParseSnapshot, resolveStoredContract, saveAnalysisRun, resolveAnalysisRun, contentFingerprint } = await import('../backend/services/contract-integrity-service.js')
  const { prepareManagedReport, exportManagedReport, buildVersionInput } = await import('../backend/services/report-management-service.js')
  const { recordOperation } = await import('../backend/services/mysql-operation-store.js')
  const { createDatabaseBackup, backupTables } = await import('../backend/services/mysql-backup-service.js')
  await syncRiskRuleLibrary(); await syncStandardClauseLibrary()
  await check('independent official contract regressions', async () => {
    const { parseContractDocument } = await import('../backend/services/document-parser.js')
    const fixtures = [
      ['dongguan-housing-rental-contract.docx', 75, 0],
      ['shanghai-affordable-rental-housing-contract.pdf', 75, 0],
      ['dongguan-market-management-service-contract.docx', 55, 1]
    ]
    for (const [file, minimum, maxMissing] of fixtures) {
      const parsed = await parseContractDocument({ originalname: file, buffer: await fs.readFile('tests/fixtures/external-contracts/' + file) })
      assert.equal(parsed.coverage.complete, true, file)
      const matched = await matchStandardClauses({ sourceFile: file, contractType: { predicted: '其他' }, paragraphStructure: parsed.paragraphs },
        { dependencies: { localReview: async () => ({ status: 'disabled', decisions: [] }) } })
      console.log(JSON.stringify({ fixture: file, score: matched.summary.completenessScore, missing: matched.summary.missing,
        incomplete: matched.items.filter((item) => item.status !== '完整').map((item) => ({ code: item.code, status: item.status, missing: item.missingRequirements })) }))
      assert.ok(matched.summary.completenessScore >= minimum, file + ': score below existing regression baseline')
      assert.ok(matched.summary.missing <= maxMissing, file + ': too many missing clauses')
    }
  })
  const fixture = {
    sourceFile: '脱敏合同 中文🙂引号"及单引号\'.docx', analysisState: 'ready',
    contractType: { predicted: '服务外包合同' },
    keyElements: { parties: '甲方：模拟科技有限公司；乙方：模拟服务有限公司', signedDate: '2026-09-15', amount: '人民币12345元',
      performancePeriod: '2026-09-15至2027-09-14', disputeResolution: '争议先协商，协商不成向约定人民法院起诉' },
    paragraphStructure: [
      '甲方为模拟科技有限公司，乙方为模拟服务有限公司，合同金额人民币12345元。',
      '第一条 保密条款',
      '保密信息包括商业秘密，保密期限为三年，仅用于履约使用，不得泄露。',
      '第二条 交付验收',
      '乙方交付软件成果，甲方按质量标准验收，交付后三个工作日内检查；不合格应整改。',
      '第三条 责任与争议',
      '乙方承担一切责任，赔偿甲方全部损失；双方发生争议先协商，协商不成向人民法院起诉。'
    ].map((content, i) => ({ index: i + 1, content, page: 1, charStart: i * 100, charEnd: i * 100 + content.length, sourceHash: 'a'.repeat(64) })),
    documentParsing: { parser: 'synthetic-test', textLength: 300, sourceHash: 'a'.repeat(64), warnings: ['脱敏测试：仅用于回归验证。'], coverage: { complete: true } },
    ai: { used: false, status: 'test_local' }, ocr: { required: false, status: 'not_required' }
  }
  const stored = await saveParseSnapshot(fixture)
  await check('snapshot tampering and arbitrary client data are rejected or ignored', async () => {
    assert.equal((await resolveStoredContract(stored)).parseSnapshotId, stored.parseSnapshotId)
    await assert.rejects(() => resolveStoredContract({ ...stored, sourceFile: '伪造合同.docx' }), /不一致/)
    const tampered = structuredClone(stored); tampered.paragraphStructure[0].content += '伪造新条款'
    await assert.rejects(() => resolveStoredContract(tampered), /不一致/)
    const changedFields = structuredClone(stored); changedFields.keyElements.amount = '伪造金额'
    assert.equal((await resolveStoredContract(changedFields)).keyElements.amount, fixture.keyElements.amount)
    await assert.rejects(() => resolveStoredContract({ ...stored, parseSnapshotId: crypto.randomUUID() }), /不存在/)
  })
  const disabled = async () => ({ status: 'disabled', decisions: [] })
  const audit = await saveAnalysisRun(stored, 'risk', await auditContractRisk(stored, { dependencies: { localReview: disabled } }))
  const match = await saveAnalysisRun(stored, 'standard', await matchStandardClauses(stored, { dependencies: { localReview: disabled } }))
  const other = await saveParseSnapshot({ ...fixture, sourceFile: '另一份合同.docx' })
  await check('analysis runs cannot be mixed between contracts or result kinds', async () => {
    await assert.rejects(() => resolveAnalysisRun(other, 'risk', audit.analysisRunId), /不属于/)
    await assert.rejects(() => resolveAnalysisRun(stored, 'standard', audit.analysisRunId), /不属于/)
  })
  let prepared
  await check('reports exactly reuse immutable reviewed results without invoking models', async () => {
    const oldFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('Unexpected model/network call while reusing runs') }
    try {
      prepared = await prepareManagedReport(stored, { auditRunId: audit.analysisRunId, matchRunId: match.analysisRunId, allowCloudReview: true })
    } finally { globalThis.fetch = oldFetch }
    assert.deepEqual(prepared.report.snapshot.audit, audit)
    assert.deepEqual(prepared.report.snapshot.match, match)
    assert.deepEqual(prepared.report.snapshot.contract.documentParsing, fixture.documentParsing)
    assert.equal(prepared.report.versionNumber, 1)
    const saved = await db.getManagedReport(prepared.report.id)
    assert.deepEqual(saved.snapshot.audit, audit)
    assert.deepEqual(saved.snapshot.match, match)
  })
  await check('inferred changes reuse content version; real content change creates next version', async () => {
    const changed = structuredClone(stored); changed.keyElements.amount = '另一模型金额'; changed.contractType.predicted = '采购合同'
    const same = await db.findOrCreateContractVersion(buildVersionInput(changed))
    assert.equal(same.created, false); assert.equal(same.version.id, prepared.version.id)
    changed.paragraphStructure.push({ index: 8, content: '双方另行约定每月结算。' })
    const next = await db.findOrCreateContractVersion(buildVersionInput(changed))
    assert.equal(next.version.versionNumber, 2)
  })
  await check('parallel version creation is idempotent and version numbers remain unique', async () => {
    const input = buildVersionInput({ ...stored, sourceFile: '并发版本测试.docx' })
    const same = await Promise.all(Array.from({ length: 8 }, () => db.findOrCreateContractVersion(input)))
    assert.equal(new Set(same.map((item) => item.version.id)).size, 1)
    const different = await Promise.all(Array.from({ length: 6 }, (_, i) => db.findOrCreateContractVersion(buildVersionInput({
      ...stored, sourceFile: '并发版本测试.docx', paragraphStructure: [...stored.paragraphStructure, { content: '新增独立正文内容' + i }]
    }))))
    assert.deepEqual(different.map((item) => item.version.versionNumber).sort((a, b) => a - b), [2,3,4,5,6,7])
  })
  await check('legacy model-dependent hash is reused only with matching persisted source evidence', async () => {
    const legacyContract = { ...fixture, sourceFile: '旧版内容指纹迁移.docx' }
    const input = buildVersionInput(legacyContract)
    const legacy = await db.findOrCreateContractVersion({ ...input, contentHash: 'f'.repeat(64) })
    await db.createManagedReport({ contractVersionId: legacy.version.id, sourceFile: legacyContract.sourceFile, contractType: '服务外包合同', snapshot: { contract: legacyContract } })
    const upgraded = await db.findOrCreateContractVersion(input)
    assert.equal(upgraded.version.id, legacy.version.id)
    assert.equal(upgraded.version.contentHash, contentFingerprint(legacyContract))
    assert.equal(upgraded.created, false)
  })
  await check('review state persists and all three reports export from the same snapshot', async () => {
    await db.updateManagedReportReview(prepared.report.id, '已人工确认', '脱敏回归：核对全部字段和证据。')
    const report = await db.getManagedReport(prepared.report.id)
    assert.equal(report.status, '已人工确认')
    await fs.mkdir('tmp/priority-repairs', { recursive: true })
    for (const format of ['word', 'pdf', 'html']) {
      const exported = await exportManagedReport(prepared.report.id, format)
      assert.ok(exported.buffer.length > 1000)
      if (format === 'word') assert.equal(exported.buffer.subarray(0, 2).toString(), 'PK')
      if (format === 'pdf') assert.equal(exported.buffer.subarray(0, 4).toString(), '%PDF')
      if (format === 'html') for (const value of Object.values(fixture.keyElements)) assert.ok(exported.buffer.toString('utf8').includes(value))
      await fs.writeFile('tmp/priority-repairs/qa-unified.' + exported.extension, exported.buffer)
    }
    await fs.writeFile('tmp/priority-repairs/expected-fields.json', JSON.stringify(fixture.keyElements, null, 2), 'utf8')
  })
  const special = { text: '中文🙂 "双引号" 单引号\' 反斜杠\\ Windows路径C:\\模拟\\合同.docx\n真实换行\t制表符\u0000空字符', list: [1, true, null] }
  await recordOperation('repair_synthetic_test', special)
  // Seed every otherwise-empty application table with schema-valid, entirely synthetic data.
  for (const table of backupTables) {
    const [count] = await pool.query('SELECT COUNT(*) AS n FROM ' + String.fromCharCode(96) + table + String.fromCharCode(96))
    if (Number(count[0].n)) continue
    const [columns] = await pool.query('SHOW COLUMNS FROM ' + String.fromCharCode(96) + table + String.fromCharCode(96))
    const selected = columns.filter((column) => !column.Extra.includes('auto_increment'))
    const values = selected.map((column) => {
      const type = column.Type.toLowerCase()
      if (type === 'json') return JSON.stringify(special)
      if (/^(?:tiny|small|medium|big)?int|decimal|float|double/.test(type)) return 1
      if (/datetime|timestamp/.test(type)) return '2026-09-15 12:34:56.123'
      if (/^date$/.test(type)) return '2026-09-15'
      if (/^enum/.test(type)) return type.match(/'([^']+)'/)[1]
      if (/char\(36\)/.test(type)) return crypto.randomUUID()
      if (/char\(64\)/.test(type)) return crypto.randomBytes(32).toString('hex')
      const limit = Number(type.match(/\((\d+)\)/)?.[1] || 999)
      return 'synthetic_测试'.slice(0, limit)
    })
    const names = selected.map((column) => String.fromCharCode(96) + column.Field + String.fromCharCode(96))
    await pool.execute('INSERT INTO ' + String.fromCharCode(96) + table + String.fromCharCode(96) + ' (' + names.join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')', values)
  }
  const backup = await createDatabaseBackup()
  await check('backup includes all application tables and never selects or drops a database', async () => {
    for (const table of backupTables) assert.ok(backup.includes('CREATE TABLE IF NOT EXISTS ' + String.fromCharCode(96) + table))
    assert.doesNotMatch(backup, /^(?:USE |DROP DATABASE|CREATE DATABASE)/m)
  })
  for (const mode of ['a', 'b']) await check('full SQL restore round-trip for all application tables in SQL mode ' + mode, async () => {
    const name = database + '_restore_' + mode
    await admin.query('CREATE DATABASE ' + quote(name) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created.add(name)
    const restore = await mysql.createConnection({ ...config, database: name, multipleStatements: true, dateStrings: true })
    restoreConnections.push(restore)
    if (mode === 'b') await restore.query("SET sql_mode='NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES'")
    await restore.query(backup)
    const source = await pool.getConnection()
    try {
      await source.query("SET time_zone='+00:00'")
      for (const table of backupTables) {
        const tableName = String.fromCharCode(96) + table + String.fromCharCode(96)
        const [columns] = await source.query('SHOW COLUMNS FROM ' + tableName)
        const order = columns.filter((column) => column.Key === 'PRI').map((column) => String.fromCharCode(96) + column.Field + String.fromCharCode(96)).join(',')
        const sql = 'SELECT * FROM ' + tableName + (order ? ' ORDER BY ' + order : '')
        const [original] = await source.query({ sql, dateStrings: true })
        const [restored] = await restore.query(sql)
        assert.deepEqual(restored, original, 'Restore differs: ' + table)
      }
    } finally { source.release() }
  })
  await fs.writeFile('tmp/priority-repairs/mysql-results.json', JSON.stringify({ databaseScope: 'temporary_isolated_databases_only', results, tablesRestored: backupTables.length, sqlModes: 2 }, null, 2), 'utf8')
  console.log(JSON.stringify({ passed: results.length, tablesRestored: backupTables.length, sqlModes: 2, artifactDirectory: 'tmp/priority-repairs' }))
} finally {
  for (const connection of restoreConnections) await connection.end()
  if (pool) await pool.end()
  // Only databases created and registered by this process can be removed.
  for (const name of [...created].reverse()) await admin.query('DROP DATABASE ' + quote(name))
  await admin.end()
}
