import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createFullBackup, verifyFullBackup, restoreExternalFiles, contained } from '../backend/services/full-backup-service.js'
import { collectContractSources, buildAssistantContext } from '../backend/services/contract-assistant-service.js'

test('external backup roundtrip, corruption detection, and non-overwrite restore', async () => {
  const root=path.resolve('tmp/backup-test-'+randomUUID());await fs.mkdir(path.join(root,'data'),{recursive:true})
  const connection={query:async(sql)=> sql.includes('@@session') ? [[{timezone:'+00:00'}]] : [[]],commit:async()=>{},rollback:async()=>{},release:()=>{}}
  const databasePool={getConnection:async()=>connection}
  try {
    await fs.writeFile(path.join(root,'data','模拟文件.txt'),'中文🙂\n模拟合同')
    const dest=path.join(root,'backup'), restored=path.join(root,'restored')
    await createFullBackup({root,destination:dest,databasePool,roots:['data']})
    const m=await verifyFullBackup(dest);assert.equal(m.files.length,2)
    await restoreExternalFiles(dest,restored)
    assert.equal(await fs.readFile(path.join(restored,'data','模拟文件.txt'),'utf8'),'中文🙂\n模拟合同')
    await assert.rejects(restoreExternalFiles(dest,restored))
    await fs.appendFile(path.join(dest,'files','data','模拟文件.txt'),'damage')
    await assert.rejects(verifyFullBackup(dest),/checksum/)
    assert.throws(()=>contained(dest,'../escape'))
    assert.throws(()=>contained(dest,'C:\\outside'))
  } finally {assert.ok(root.startsWith(path.resolve('tmp')+path.sep));await fs.rm(root,{recursive:true,force:true})}
})
test('full paragraph chunking covers suffix, exact offsets, Unicode and page citations',()=>{
  const text='模拟普通文本🙂'.repeat(200)+'末尾特约：任何转让须经书面同意。'
  const sources=collectContractSources('转让',{sourceFile:'模拟',paragraphStructure:[{index:9,page:7,content:text}]})
  const covered=new Set()
  for(const s of sources){assert.equal(s.excerpt,text.slice(s.charStart,s.charEnd));assert.equal(s.page,7);for(let i=s.charStart;i<s.charEnd;i++)covered.add(i);assert.ok(!/^[\uDC00-\uDFFF]/.test(s.excerpt));assert.ok(!/[\uD800-\uDBFF]$/.test(s.excerpt))}
  assert.equal(covered.size,text.length);assert.ok(sources.some(s=>s.excerpt.includes('末尾特约')))
})
test('full backup refuses missing files referenced by the database snapshot',async()=>{
  const root=path.resolve('tmp/backup-reference-'+randomUUID());await fs.mkdir(path.join(root,'data'),{recursive:true})
  const row={source_path:'references/s/source.pdf',image_path:'references/s'}
  const connection={query:async(sql)=>{
    const q=typeof sql==='string'?sql:sql.sql
    if(q.includes('@@session'))return[[{timezone:'+00:00'}]]
    if(q==='SHOW TABLES')return[[{table:'seal_reference_sample'}]]
    if(q.startsWith('SHOW CREATE'))return[[{'Create Table':'CREATE TABLE `seal_reference_sample` (source_path TEXT, image_path TEXT)'}]]
    if(q.startsWith('SHOW COLUMNS'))return[[{Field:'source_path',Type:'text',Key:''},{Field:'image_path',Type:'text',Key:''}]]
    if(q.startsWith('SELECT *'))return[[row]]
    return[[]]
  },commit:async()=>{},rollback:async()=>{},release:()=>{}}
  try{
    await assert.rejects(createFullBackup({root,destination:path.join(root,'missing'),databasePool:{getConnection:async()=>connection},roots:['data']}),/referenced seal file is missing/)
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'missing','manifest.json'),'utf8')).status,'incomplete')
  }finally{assert.ok(root.startsWith(path.resolve('tmp')+path.sep));await fs.rm(root,{recursive:true,force:true})}
})
test('semantic retrieval sees all late zero-keyword paragraphs, and fallback keeps full lexical recall',async()=>{
  const paragraphStructure=Array.from({length:90},(_,i)=>({index:i+1,content:i===89?'任何一方均不得擅自将本协议项下权益交由第三人承继。':'例行工作记录，双方定期进行设备检查并登记。'}))
  let seen=0
  const contract={sourceFile:'模拟',paragraphStructure}
  const context=await buildAssistantContext({question:'转让许可',contract,loadStandardClauses:async()=>[],semanticSearch:async({sources})=>{seen=sources.filter(s=>s.type==='contract').length;return{status:'ready',scores:new Map(sources.map(s=>[s.id,s.id==='C90'?1:0]))}}})
  assert.equal(seen,90);assert.ok(context.sources.some(s=>s.id==='C90'))
  paragraphStructure[89].content+='转让许可必须获得书面同意。'
  const fallback=await buildAssistantContext({question:'转让许可',contract,loadStandardClauses:async()=>[],semanticSearch:async()=>{throw Error('offline')}})
  assert.equal(fallback.retrieval.semantic.status,'embedding_unavailable');assert.ok(fallback.sources.some(s=>s.id==='C90'))
})
