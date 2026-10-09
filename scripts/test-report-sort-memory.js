import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import fs from 'node:fs/promises'
dotenv.config()

// Synthetic records only, in a database created and removed by this process.
const database = 'contract_sort_test_' + Date.now()
assert.match(database, /^contract_sort_test_\d+$/)
const quoted = '`' + database + '`'
const admin = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' })
process.env.DB_NAME = database
let created = false, pool
const results = []
const check = async (name, run) => { await run(); results.push({ name, passed: true }); console.log('PASS ' + name) }
try {
  await admin.query('CREATE DATABASE ' + quoted + ' CHARACTER SET utf8mb4'); created = true
  const db = await import('../backend/db.js'); pool = db.pool
  await db.initializeDatabase()
  // Set every pool session, never the global/server configuration.
  const sessions = await Promise.all(Array.from({ length: 10 }, () => pool.getConnection()))
  try { for (const session of sessions) await session.query('SET SESSION sort_buffer_size = 262144') }
  finally { sessions.forEach((session) => session.release()) }
  await check('empty lists', async () => {
    assert.deepEqual(await db.listManagedReports(), [])
    assert.deepEqual(await db.listContractVersions(), [])
  })
  const padding = '模拟条款，仅供回归测试。'.repeat(24000)
  const expected = new Map(), versions = []
  for (let i = 0; i < 12; i++) {
    const id = 'version-' + String(i).padStart(3, '0')
    versions.push(id)
    await pool.execute('INSERT INTO contract_versions (id, contract_key, version_number, source_file, content_hash, change_summary, summary_json, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
      [id, String(i).padStart(64, '0'), '模拟合同.docx', 'a'.repeat(64), '模拟版本', JSON.stringify({ padding }), new Date('2026-01-01')])
    for (let j = 0; j < 2; j++) {
      const report = await db.createManagedReport({ contractVersionId: id, sourceFile: '模拟合同.docx', contractType: '其他', snapshot: { padding, sequence: i * 2 + j } })
      expected.set(report.id, report.snapshot)
      await pool.execute('UPDATE managed_reports SET created_at = ? WHERE id = ?', [new Date('2026-01-01'), report.id])
    }
  }
  const ids = [...expected.keys()].sort().reverse()
  await check('original query reproduces ER_OUT_OF_SORTMEMORY at 256 KiB', async () => {
    await assert.rejects(() => pool.query(`SELECT r.*, v.version_number FROM managed_reports r JOIN contract_versions v ON v.id = r.contract_version_id ORDER BY r.created_at DESC LIMIT 40`), { code: 'ER_OUT_OF_SORTMEMORY' })
  })
  await check('large report lists preserve snapshots, stable order and limits', async () => {
    for (const limit of [1, 7, 7.9, 40, 200]) {
      const rows = await db.listManagedReports(limit)
      assert.deepEqual(rows.map((row) => row.id), ids.slice(0, Math.trunc(limit)))
      for (const row of rows) assert.deepEqual(row.snapshot, expected.get(row.id))
    }
    assert.deepEqual((await db.getManagedReport(ids[0])).snapshot, expected.get(ids[0]))
  })
  await check('large version summaries and latest review status survive small sort buffer', async () => {
    await db.updateManagedReportReview(ids[0], '已人工确认', '模拟复核')
    const latest = await db.getManagedReport(ids[0])
    const rows = await db.listContractVersions(100)
    assert.deepEqual(rows.map((row) => row.id), [...versions].reverse())
    for (const row of rows) {
      assert.equal(row.summary.padding, padding)
      assert.equal(row.reportCount, 2)
      assert.equal(row.latestReportStatus, row.id === latest.contractVersionId ? '已人工确认' : '待人工确认')
    }
    assert.equal((await db.listContractVersions(2.9)).length, 2)
  })
  await check('different timestamps take precedence over the ID tie breaker', async () => {
    await pool.execute('UPDATE managed_reports SET created_at = ? WHERE id = ?', [new Date('2026-02-01'), ids.at(-1)])
    assert.equal((await db.listManagedReports(1))[0].id, ids.at(-1))
    await pool.execute('UPDATE contract_versions SET created_at = ? WHERE id = ?', [new Date('2026-02-01'), versions[0]])
    assert.equal((await db.listContractVersions(1))[0].id, versions[0])
  })
  await check('version with no reports remains visible', async () => {
    await pool.execute('DELETE FROM managed_reports WHERE contract_version_id = ?', [versions[0]])
    const row = (await db.listContractVersions(1))[0]
    assert.equal(row.reportCount, 0); assert.equal(row.lastReportAt, null); assert.equal(row.latestReportStatus, '尚未生成报告')
  })
  await check('legacy fingerprint migration reads large snapshots without database JSON sorting', async () => {
    const { contentFingerprint } = await import('../backend/services/contract-integrity-service.js')
    const contract = { paragraphStructure: [{ content: padding }] }
    await pool.execute('UPDATE managed_reports SET report_json = ? WHERE contract_version_id = ?', [JSON.stringify({ contract }), versions[1]])
    const migrated = await db.findOrCreateContractVersion({ contractKey: '1'.padStart(64, '0'), contentHash: contentFingerprint(contract), sourceFile: '模拟合同.docx', changeSummary: '模拟版本', summary: { padding } })
    assert.equal(migrated.created, false)
    assert.equal(migrated.version.id, versions[1])
    assert.equal(migrated.version.contentHash, contentFingerprint(contract))
  })
  await fs.mkdir('tmp/report-sort-repair', { recursive: true })
  await fs.writeFile('tmp/report-sort-repair/regression-results.json', JSON.stringify({ checkedAt: new Date().toISOString(), sortBufferBytes: 262144, snapshotBytes: Buffer.byteLength(JSON.stringify({ padding })), databaseScope: 'isolated_synthetic_only', results }, null, 2))
} finally {
  if (pool) await pool.end()
  if (created) await admin.query('DROP DATABASE ' + quoted)
  await admin.end()
}
