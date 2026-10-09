import 'dotenv/config'
import mysql from 'mysql2/promise'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
const name='contract_lifecycle_test_'+Date.now()
const admin=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||''})
const receipt={checks:[],databaseScope:'isolated_synthetic_only'}
let pool,created=false
const check=async(name,fn)=>{await fn();receipt.checks.push(name);console.log('PASS '+name)}
try{
  assert.match(name,/^contract_lifecycle_test_\d+$/)
  await admin.query('CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4');created=true;process.env.DB_NAME=name
  const db=await import('../backend/db.js');pool=db.pool;await db.initializeDatabase()
  const {listOperationPage,recordOperation,archiveOperations}=await import('../backend/services/mysql-operation-store.js')
  const {previewDeletion,executeDeletion,lockContract}=await import('../backend/services/data-lifecycle-service.js')
  const {saveParseSnapshot,saveAnalysisRun,resolveStoredContract}=await import('../backend/services/contract-integrity-service.js')
  const {prepareManagedReport}=await import('../backend/services/report-management-service.js')
  const {syncRiskRuleLibrary}=await import('../backend/services/risk-audit-service.js');await syncRiskRuleLibrary()
  const {publishEvidenceBundle}=await import('../backend/services/real-contract-corpus.js')
  await publishEvidenceBundle({buildId:'e'.repeat(64),version:'synthetic',sources:[],evidence:[],topics:[],legalReview:'pending'})
  const ids=[]
  for(let i=0;i<365;i++){const r=await recordOperation(i%2?'test_a':'test_b',{sourceFile:i===0?'最旧模拟合同_100%.pdf':'模拟历史'+i+'.pdf',summary:'模拟'});ids.push(r.operationId)}
  await pool.query("UPDATE operation_records SET created_at='2026-01-01 00:00:00.000'")
  await archiveOperations(ids.slice(0,40))
  await check('all 365 equal-timestamp records page without duplicates; beyond old 300 cap',async()=>{
    const seen=new Set();for(let page=1;page<=19;page++){const r=await listOperationPage({page,pageSize:20});assert.equal(r.total,365);for(const item of r.operations){assert.ok(!seen.has(item.id));seen.add(item.id)}}assert.equal(seen.size,365)
  })
  await check('server filters all pages; literal percent/underscore; invalid input rejected; page clamping',async()=>{
    const r=await listOperationPage({search:'_100%',status:'archived',type:'test_b'});assert.equal(r.total,1)
    assert.equal((await listOperationPage({status:'active'})).total,325)
    assert.equal((await listOperationPage({page:999})).page,19)
    for(const q of [{page:0},{pageSize:10000},{search:['a']},{status:'wrong'}])await assert.rejects(listOperationPage(q),e=>e.status===400)
  })
  let a,b,aLog
  async function fixture(sourceFile){
    const contract=await saveParseSnapshot({sourceFile,analysisState:'ready',paragraphStructure:[{index:1,content:'本合同仅用于模拟测试，双方约定服务金额为100元。'}],contractType:{predicted:'其他'},keyElements:{amount:'100元'},documentParsing:{textLength:28}})
    const audit=await saveAnalysisRun(contract,'risk',{summary:{},risks:[],missingClauses:[]})
    const match=await saveAnalysisRun(contract,'standard',{summary:{},items:[]})
    await prepareManagedReport(contract,{auditRunId:audit.analysisRunId,matchRunId:match.analysisRunId})
    await db.saveContractParseRecord({fileName:sourceFile,fileType:'pdf',contractType:'其他',keyElements:{},paragraphStructure:contract.paragraphStructure,ocrConfidence:1})
    await db.saveRiskAuditRecord({fileName:sourceFile,contractType:'其他',overallLevel:'低',riskScore:0,audit:{}})
    const log=await recordOperation('contract_parse',{sourceFile,parsed:contract})
    await pool.execute('INSERT INTO semantic_vector_index VALUES (?,?,?,?,?,?,?,?,?,NOW(3))',[crypto.randomBytes(32).toString('hex'),'contract','C1',sourceFile+' · 第 1 段','模拟',JSON.stringify([1]),'test','test',1])
    return {contract,log}
  }
  a=await fixture('模拟_A%.pdf');b=await fixture('模拟_AB.pdf');aLog=a.log.operationId
  await check('history-only deletion keeps contract snapshot, report and analysis',async()=>{
    const p=await previewDeletion({scope:'history',ids:[aLog]})
    await assert.rejects(executeDeletion({...p,confirmed:false}),e=>e.status===400)
    await executeDeletion({...p,confirmed:true});assert.ok(await resolveStoredContract(a.contract))
    const [r]=await pool.query('SELECT COUNT(*) n FROM managed_reports');assert.equal(r[0].n,2)
    await assert.rejects(executeDeletion({...p,confirmed:true}),e=>e.status===409)
  })
  const input={scope:'contract',sourceFile:a.contract.sourceFile}
  await check('changed preview and wrong filename cannot delete',async()=>{
    const p=await previewDeletion(input);await recordOperation('test',{sourceFile:input.sourceFile})
    await assert.rejects(executeDeletion({...input,token:p.token,confirmed:true,confirmFileName:input.sourceFile}),e=>e.status===409)
    await assert.rejects(executeDeletion({...input,token:p.token,confirmed:true,confirmFileName:'wrong'}),e=>e.status===400)
  })
  await check('active processing lock refuses same-file deletion',async()=>{
    const p=await previewDeletion(input),release=await lockContract(input.sourceFile)
    try{await assert.rejects(executeDeletion({...input,token:p.token,confirmed:true,confirmFileName:input.sourceFile}),e=>e.status===409)}finally{await release()}
  })
  await check('mid-delete database failure rolls back all prior deletes',async()=>{
    const p=await previewDeletion(input);let connections=0
    const injected={getConnection:async()=>{const c=await pool.getConnection();connections++;if(connections!==2)return c;return new Proxy(c,{get(target,key){if(key==='execute')return async(sql,args)=>{if(sql.startsWith('DELETE FROM managed_reports'))throw Error('injected');return target.execute(sql,args)};const value=target[key];return typeof value==='function'?value.bind(target):value}})}}
    await assert.rejects(executeDeletion({...input,token:p.token,confirmed:true,confirmFileName:input.sourceFile},injected),/injected/)
    assert.deepEqual((await previewDeletion(input)).counts,p.counts)
  })
  await check('contract deletion removes linked rows only; other file and corpus/rules preserved',async()=>{
    const p=await previewDeletion(input);assert.equal(p.counts.semantic_vector_index,1);assert.equal(p.counts.contract_analysis_runs,2)
    const r=await executeDeletion({...input,token:p.token,confirmed:true,confirmFileName:input.sourceFile});assert.equal(r.deleted,p.total)
    assert.equal((await previewDeletion(input)).total,0);assert.ok(await resolveStoredContract(b.contract));await assert.rejects(resolveStoredContract(a.contract),e=>e.status===404)
    const [rules]=await pool.query('SELECT COUNT(*) n FROM risk_rule_library');assert.equal(rules[0].n,56)
    const [corpus]=await pool.query('SELECT COUNT(*) n FROM real_contract_corpus_builds');assert.equal(corpus[0].n,1)
  })
  receipt.status='passed'
}catch(e){receipt.status='failed';receipt.error=e.message;process.exitCode=1}
finally{if(pool)await pool.end();if(created)await admin.query('DROP DATABASE `'+name+'`');await admin.end();await fs.mkdir('tmp/history-lifecycle',{recursive:true});await fs.writeFile('tmp/history-lifecycle/mysql.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt))}
