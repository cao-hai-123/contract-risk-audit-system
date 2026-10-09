// Isolated MySQL instance using the installed binary; never touches the Windows service data.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import mysql from 'mysql2/promise'
const executable='D:/MySQL/mysql-9.4.0-winx64/bin/mysqld.exe'
const directory=path.resolve('tmp/real-corpus-evaluation/mysql-'+Date.now())
await fs.mkdir(directory,{recursive:true})
const run=(args)=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','ignore','pipe']});let output=''
  child.stderr.on('data',d=>{output+=d});child.once('error',reject)
  child.once('exit',code=>{fs.writeFile(path.join(directory,'initialization.log'),output).then(()=>code===0?resolve():reject(new Error('initialization_failed_'+code)))})
})
await run(['--no-defaults','--initialize-insecure','--basedir=D:/MySQL/mysql-9.4.0-winx64','--datadir='+directory])
const server=spawn(executable,['--no-defaults','--basedir=D:/MySQL/mysql-9.4.0-winx64','--datadir='+directory,
  '--port=13307','--bind-address=127.0.0.1','--mysqlx=OFF','--innodb-buffer-pool-size=64M','--log-error='+path.join(directory,'server.log')],{windowsHide:true,stdio:'ignore'})
let connection,pool
const receipt={checkedAt:new Date().toISOString(),scope:'isolated_mysql_9.4_synthetic_only',checks:[]}
try {
  for(let i=0;i<60;i++){
    if(server.exitCode!==null)throw new Error('isolated_mysql_exited')
    try{connection=await mysql.createConnection({host:'127.0.0.1',port:13307,user:'root',password:''});break}catch{await new Promise(r=>setTimeout(r,500))}
  }
  if(!connection)throw new Error('isolated_mysql_timeout')
  await connection.query('CREATE DATABASE corpus_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
  Object.assign(process.env,{DB_HOST:'127.0.0.1',DB_PORT:'13307',DB_USER:'root',DB_PASSWORD:'',DB_NAME:'corpus_test'})
  const mod=await import('../backend/services/real-contract-corpus.js');({pool}=await import('../backend/db.js'))
  const bundle={buildId:'a'.repeat(64),version:'synthetic-test',legalReview:'pending',sources:[{sha256:'b'.repeat(64),source:'模拟合同🙂.pdf'}],
    topics:[{code:'price_payment',candidateSourceCount:1,approvedStandardSources:0}],evidence:[{id:'c'.repeat(64),code:'price_payment',sourceHash:'b'.repeat(64),page:1,quote:'模拟条款：付款；不执行 SQL \' DROP TABLE x; --'}]}
  const first=await mod.publishEvidenceBundle(bundle),second=await mod.publishEvidenceBundle(bundle)
  if(first.status!=='published_as_unreviewed_evidence'||second.status!=='already_published')throw new Error('idempotency_failed')
  receipt.checks.push('transactional_publish_and_idempotency')
  const support=await mod.getCorpusSupport();if(support.status!=='candidate_evidence_only'||support.sourceCount!==1)throw new Error('readback_failed')
  const [rows]=await pool.query('SELECT evidence_json FROM real_contract_clause_evidence')
  const data=typeof rows[0].evidence_json==='string'?JSON.parse(rows[0].evidence_json):rows[0].evidence_json
  if(data.quote!==bundle.evidence[0].quote)throw new Error('unicode_or_parameterization_failed')
  receipt.checks.push('utf8_and_parameterized_evidence_readback')
  const invalid={...bundle,buildId:'d'.repeat(64),evidence:[bundle.evidence[0],bundle.evidence[0]]}
  let rejected=false;try{await mod.publishEvidenceBundle(invalid)}catch{rejected=true}
  const [leaks]=await pool.query('SELECT COUNT(*) n FROM real_contract_corpus_sources WHERE build_id=?',[invalid.buildId])
  if(!rejected||Number(leaks[0].n)!==0)throw new Error('rollback_failed')
  receipt.checks.push('failed_build_rolls_back_all_rows');receipt.passed=true
}catch(error){receipt.passed=false;receipt.error=error.code||error.message;process.exitCode=1}
finally{
  if(pool)await pool.end()
  if(connection){try{await connection.query('SHUTDOWN')}catch{}await connection.end()}
  if(server.exitCode===null){await Promise.race([once(server,'exit'),new Promise(r=>setTimeout(r,5000))]);if(server.exitCode===null)server.kill()}
  await fs.writeFile('data/real-contract-corpus/evaluation/mysql-isolated.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt))
}
