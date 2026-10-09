// Synthetic-only integration test in a uniquely named MySQL database.
import 'dotenv/config'
import mysql from 'mysql2/promise'
import express from 'express'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {sealSchema} from '../backend/services/seal-repository.js'
import {createSealRouter} from '../backend/routes/seal.js'
import {sealPython} from '../backend/services/seal-service.js'
import {spawnSync} from 'node:child_process'
import {Document,Packer,Paragraph,ImageRun} from 'docx'
const visual=spawnSync(sealPython(),['tests/seal/test_visual.py'],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}})
assert.equal(visual.status,0,visual.stderr)
const fixture=new Document({sections:[{children:[new Paragraph('模拟测试文件，无实际法律效力。'),new Paragraph({children:[new ImageRun({data:await fs.readFile('tmp/seal-synthetic/a.png'),type:'png',transformation:{width:240,height:240}})]})]}]})
await fs.writeFile('tmp/seal-synthetic/test.docx',await Packer.toBuffer(fixture))
const database='seal_test_'+randomUUID().replaceAll('-','')
const options={host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||''}
const admin=await mysql.createConnection(options)
let pool,server
const base=path.resolve('tmp',database),results=[]
try {
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`)
  pool=mysql.createPool({...options,database,connectionLimit:3,charset:'utf8mb4'})
  for(const statement of sealSchema)await pool.query(statement)
  const app=express();app.use(express.json());app.use('/api/seal',createSealRouter(pool,{base}))
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve))
  const origin=`http://127.0.0.1:${server.address().port}/api/seal`
  const request=async(url,body,expected=200)=>{
    const r=await fetch(origin+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})
    const value=await r.json();assert.equal(r.status,expected,JSON.stringify(value));return value
  }
  const wait=async id=>{
    for(let i=0;i<120;i++){const j=await request('/jobs/'+id);if(!['queued','processing','matching','saving'].includes(j.status)){assert.notEqual(j.status,'failed',j.error);return j}await new Promise(r=>setTimeout(r,250))}
    throw new Error('job timeout')
  }
  const upload=async(name,kind)=>{
    const form=new FormData();form.append('file',new Blob([await fs.readFile(`tmp/seal-synthetic/${name}.png`)],{type:'image/png'}),'模拟合同-'+name+'.png')
    const r=await fetch(origin+(kind==='reference'?'/reference/document':'/analyze'),{method:'POST',body:form});assert.equal(r.status,202)
    const j=await r.json();await wait(j.id);return j.id
  }
  const select=async id=>{await request(`/jobs/${id}/selection`,{page:1,bbox:{x:0,y:0,width:1,height:1}},202);return wait(id)}
  assert.equal((await request('/health')).orb,true);results.push('real worker health')
  await request('/groups',{label:'',sealName:'demo',companyName:'demo'},400)
  const a=await request('/groups',{label:'DEMO-A',sealName:'模拟甲章',companyName:'虚拟单位甲'},201)
  const b=await request('/groups',{label:'DEMO-B',sealName:'模拟乙章',companyName:'虚拟单位乙'},201)
  await request('/groups',{label:'DEMO-A',sealName:'模拟',companyName:'模拟'},409)
  const emptyId=await upload('query','query');const empty=await select(emptyId);assert.equal(empty.result.status,'UNCERTAIN');assert.equal(empty.result.top1Score,null);results.push('empty library uncertain')
  let firstId
  for(const [name,group] of [['a',a],['a2',a],['b',b],['b2',b]]){
    const id=await upload(name,'reference');const j=await select(id);assert.ok(j.crop.featureCount>30)
    await request('/reference/samples',{jobId:id,groupId:group.id,confirmed:false},400)
    const saved=await request('/reference/samples',{jobId:id,groupId:group.id,confirmed:true},201)
    if(!firstId)firstId=saved.id
    await request('/reference/samples',{jobId:id,groupId:group.id,confirmed:true},409)
  }
  results.push('explicit confirmation, UTF-8, four samples, duplicate rejection')
  const beforeGroups=await request('/groups')
  const rebuilt=await request(`/groups/${a.id}/rebuild`,{},202);assert.equal((await wait(rebuilt.id)).rebuildCount,2)
  const afterGroups=await request('/groups')
  assert.equal(afterGroups.find(g=>g.id===b.id).sample_version,beforeGroups.find(g=>g.id===b.id).sample_version)
  assert.equal(afterGroups.find(g=>g.id===a.id).sample_version,beforeGroups.find(g=>g.id===a.id).sample_version+1)
  results.push('per-identity cache rebuild leaves other group version unchanged')
  const conflictId=await upload('a','reference');await select(conflictId)
  await request('/reference/samples',{jobId:conflictId,groupId:b.id,confirmed:true},409);results.push('cross-identity duplicate blocked')
  const query=await upload('query','query')
  await request(`/jobs/${query}/selection`,{page:999,bbox:{x:0,y:0,width:1,height:1}},400)
  await request(`/jobs/${query}/selection`,{page:1,bbox:{x:-1,y:0,width:1,height:1}},400)
  const matched=await select(query)
  assert.equal(matched.result.bestMatch.label,'DEMO-A');assert.ok(matched.result.top1Score>matched.result.secondBestScore)
  assert.ok(['MATCH','POSSIBLE_MATCH'].includes(matched.result.status),JSON.stringify(matched.result))
  const image=await fetch(origin+`/jobs/${query}/images/matches.png`);assert.equal(image.status,200)
  const raw=await fetch(origin+`/jobs/${query}/images/source.png`);assert.equal(raw.status,404)
  results.push('query matching, geometry visualization, bounded ROI, raw source inaccessible')
  await request(`/samples/${firstId}/disable`,{confirmed:false},400)
  await request(`/samples/${firstId}/disable`,{confirmed:true})
  const after=await select(query);assert.equal(after.result.status,'UNCERTAIN');results.push('disabled sample excluded')
  const bad=new FormData();bad.append('file',new Blob(['bad PDF']),'损坏.pdf')
  const response=await fetch(origin+'/analyze',{method:'POST',body:bad});assert.equal(response.status,202)
  const badId=(await response.json()).id
  for(let i=0;i<100;i++){const j=await request('/jobs/'+badId);if(j.status==='failed'){assert.ok(j.error);break}if(i===99)assert.fail('bad input not failed');await new Promise(r=>setTimeout(r,200))}
  results.push('corrupt PDF actionable failure')
  const health=await request('/health')
  const word=new FormData();word.append('file',new Blob([await fs.readFile('tmp/seal-synthetic/test.docx')]),'模拟.docx')
  const wordResponse=await fetch(origin+'/analyze',{method:'POST',body:word});assert.equal(wordResponse.status,202)
  const wordId=(await wordResponse.json()).id
  if(health.docx){
    const rendered=await wait(wordId);assert.equal(rendered.pages.length,1);assert.ok(rendered.pages[0].candidates.length>0)
    await request(`/jobs/${wordId}/selection`,{page:1,bbox:rendered.pages[0].candidates[0]},202)
    const selected=await wait(wordId);assert.ok(selected.crop.featureCount>30);results.push('real DOCX conversion and high-resolution PDF ROI')
  }else{
    for(let i=0;i<100;i++){const j=await request('/jobs/'+wordId);if(j.status==='failed'){assert.match(j.error,/转换器/);break}if(i===99)assert.fail('DOCX fallback missing');await new Promise(r=>setTimeout(r,200))}
    results.push('DOCX converter unavailable: actionable fallback only')
  }
  await fs.writeFile('tmp/seal-integration-result.json',JSON.stringify({passed:results,result:matched.result,syntheticOnly:true},null,2))
  console.log(JSON.stringify({passed:results,status:matched.result.status,top1:matched.result.top1Score,top2:matched.result.secondBestScore,gap:matched.result.scoreGap},null,2))
} finally {
  if(server)await new Promise(resolve=>server.close(resolve))
  if(pool)await pool.end()
  if(!/^seal_test_[a-f0-9]{32}$/.test(database))throw new Error('unsafe test database name')
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);await admin.end()
  const intended=path.resolve('tmp')+path.sep
  if(base.startsWith(intended)&&path.basename(base)===database)await fs.rm(base,{recursive:true,force:true})
}
