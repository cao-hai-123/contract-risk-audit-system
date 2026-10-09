import 'dotenv/config'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'

// Write only synthetic rows to a newly created, uniquely named test database.
const database = `contract_startup_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
assert.match(database, /^contract_startup_test_\d+_[a-f0-9]{8}$/)
const quotedDatabase = '`' + database + '`'
const config = {
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', charset: 'utf8mb4'
}
const receipt = { checkedAt: new Date().toISOString(), database, results: [], cleanedUp: false }
const check = async (name, run) => { await run(); receipt.results.push({ name, passed: true }); console.log('PASS ' + name) }
let admin, writerPool, created = false
try {
  admin = await mysql.createConnection(config)
  const [settings] = await admin.query('SELECT VERSION() AS version, @@global.log_bin AS logBin, @@global.binlog_error_action AS errorAction, @@session.sql_log_bin AS sessionLogBin, @@global.sync_binlog AS syncBinlog, @@global.innodb_flush_log_at_trx_commit AS innodbFlush')
  receipt.settings = settings[0]
  await check('binary logging and ABORT_SERVER protection remain enabled', async () => {
    assert.equal(Number(receipt.settings.logBin), 1)
    assert.equal(Number(receipt.settings.sessionLogBin), 1)
    assert.equal(receipt.settings.errorAction, 'ABORT_SERVER')
  })
  const binaryLogPosition = async () => {
    // MySQL 8.0 uses the old statement; 8.4 and 9.x use the new one.
    const legacy = /^8\.0\./.test(receipt.settings.version)
    const [rows] = await admin.query(legacy ? 'SHOW MASTER STATUS' : 'SHOW BINARY LOG STATUS')
    assert.ok(rows[0], 'No binary-log position returned')
    return { file: rows[0].File, position: Number(rows[0].Position) }
  }
  await admin.query('CREATE DATABASE ' + quotedDatabase + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
  created = true
  await admin.query('CREATE TABLE ' + quotedDatabase + '.commit_probe (id INT PRIMARY KEY, payload JSON NOT NULL) ENGINE=InnoDB')
  writerPool = mysql.createPool({ ...config, database, connectionLimit: 4 })
  // Measure after DDL so schema creation cannot masquerade as successful transaction logging.
  receipt.before = await binaryLogPosition()
  const fixture = (id) => ({ id, sourceFile: '模拟启动回归合同🙂.docx', text: '模拟条款：中文、引号"、单引号\'与反斜杠\\。' })
  await check('32 transactions commit through four independent MySQL connections', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, async (_, worker) => {
      const connection = await writerPool.getConnection()
      try {
        const [[session]] = await connection.query('SELECT @@session.sql_log_bin AS enabled')
        assert.equal(Number(session.enabled), 1)
        for (let step = 0; step < 8; step++) {
          const id = worker * 8 + step
          await connection.beginTransaction()
          await connection.execute('INSERT INTO commit_probe (id, payload) VALUES (?, ?)', [id, JSON.stringify(fixture(id))])
          await connection.commit()
        }
      } catch (error) {
        await connection.rollback().catch(() => {})
        throw error
      } finally { connection.release() }
    }))
    for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled', outcome.reason?.code || outcome.reason?.message)
  })
  await check('fresh connection reads every committed UTF-8 JSON value exactly', async () => {
    const reader = await mysql.createConnection({ ...config, database })
    try {
      const [rows] = await reader.query('SELECT id, payload FROM commit_probe ORDER BY id')
      assert.equal(rows.length, 32)
      for (const row of rows) assert.deepEqual(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, fixture(row.id))
    } finally { await reader.end() }
  })
  await check('rollback does not persist an uncommitted row', async () => {
    const connection = await writerPool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('INSERT INTO commit_probe (id, payload) VALUES (?, ?)', [100, JSON.stringify(fixture(100))])
      await connection.rollback()
      const [[row]] = await admin.query('SELECT COUNT(*) AS count FROM ' + quotedDatabase + '.commit_probe WHERE id = 100')
      assert.equal(Number(row.count), 0)
    } finally { connection.release() }
  })
  receipt.after = await binaryLogPosition()
  await check('binary-log position advances after real commits and server remains available', async () => {
    assert.ok(receipt.after.file !== receipt.before.file || receipt.after.position > receipt.before.position)
    const [[settingsAfter]] = await admin.query('SELECT @@global.log_bin AS enabled, @@global.binlog_error_action AS action')
    assert.equal(Number(settingsAfter.enabled), 1)
    assert.equal(settingsAfter.action, 'ABORT_SERVER')
    await admin.ping()
  })
} catch (error) {
  receipt.failure = { code: error.code || 'test_failed', message: 'Startup MySQL regression did not complete.' }
  console.error('FAIL startup MySQL regression:', receipt.failure.code)
  process.exitCode = 1
} finally {
  await writerPool?.end()
  try {
    // Cleanup requires both the strict generated name and confirmed creation in this run.
    if (created) {
      await admin.query('DROP DATABASE ' + quotedDatabase)
      const [remaining] = await admin.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database])
      assert.equal(remaining.length, 0)
      receipt.cleanedUp = true
    }
  } finally {
    await admin?.end()
    await fs.mkdir('tmp/startup-recovery', { recursive: true })
    await fs.writeFile('tmp/startup-recovery/mysql-commit-check.json', JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  }
}
