import crypto from 'node:crypto'
import { pool } from '../db.js'
import { assertUsableContract, recognizedText } from '../../shared/contract-content.js'

export const integritySchema = [
  `CREATE TABLE IF NOT EXISTS contract_parse_snapshots (
    id CHAR(36) PRIMARY KEY, source_file VARCHAR(255) NOT NULL, content_hash CHAR(64) NOT NULL,
    contract_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
    INDEX idx_parse_snapshot_created (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS contract_analysis_runs (
    id CHAR(36) PRIMARY KEY, parse_snapshot_id CHAR(36) NOT NULL, analysis_kind VARCHAR(32) NOT NULL,
    content_hash CHAR(64) NOT NULL, result_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
    INDEX idx_analysis_parse_kind (parse_snapshot_id, analysis_kind, created_at)
  )`
]

export const contentFingerprint = (contract) => crypto.createHash('sha256').update(recognizedText(contract)).digest('hex')
const decode = (value) => typeof value === 'string' ? JSON.parse(value) : value
const invalid = (message, status = 409) => Object.assign(new Error(message), { status, code: 'contract_snapshot_mismatch' })

export async function saveParseSnapshot(contract) {
  assertUsableContract(contract)
  const id = crypto.randomUUID()
  const snapshot = JSON.parse(JSON.stringify({ ...contract, analysisState: 'ready', parseSnapshotId: id, contentFingerprint: contentFingerprint(contract) }))
  await pool.execute('INSERT INTO contract_parse_snapshots (id, source_file, content_hash, contract_json, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, snapshot.sourceFile, snapshot.contentFingerprint, JSON.stringify(snapshot), new Date()])
  return snapshot
}

export async function resolveStoredContract(submitted) {
  assertUsableContract(submitted)
  const id = String(submitted.parseSnapshotId || '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw invalid('缺少有效的解析快照，请重新上传并完成解析。', 422)
  const [rows] = await pool.execute('SELECT contract_json FROM contract_parse_snapshots WHERE id = ?', [id])
  if (!rows.length) throw invalid('解析快照不存在，请重新上传合同。', 404)
  const stored = decode(rows[0].contract_json)
  if (submitted.sourceFile !== stored.sourceFile || contentFingerprint(submitted) !== stored.contentFingerprint) {
    throw invalid('当前合同与已保存的解析快照不一致，请重新解析后操作。')
  }
  // Ignore client-supplied model fields: every downstream operation uses the persisted input.
  return stored
}

export async function saveAnalysisRun(contract, kind, result) {
  assertUsableContract(contract)
  if (!['risk', 'standard'].includes(kind) || !contract.parseSnapshotId) throw invalid('分析批次缺少解析快照。', 422)
  const run = JSON.parse(JSON.stringify({ ...result, analysisRunId: crypto.randomUUID(), parseSnapshotId: contract.parseSnapshotId, contentFingerprint: contentFingerprint(contract) }))
  await pool.execute('INSERT INTO contract_analysis_runs (id, parse_snapshot_id, analysis_kind, content_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [run.analysisRunId, contract.parseSnapshotId, kind, run.contentFingerprint, JSON.stringify(run), new Date()])
  return run
}

export async function resolveAnalysisRun(contract, kind, id) {
  const [rows] = await pool.execute('SELECT parse_snapshot_id, analysis_kind, content_hash, result_json FROM contract_analysis_runs WHERE id = ?', [String(id || '')])
  const row = rows[0]
  if (!row || row.analysis_kind !== kind || row.parse_snapshot_id !== contract.parseSnapshotId || row.content_hash !== contentFingerprint(contract)) {
    throw invalid('审核批次不属于当前解析快照，请返回对应合同重新审核。')
  }
  return decode(row.result_json)
}
