import crypto from 'node:crypto'
import { pool } from '../db.js'
const secret=crypto.randomBytes(32)
const fault=(message,status=400)=>Object.assign(Error(message),{status,code:'lifecycle_conflict'})
let locks=0

export async function lockContract(sourceFile, databasePool=pool) {
  if(typeof sourceFile!=='string'||!sourceFile||sourceFile.length>512)throw fault('缺少有效的合同文件名')
  if(locks>=4)throw fault('当前业务任务较多，请稍后重试。',409)
  locks++
  let db
  const key='contract:'+crypto.createHash('sha256').update(sourceFile.normalize('NFC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g,' ')).digest('hex').slice(0,50)
  try{
    db=await databasePool.getConnection()
    const [rows]=await db.execute('SELECT GET_LOCK(?, 0) locked',[key])
    if(Number(rows[0].locked)!==1)throw fault('该合同正在处理，请等待完成后重试。',409)
    return async()=>{try{await db.execute('SELECT RELEASE_LOCK(?)',[key])}finally{db.release();locks--}}
  }catch(e){if(db)db.release();locks--;throw e}
}

function inputOptions(input){
  if(input?.scope==='history'){
    if(!Array.isArray(input.ids)||input.ids.length<1||input.ids.length>100||input.ids.some(id=>typeof id!=='string'||! /^[0-9a-f-]{36}$/i.test(id)))throw fault('请选择1至100条有效记录')
    return {scope:'history',ids:[...new Set(input.ids)].sort()}
  }
  if(input?.scope==='contract'&&typeof input.sourceFile==='string'&&input.sourceFile.length>0&&input.sourceFile.length<=255)return {scope:'contract',sourceFile:input.sourceFile}
  throw fault('删除范围无效')
}
async function plan(db,options){
  if(options.scope==='history'){
    const [rows]=await db.execute('SELECT id FROM operation_records WHERE id IN ('+options.ids.map(()=>'?').join(',')+') ORDER BY id',options.ids)
    return {operation_records:rows.map(r=>r.id)}
  }
  const name=options.sourceFile
  const result={}
  const definitions=[
    ['contract_parse_records','id','BINARY file_name = BINARY ?',[name]],
    ['contract_risk_audit_records','id','BINARY file_name = BINARY ?',[name]],
    ['contract_parse_snapshots','id','BINARY source_file = BINARY ?',[name]],
    ['contract_analysis_runs','id','parse_snapshot_id IN (SELECT id FROM contract_parse_snapshots WHERE BINARY source_file = BINARY ?)',[name]],
    ['managed_reports','id','BINARY source_file = BINARY ?',[name]],
    ['contract_versions','id','BINARY source_file = BINARY ? AND NOT EXISTS (SELECT 1 FROM managed_reports r WHERE r.contract_version_id=contract_versions.id AND BINARY r.source_file <> BINARY ?)',[name,name]],
    ['operation_records','id',"BINARY COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.sourceFile')),'null'),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.parsed.sourceFile')),'null'),JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.fileName'))) = BINARY ?",[name]],
    ['semantic_vector_index','source_hash',"source_kind='contract' AND BINARY source_title LIKE BINARY ? ESCAPE '='",[name.replace(/[=%_]/g,c=>'='+c)+' · 第 %']]
  ]
  for(const [table,key,where,args]of definitions){const [rows]=await db.execute(`SELECT ${key} AS id FROM ${table} WHERE ${where} ORDER BY ${key}`,args);result[table]=rows.map(r=>r.id)}
  return result
}
const fingerprint=(options,rows)=>crypto.createHash('sha256').update(JSON.stringify({options,rows})).digest('hex')
const signature=value=>crypto.createHmac('sha256',secret).update(value).digest('hex')
export async function previewDeletion(input,databasePool=pool){
  const options=inputOptions(input),db=await databasePool.getConnection()
  try{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const rows=await plan(db,options);await db.commit()
    const expires=Date.now()+300000,body=expires+'.'+fingerprint(options,rows)
    return {...options,counts:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.length])),total:Object.values(rows).reduce((n,v)=>n+v.length,0),token:body+'.'+signature(body),expiresAt:new Date(expires).toISOString(),
      preserved:options.scope==='history'?'合同解析、审核、报告及所有外部文件均保留。':'仅删除精确同名文件的业务记录（包含其多个解析批次）。保留原件、OCR语料与检查点、公共规则/标准库、印章库、FAMIE数据和已有备份。'}
  }catch(e){await db.rollback();throw e}finally{db.release()}
}
export async function executeDeletion(input,databasePool=pool){
  const options=inputOptions(input)
  if(input.confirmed!==true||typeof input.token!=='string')throw fault('请先预览并明确确认删除')
  if(options.scope==='contract'&&input.confirmFileName!==options.sourceFile)throw fault('请准确输入待删除合同文件名')
  const [expires,hash,sig,...extra]=input.token.split('.')
  const expected=signature(expires+'.'+hash)
  if(extra.length||!sig||! /^[0-9a-f]{64}$/.test(sig)||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))||!Number.isFinite(Number(expires))||Number(expires)<Date.now())throw fault('删除预览已失效，请重新预览。',409)
  const release=options.scope==='contract'?await lockContract(options.sourceFile,databasePool):null
  let db
  try{
    db=await databasePool.getConnection()
    await db.beginTransaction()
    const rows=await plan(db,options)
    if(fingerprint(options,rows)!==hash)throw fault('相关记录已变化，请重新预览后确认。',409)
    let deleted=0
    // No filesystem operations and no corpus/library tables are reachable here.
    for(const table of ['operation_records','contract_analysis_runs','managed_reports','contract_versions','contract_parse_snapshots','contract_risk_audit_records','contract_parse_records','semantic_vector_index']){
      const ids=rows[table]||[],key=table==='semantic_vector_index'?'source_hash':'id'
      for(let i=0;i<ids.length;i+=200){const batch=ids.slice(i,i+200);const [r]=await db.execute(`DELETE FROM ${table} WHERE ${key} IN (${batch.map(()=>'?').join(',')})`,batch);deleted+=r.affectedRows}
    }
    await db.commit();return {scope:options.scope,deleted,counts:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.length]))}
  }catch(e){if(db)await db.rollback();throw e}finally{if(db)db.release();if(release)await release()}
}
