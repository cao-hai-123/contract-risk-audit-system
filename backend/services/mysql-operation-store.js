import { randomUUID } from 'node:crypto'
import { pool } from '../db.js'
export { createDatabaseBackup as createOperationBackup } from './mysql-backup-service.js'

const maxOperations = 300

export function operationPageOptions(query = {}) {
  const integer=(value,fallback,max)=>{
    if(value===undefined)return fallback
    if(typeof value!=='string'&&typeof value!=='number')throw Object.assign(Error('分页参数无效'),{status:400})
    const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>max)throw Object.assign(Error('分页参数超出范围'),{status:400});return n
  }
  const page=integer(query.page,1,1000000),pageSize=integer(query.pageSize??query.limit,20,300)
  const search=query.search??'',status=query.status??'all',type=query.type??'all'
  if(typeof search!=='string'||search.length>200||!['all','active','archived'].includes(status)||typeof type!=='string'||type.length>64)throw Object.assign(Error('筛选参数无效'),{status:400})
  return {page,pageSize,search:search.trim(),status,type}
}

export async function listOperationPage(query = {}, databasePool = pool) {
  const options=operationPageOptions(query),conditions=[],params=[]
  if(options.status!=='all')conditions.push('archived_at IS '+(options.status==='active'?'NULL':'NOT NULL'))
  if(options.type!=='all'){conditions.push('operation_type = ?');params.push(options.type)}
  if(options.search){conditions.push("CAST(payload_json AS CHAR CHARACTER SET utf8mb4) LIKE ? ESCAPE '='");params.push('%'+options.search.replace(/[=%_]/g,c=>'='+c)+'%')}
  const where=conditions.length?' WHERE '+conditions.join(' AND '):''
  const db=await databasePool.getConnection()
  try {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const [counts]=await db.execute('SELECT COUNT(*) total FROM operation_records'+where,params)
    const total=Number(counts[0].total),totalPages=Math.max(1,Math.ceil(total/options.pageSize)),page=Math.min(options.page,totalPages)
    // LIMIT prevents MySQL merging this derived table: JSON used by the search
    // predicate must not be carried into filesort even when only id is selected.
    const [keys]=await db.execute('SELECT id FROM (SELECT id, created_at FROM operation_records'+where+' LIMIT 18446744073709551615) AS operation_keys ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',[...params,options.pageSize,(page-1)*options.pageSize])
    let operations=[]
    if(keys.length){const [rows]=await db.execute('SELECT * FROM operation_records WHERE id IN ('+keys.map(()=>'?').join(',')+')',keys.map(r=>r.id));const byId=new Map(rows.map(r=>[r.id,mapOperation(r)]));operations=keys.map(r=>byId.get(r.id))}
    const [types]=await db.query('SELECT DISTINCT operation_type FROM operation_records ORDER BY operation_type')
    await db.commit()
    return {operations,total,page,pageSize:options.pageSize,totalPages,types:types.map(r=>r.operation_type)}
  } catch(e){await db.rollback();throw e}finally{db.release()}
}

export async function recordOperation(type, payload) {
  const operation = { id: randomUUID(), type, createdAt: new Date().toISOString(), payload }
  await pool.execute(
    `INSERT INTO operation_records (id, operation_type, payload_json, archived_at, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
    [operation.id, operation.type, JSON.stringify(operation.payload), new Date(operation.createdAt)]
  )
  return { stored: true, operationId: operation.id, database: 'mysql' }
}

export async function listOperations(limit = 50) {
  return (await listOperationPage({pageSize:Math.trunc(Math.min(Math.max(Number(limit)||50,1),maxOperations))})).operations
}

export async function getOperationById(id) {
  const [rows] = await pool.execute(
    `SELECT id, operation_type, payload_json, archived_at, created_at
     FROM operation_records WHERE id = ? LIMIT 1`,
    [String(id || '')]
  )
  return rows[0] ? mapOperation(rows[0]) : null
}

export async function archiveOperations(ids) {
  const normalizedIds = normalizeIds(ids)
  if (!normalizedIds.length) return { archived: 0, operations: [] }
  const placeholders = normalizedIds.map(() => '?').join(', ')
  const [result] = await pool.execute(
    `UPDATE operation_records SET archived_at = ? WHERE id IN (${placeholders}) AND archived_at IS NULL`,
    [new Date(), ...normalizedIds]
  )
  return { archived: result.affectedRows, operations: [] }
}

export async function deleteOperations(ids) {
  const normalizedIds = normalizeIds(ids)
  if (!normalizedIds.length) return { deleted: 0 }
  const placeholders = normalizedIds.map(() => '?').join(', ')
  const [result] = await pool.execute(`DELETE FROM operation_records WHERE id IN (${placeholders})`, normalizedIds)
  return { deleted: result.affectedRows }
}

export async function importLegacyOperations(operations) {
  let imported = 0
  for (const operation of operations) {
    if (!operation?.id || !operation?.type || !operation?.createdAt) continue
    const [result] = await pool.execute(
      `INSERT IGNORE INTO operation_records (id, operation_type, payload_json, archived_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [operation.id, operation.type, JSON.stringify(operation.payload || {}), operation.archivedAt ? new Date(operation.archivedAt) : null, new Date(operation.createdAt)]
    )
    imported += result.affectedRows
  }
  return imported
}

function mapOperation(row) {
  return {
    id: row.id,
    type: row.operation_type,
    createdAt: new Date(row.created_at).toISOString(),
    payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    archived: Boolean(row.archived_at)
  }
}

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean))]
}
