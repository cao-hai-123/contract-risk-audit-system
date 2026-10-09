import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config()

const databaseName = process.env.DB_NAME || 'contract_audit'
const connectionOptions = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || ''
}
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const famieModelDirectory = path.join(projectRoot, 'models', 'famie', 'registered')

export const pool = mysql.createPool({
  ...connectionOptions,
  database: databaseName,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
})

export async function initializeDatabase() {
  const admin = await mysql.createConnection({ ...connectionOptions, charset: 'utf8mb4' })
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } finally {
    await admin.end()
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS contract_parse_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      file_name VARCHAR(255) NOT NULL,
      file_type VARCHAR(32) NOT NULL,
      contract_type VARCHAR(80) NOT NULL,
      key_elements_json JSON NOT NULL,
      paragraph_json JSON NOT NULL,
      ocr_confidence DECIMAL(5, 4) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS contract_risk_audit_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      file_name VARCHAR(255) NOT NULL,
      contract_type VARCHAR(80) NOT NULL,
      overall_level VARCHAR(8) NOT NULL,
      risk_score TINYINT UNSIGNED NOT NULL,
      audit_json JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS operation_records (
      id CHAR(36) NOT NULL PRIMARY KEY,
      operation_type VARCHAR(64) NOT NULL,
      payload_json JSON NOT NULL,
      archived_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX idx_operation_created_at (created_at DESC),
      INDEX idx_operation_type_archived (operation_type, archived_at)
    )`,
    `CREATE TABLE IF NOT EXISTS risk_rule_library (
      rule_code VARCHAR(80) NOT NULL PRIMARY KEY,
      category VARCHAR(80) NOT NULL,
      title VARCHAR(160) NOT NULL,
      default_level VARCHAR(8) NOT NULL,
      rule_kind VARCHAR(24) NOT NULL,
      matcher_json JSON NOT NULL,
      reason_text TEXT NOT NULL,
      suggestion_text TEXT NOT NULL,
      source_note VARCHAR(255) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      updated_at DATETIME(3) NOT NULL,
      INDEX idx_risk_rule_active (is_active, rule_kind)
    )`,
    `CREATE TABLE IF NOT EXISTS risk_evaluation_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      dataset_name VARCHAR(80) NOT NULL,
      dataset_version VARCHAR(80) NULL,
      evaluator VARCHAR(80) NOT NULL,
      metrics_json JSON NOT NULL,
      notes TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX idx_risk_evaluation_dataset (dataset_name, created_at DESC)
    )`,
    `CREATE TABLE IF NOT EXISTS embedding_evaluation_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      model_name VARCHAR(160) NOT NULL,
      model_version VARCHAR(160) NOT NULL,
      embedding_dimension SMALLINT UNSIGNED NOT NULL,
      dataset_name VARCHAR(100) NOT NULL,
      metrics_json JSON NOT NULL,
      notes TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX idx_embedding_evaluation_model (model_name, created_at DESC)
    )`,
    `CREATE TABLE IF NOT EXISTS contract_versions (
      id CHAR(36) NOT NULL PRIMARY KEY,
      contract_key CHAR(64) NOT NULL,
      version_number INT UNSIGNED NOT NULL,
      source_file VARCHAR(255) NOT NULL,
      content_hash CHAR(64) NOT NULL,
      change_summary VARCHAR(500) NOT NULL,
      summary_json JSON NOT NULL,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_contract_version_content (contract_key, content_hash),
      UNIQUE KEY uq_contract_version_number (contract_key, version_number),
      INDEX idx_contract_version_file (source_file, created_at DESC)
    )`,
    `CREATE TABLE IF NOT EXISTS managed_reports (
      id CHAR(36) NOT NULL PRIMARY KEY,
      contract_version_id CHAR(36) NOT NULL,
      source_file VARCHAR(255) NOT NULL,
      contract_type VARCHAR(80) NOT NULL,
      report_status VARCHAR(32) NOT NULL,
      reviewer_note VARCHAR(1000) NOT NULL DEFAULT '',
      review_updated_at DATETIME(3) NULL,
      report_json JSON NOT NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX idx_managed_report_version (contract_version_id, created_at DESC),
      INDEX idx_managed_report_status (report_status, created_at DESC)
    )`,
    `CREATE TABLE IF NOT EXISTS standard_contract_sources (
      source_key VARCHAR(255) NOT NULL PRIMARY KEY,
      file_name VARCHAR(255) NOT NULL,
      file_type VARCHAR(16) NOT NULL,
      contract_type_hint VARCHAR(80) NOT NULL,
      parse_status VARCHAR(32) NOT NULL,
      text_length INT UNSIGNED NOT NULL DEFAULT 0,
      warnings_json JSON NOT NULL,
      analyzed_at DATETIME(3) NOT NULL,
      INDEX idx_standard_source_status (parse_status, analyzed_at DESC)
    )`,
    `CREATE TABLE IF NOT EXISTS standard_clause_library (
      clause_code VARCHAR(100) NOT NULL PRIMARY KEY,
      category VARCHAR(80) NOT NULL,
      title VARCHAR(160) NOT NULL,
      keywords_json JSON NOT NULL,
      requirements_json JSON NOT NULL,
      applicable_types_json JSON NOT NULL,
      suggestion_text TEXT NOT NULL,
      source_count INT UNSIGNED NOT NULL DEFAULT 0,
      source_examples_json JSON NOT NULL,
      origin VARCHAR(80) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      updated_at DATETIME(3) NOT NULL,
      INDEX idx_standard_clause_active (is_active, category)
    )`,
    `CREATE TABLE IF NOT EXISTS famie_model_versions (
      id CHAR(36) NOT NULL PRIMARY KEY,
      version_name VARCHAR(120) NOT NULL,
      original_file_name VARCHAR(255) NOT NULL,
      stored_file_name VARCHAR(255) NOT NULL,
      byte_length BIGINT UNSIGNED NOT NULL,
      sha256 CHAR(64) NOT NULL,
      model_status VARCHAR(48) NOT NULL,
      notes TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX idx_famie_model_created (created_at DESC),
      INDEX idx_famie_model_status (model_status)
    )`,
    `CREATE TABLE IF NOT EXISTS semantic_vector_index (
      source_hash CHAR(64) NOT NULL PRIMARY KEY,
      source_kind VARCHAR(24) NOT NULL,
      source_key VARCHAR(255) NOT NULL,
      source_title VARCHAR(500) NOT NULL,
      source_text MEDIUMTEXT NOT NULL,
      embedding_json JSON NOT NULL,
      embedding_model VARCHAR(160) NOT NULL,
      embedding_model_version VARCHAR(160) NOT NULL,
      embedding_dimension SMALLINT UNSIGNED NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      INDEX idx_semantic_source_kind (source_kind, updated_at DESC),
      INDEX idx_semantic_source_key (source_key)
    )`
  ]

  for (const statement of statements) await pool.query(statement)
  const { sealSchema } = await import('./services/seal-repository.js')
  for (const statement of sealSchema) await pool.query(statement)
  const { integritySchema } = await import('./services/contract-integrity-service.js')
  for (const statement of integritySchema) await pool.query(statement)
  await ensureSemanticVectorIndexMetadata()
  for (const table of ['standard_clause_library', 'standard_contract_sources']) {
    const [columns] = await pool.query('SHOW COLUMNS FROM ' + table)
    if (!columns.some((c) => c.Field === 'metadata_json')) await pool.query('ALTER TABLE ' + table + ' ADD COLUMN metadata_json JSON NULL')
  }
}

async function ensureSemanticVectorIndexMetadata() {
  const [columns] = await pool.query('SHOW COLUMNS FROM semantic_vector_index')
  const names = new Set(columns.map((column) => column.Field))
  if (!names.has('embedding_model_version')) {
    await pool.query("ALTER TABLE semantic_vector_index ADD COLUMN embedding_model_version VARCHAR(160) NOT NULL DEFAULT 'legacy' AFTER embedding_model")
  }
  if (!names.has('embedding_dimension')) {
    await pool.query('ALTER TABLE semantic_vector_index ADD COLUMN embedding_dimension SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER embedding_model_version')
  }
}

export async function saveContractParseRecord(record) {
  await pool.execute(
    `INSERT INTO contract_parse_records
      (file_name, file_type, contract_type, key_elements_json, paragraph_json, ocr_confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [record.fileName, record.fileType, record.contractType, JSON.stringify(record.keyElements), JSON.stringify(record.paragraphStructure), record.ocrConfidence]
  )
}

export async function saveRiskAuditRecord(record) {
  await pool.execute(
    `INSERT INTO contract_risk_audit_records
      (file_name, contract_type, overall_level, risk_score, audit_json)
     VALUES (?, ?, ?, ?, ?)`,
    [record.fileName, record.contractType, record.overallLevel, record.riskScore, JSON.stringify(record.audit)]
  )
}

export async function saveRiskRuleDefinitions(rules) {
  const now = new Date()
  for (const rule of rules) {
    await pool.execute(
      `INSERT INTO risk_rule_library
        (rule_code, category, title, default_level, rule_kind, matcher_json, reason_text, suggestion_text, source_note, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE category = VALUES(category), title = VALUES(title), default_level = VALUES(default_level),
         rule_kind = VALUES(rule_kind), matcher_json = VALUES(matcher_json), reason_text = VALUES(reason_text),
         suggestion_text = VALUES(suggestion_text), source_note = VALUES(source_note), is_active = 1, updated_at = VALUES(updated_at)`,
      [rule.id, rule.category, rule.title, rule.level, rule.kind, JSON.stringify(rule.matcher), rule.reason, rule.suggestion, rule.sourceNote, now]
    )
  }
}

export async function saveRiskEvaluationRun(run) {
  await pool.execute(
    `INSERT INTO risk_evaluation_runs (dataset_name, dataset_version, evaluator, metrics_json, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [run.datasetName, run.datasetVersion || null, run.evaluator, JSON.stringify(run.metrics), run.notes || null, new Date()]
  )
}

export async function saveEmbeddingEvaluationRun(run) {
  await pool.execute(
    `INSERT INTO embedding_evaluation_runs (model_name, model_version, embedding_dimension, dataset_name, metrics_json, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [run.modelName, run.modelVersion, run.dimension, run.datasetName, JSON.stringify(run.metrics), run.notes || null, new Date()]
  )
}

export async function findOrCreateContractVersion(version) {
  const connection = await pool.getConnection()
  const lockName = 'cv:' + version.contractKey.slice(0, 60)
  let locked = false
  try {
    const [locks] = await connection.execute('SELECT GET_LOCK(?, 15) AS acquired', [lockName])
    if (Number(locks[0].acquired) !== 1) throw Object.assign(new Error('版本正在更新，请稍后重试。'), { status: 409 })
    locked = true
    await connection.beginTransaction()
    const [existing] = await connection.execute('SELECT * FROM contract_versions WHERE contract_key = ? AND content_hash = ? LIMIT 1', [version.contractKey, version.contentHash])
    if (existing[0]) {
      await connection.commit()
      return { version: mapContractVersion(existing[0]), created: false }
    }
    // Upgrade a legacy fingerprint only when a persisted report proves identical recognized text.
    const [legacy] = await connection.execute('SELECT v.*, r.report_json FROM contract_versions v JOIN managed_reports r ON r.contract_version_id = v.id WHERE v.contract_key = ?', [version.contractKey])
    // Never filesort full JSON snapshots; preserve earliest-version migration in memory.
    legacy.sort((a, b) => Number(a.version_number) - Number(b.version_number) || a.id.localeCompare(b.id))
    const { contentFingerprint } = await import('./services/contract-integrity-service.js')
    for (const row of legacy) {
      const snapshot = typeof row.report_json === 'string' ? JSON.parse(row.report_json) : row.report_json
      if (snapshot?.contract?.paragraphStructure?.length && contentFingerprint(snapshot.contract) === version.contentHash) {
        await connection.execute('UPDATE contract_versions SET content_hash = ? WHERE id = ?', [version.contentHash, row.id])
        await connection.commit()
        return { version: mapContractVersion({ ...row, content_hash: version.contentHash }), created: false }
      }
    }
    const [latest] = await connection.execute('SELECT COALESCE(MAX(version_number), 0) AS last_version FROM contract_versions WHERE contract_key = ?', [version.contractKey])
    const versionNumber = Number(latest[0].last_version) + 1
    const id = crypto.randomUUID()
    const now = new Date()
    await connection.execute('INSERT INTO contract_versions (id, contract_key, version_number, source_file, content_hash, change_summary, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, version.contractKey, versionNumber, version.sourceFile, version.contentHash, version.changeSummary, JSON.stringify(version.summary), now])
    await connection.commit()
    return { version: { id, ...version, versionNumber, createdAt: now.toISOString() }, created: true }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]) }
    finally { connection.release() }
  }
}

export async function createManagedReport(report) {
  const id = crypto.randomUUID()
  const createdAt = new Date()
  await pool.execute(
    `INSERT INTO managed_reports (id, contract_version_id, source_file, contract_type, report_status, reviewer_note, review_updated_at, report_json, created_at)
     VALUES (?, ?, ?, ?, ?, '', NULL, ?, ?)`,
    [id, report.contractVersionId, report.sourceFile, report.contractType, '待人工确认', JSON.stringify(report.snapshot), createdAt]
  )
  return { id, contractVersionId: report.contractVersionId, sourceFile: report.sourceFile, contractType: report.contractType, status: '待人工确认', reviewerNote: '', reviewUpdatedAt: null, snapshot: report.snapshot, createdAt: createdAt.toISOString() }
}

export async function listManagedReports(limit = 40) {
  const safeLimit = Math.trunc(Math.min(Math.max(Number(limit) || 40, 1), 200))
  // Select only narrow keys during sorting: a single report JSON can exceed
  // MySQL's entire sort buffer. Fetch snapshots without ORDER BY afterwards.
  const [keys] = await pool.execute(
    `SELECT r.id FROM managed_reports r JOIN contract_versions v ON v.id = r.contract_version_id
     ORDER BY r.created_at DESC, r.id DESC LIMIT ?`, [safeLimit]
  )
  if (!keys.length) return []
  const [rows] = await pool.execute(
    `SELECT r.id, r.contract_version_id, r.source_file, r.contract_type, r.report_status, r.reviewer_note, r.review_updated_at, r.report_json, r.created_at,
            v.version_number, v.change_summary
     FROM managed_reports r JOIN contract_versions v ON v.id = r.contract_version_id
     WHERE r.id IN (${keys.map(() => '?').join(',')})`,
    keys.map((row) => row.id)
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  return keys.flatMap(({ id }) => byId.has(id) ? [mapManagedReport(byId.get(id))] : [])
}

export async function getManagedReport(id) {
  const [rows] = await pool.execute(
    `SELECT r.id, r.contract_version_id, r.source_file, r.contract_type, r.report_status, r.reviewer_note, r.review_updated_at, r.report_json, r.created_at,
            v.version_number, v.change_summary
     FROM managed_reports r JOIN contract_versions v ON v.id = r.contract_version_id
     WHERE r.id = ? LIMIT 1`,
    [String(id || '')]
  )
  return rows[0] ? mapManagedReport(rows[0]) : null
}

export async function updateManagedReportReview(id, status, note) {
  const allowed = new Set(['待人工确认', '已人工确认', '需复核'])
  if (!allowed.has(status)) throw new Error('不支持的报告复核状态。')
  await pool.execute(
    `UPDATE managed_reports SET report_status = ?, reviewer_note = ?, review_updated_at = ? WHERE id = ?`,
    [status, String(note || '').trim().slice(0, 1000), new Date(), String(id || '')]
  )
  return getManagedReport(id)
}

export async function listContractVersions(limit = 100) {
  const safeLimit = Math.trunc(Math.min(Math.max(Number(limit) || 100, 1), 300))
  const [keys] = await pool.execute('SELECT id FROM contract_versions ORDER BY created_at DESC, id DESC LIMIT ?', [safeLimit])
  if (!keys.length) return []
  const [rows] = await pool.execute(
    `SELECT v.id, v.contract_key, v.version_number, v.source_file, v.content_hash, v.change_summary, v.summary_json, v.created_at,
            (SELECT COUNT(*) FROM managed_reports r WHERE r.contract_version_id = v.id) AS report_count,
            (SELECT MAX(r.created_at) FROM managed_reports r WHERE r.contract_version_id = v.id) AS last_report_at,
            (SELECT r.report_status FROM managed_reports r WHERE r.contract_version_id = v.id
             ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS latest_report_status
     FROM contract_versions v WHERE v.id IN (${keys.map(() => '?').join(',')})`,
    keys.map((row) => row.id)
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  return keys.flatMap(({ id }) => {
    const row = byId.get(id)
    return row ? [{ ...mapContractVersion(row), reportCount: Number(row.report_count || 0), lastReportAt: row.last_report_at ? new Date(row.last_report_at).toISOString() : null, latestReportStatus: row.latest_report_status || '尚未生成报告' }] : []
  })
}

function mapContractVersion(row) {
  return {
    id: row.id,
    contractKey: row.contract_key,
    versionNumber: Number(row.version_number),
    sourceFile: row.source_file,
    contentHash: row.content_hash,
    changeSummary: row.change_summary,
    summary: typeof row.summary_json === 'string' ? JSON.parse(row.summary_json) : row.summary_json,
    createdAt: new Date(row.created_at).toISOString()
  }
}

function mapManagedReport(row) {
  return {
    id: row.id,
    contractVersionId: row.contract_version_id,
    sourceFile: row.source_file,
    contractType: row.contract_type,
    status: row.report_status,
    reviewerNote: row.reviewer_note || '',
    reviewUpdatedAt: row.review_updated_at ? new Date(row.review_updated_at).toISOString() : null,
    snapshot: typeof row.report_json === 'string' ? JSON.parse(row.report_json) : row.report_json,
    createdAt: new Date(row.created_at).toISOString(),
    versionNumber: Number(row.version_number || 0),
    changeSummary: row.change_summary || '初始版本'
  }
}

export async function saveStandardContractSources(sources, executor = pool) {
  const now = new Date()
  for (const source of sources) {
    await executor.execute(
      `INSERT INTO standard_contract_sources
        (source_key, file_name, file_type, contract_type_hint, parse_status, text_length, warnings_json, analyzed_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE file_name = VALUES(file_name), file_type = VALUES(file_type), contract_type_hint = VALUES(contract_type_hint),
         parse_status = VALUES(parse_status), text_length = VALUES(text_length), warnings_json = VALUES(warnings_json), analyzed_at = VALUES(analyzed_at), metadata_json = VALUES(metadata_json)`,
      [source.sourceKey, source.fileName, source.fileType, source.contractTypeHint, source.parseStatus, source.textLength, JSON.stringify(source.warnings || []), now, JSON.stringify(source.metadata || {})]
    )
  }
}

export async function saveStandardClauseDefinitions(clauses, executor = pool) {
  const now = new Date()
  for (const clause of clauses) {
    await executor.execute(
      `INSERT INTO standard_clause_library
        (clause_code, category, title, keywords_json, requirements_json, applicable_types_json, suggestion_text, source_count, source_examples_json, origin, is_active, updated_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE category = VALUES(category), title = VALUES(title), keywords_json = VALUES(keywords_json), requirements_json = VALUES(requirements_json),
         applicable_types_json = VALUES(applicable_types_json), suggestion_text = VALUES(suggestion_text), source_count = VALUES(source_count),
         source_examples_json = VALUES(source_examples_json), origin = VALUES(origin), is_active = 1, updated_at = VALUES(updated_at), metadata_json = VALUES(metadata_json)`,
      [clause.code, clause.category, clause.title, JSON.stringify(clause.keywords), JSON.stringify(clause.requirements), JSON.stringify(clause.applicableTypes), clause.suggestion, clause.sourceCount || 0, JSON.stringify(clause.sourceExamples || []), clause.origin || '内置基线', now, JSON.stringify(clause.metadata || {})]
    )
  }
}

export async function getStandardClauseDefinitions() {
  const [rows] = await pool.execute(
    `SELECT clause_code, category, title, keywords_json, requirements_json, applicable_types_json, suggestion_text, source_count, source_examples_json, origin, metadata_json
     FROM standard_clause_library WHERE is_active = 1 ORDER BY category, clause_code`
  )
  return rows.map((row) => ({
    code: row.clause_code,
    category: row.category,
    title: row.title,
    keywords: typeof row.keywords_json === 'string' ? JSON.parse(row.keywords_json) : row.keywords_json,
    requirements: typeof row.requirements_json === 'string' ? JSON.parse(row.requirements_json) : row.requirements_json,
    applicableTypes: typeof row.applicable_types_json === 'string' ? JSON.parse(row.applicable_types_json) : row.applicable_types_json,
    suggestion: row.suggestion_text,
    sourceCount: Number(row.source_count || 0),
    sourceExamples: typeof row.source_examples_json === 'string' ? JSON.parse(row.source_examples_json) : row.source_examples_json,
    origin: row.origin,
    metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json || {}
  }))
}

export async function listFamieModelVersions() {
  const [rows] = await pool.execute(
    `SELECT id, version_name, original_file_name, byte_length, sha256, model_status, notes, created_at
     FROM famie_model_versions ORDER BY created_at DESC`
  )
  return rows.map((row) => ({
    id: row.id,
    versionName: row.version_name,
    originalFileName: row.original_file_name,
    byteLength: Number(row.byte_length || 0),
    sha256: row.sha256,
    status: row.model_status,
    notes: row.notes || '',
    createdAt: new Date(row.created_at).toISOString()
  }))
}

export async function registerFamieModelVersion({ file, versionName, notes }) {
  if (!file?.buffer?.length) throw new Error('未收到可登记的 FAMIE 模型文件。')
  const id = crypto.randomUUID()
  const extension = path.extname(file.originalname || '').toLowerCase()
  if (extension !== '.ckpt') throw new Error('仅支持登记 FAMIE 导出的 .ckpt 模型文件。')

  const safeName = `${id}${extension}`
  const digest = crypto.createHash('sha256').update(file.buffer).digest('hex')
  await fs.mkdir(famieModelDirectory, { recursive: true })
  await fs.writeFile(path.join(famieModelDirectory, safeName), file.buffer)

  try {
    await pool.execute(
      `INSERT INTO famie_model_versions
        (id, version_name, original_file_name, stored_file_name, byte_length, sha256, model_status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        String(versionName || path.basename(file.originalname, extension)).slice(0, 120),
        String(file.originalname || 'famie-model.ckpt').slice(0, 255),
        safeName,
        file.buffer.length,
        digest,
        'registered_unvalidated',
        String(notes || '').slice(0, 4000),
        new Date()
      ]
    )
  } catch (error) {
    await fs.rm(path.join(famieModelDirectory, safeName), { force: true })
    throw error
  }

  return {
    id,
    versionName: String(versionName || path.basename(file.originalname, extension)).slice(0, 120),
    originalFileName: file.originalname,
    byteLength: file.buffer.length,
    sha256: digest,
    status: 'registered_unvalidated',
    notes: String(notes || '').slice(0, 4000),
    createdAt: new Date().toISOString()
  }
}

export async function closeDatabase() {
  await pool.end()
}

export async function publishTemplateLibrary(sources, clauses) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    // This table contains generated library provenance only, never operation history.
    await connection.query('DELETE FROM standard_contract_sources')
    await saveStandardContractSources(sources, connection)
    await saveStandardClauseDefinitions(clauses, connection)
    await connection.commit()
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}

export async function getRiskRuleDefinitions() {
  const [rows] = await pool.query('SELECT * FROM risk_rule_library WHERE is_active = 1 ORDER BY rule_code')
  return rows.map((row) => {
    const matcher = typeof row.matcher_json === 'string' ? JSON.parse(row.matcher_json) : row.matcher_json
    return { id: row.rule_code, category: row.category, title: row.title, level: row.default_level, kind: row.rule_kind,
      matcher, keywords: matcher.keywords || [], pattern: row.rule_kind === 'pattern' ? new RegExp(matcher.pattern, matcher.flags || '') : undefined,
      reason: row.reason_text, suggestion: row.suggestion_text, sourceNote: row.source_note }
  })
}
