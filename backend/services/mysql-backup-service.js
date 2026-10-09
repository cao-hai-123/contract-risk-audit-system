import { pool } from '../db.js'

// Explicit project-owned table list: unrelated schemas and user tables are never exported.
export const backupTables = [
  'contract_parse_records', 'contract_risk_audit_records', 'operation_records',
  'risk_rule_library', 'standard_clause_library', 'standard_contract_sources',
  'contract_versions', 'managed_reports', 'semantic_vector_index',
  'famie_model_versions', 'risk_evaluation_runs', 'embedding_evaluation_runs',
  'contract_parse_snapshots', 'contract_analysis_runs',
  'real_contract_corpus_builds', 'real_contract_corpus_sources', 'real_contract_clause_evidence',
  'seal_reference_group', 'seal_reference_sample'
]
const identifier = (name) => '\u0060' + String(name).replace(/\u0060/g, '\u0060\u0060') + '\u0060'

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL'
  // Hex literals are independent of NO_BACKSLASH_ESCAPES and preserve UTF-8 JSON escapes.
  return "CONVERT(X'" + Buffer.from(String(value), 'utf8').toString('hex') + "' USING utf8mb4)"
}

export async function createDatabaseBackup({ databasePool = pool, onRow } = {}) {
  const connection = await databasePool.getConnection()
  const [timezone] = await connection.query('SELECT @@session.time_zone AS timezone')
  try {
    await connection.query("SET time_zone = '+00:00'")
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const lines = [
      '-- 应用数据库备份；外部文件请使用 npm run backup:full 配套备份。',
      '-- 请先选择独立目标数据库再导入。本文件不会创建、切换或删除数据库。',
      'SET NAMES utf8mb4;',
      "SET time_zone = '+00:00';"
    ]
    const [available] = await connection.query('SHOW TABLES')
    const tables = new Set(available.map((row) => Object.values(row)[0]))
    for (const table of backupTables) {
      if (!tables.has(table)) continue
      const [schema] = await connection.query('SHOW CREATE TABLE ' + identifier(table))
      lines.push(String(schema[0]['Create Table']).replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ') + ';')
      const [columns] = await connection.query('SHOW COLUMNS FROM ' + identifier(table))
      const [rows] = await connection.query({ sql: 'SELECT * FROM ' + identifier(table), dateStrings: true })
      const names = columns.map((column) => identifier(column.Field))
      const updates = columns.filter((column) => column.Key !== 'PRI').map((column) => identifier(column.Field) + '=VALUES(' + identifier(column.Field) + ')')
      for (const row of rows) {
        if (onRow) onRow(table, row)
        const values = columns.map((column) => {
          const value = row[column.Field]
          if (value === null) return 'NULL'
          if (column.Type.toLowerCase() === 'json') return sqlLiteral(typeof value === 'string' ? value : JSON.stringify(value))
          if (Buffer.isBuffer(value)) return "X'" + value.toString('hex') + "'"
          return sqlLiteral(value)
        })
        lines.push('INSERT INTO ' + identifier(table) + ' (' + names.join(',') + ') VALUES (' + values.join(',') + ')' +
          (updates.length ? ' ON DUPLICATE KEY UPDATE ' + updates.join(',') : '') + ';')
      }
    }
    await connection.commit()
    return lines.join('\n') + '\n'
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    try { await connection.query('SET time_zone = ?', [timezone[0].timezone]) }
    finally { connection.release() }
  }
}
