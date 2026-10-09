import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { safePath, validateBox, repairName, runSealWorker, sealPython, createSealService } from '../backend/services/seal-service.js'
import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import { sealSchema } from '../backend/services/seal-repository.js'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import * as vue from 'vue'
import {parse,compileScript} from '@vue/compiler-sfc'

test('seal path validation rejects traversal and sibling prefixes',()=>{
  const root=path.resolve('tmp/seal-tests')
  assert.throws(()=>safePath(root,'../seal-tests-evil/file'))
  assert.throws(()=>safePath(root,'..'))
  assert.equal(safePath(root,'jobs/a'),path.join(root,'jobs/a'))
})
test('normalized ROI rejects invalid and out-of-range values',()=>{
  for(const box of [null,{}, {x:0,y:0,width:0,height:1},{x:0,y:0,width:NaN,height:1},{x:.8,y:0,width:.3,height:1},{x:'0',y:0,width:1,height:1}])assert.throws(()=>validateBox(box))
  assert.deepEqual(validateBox({x:0,y:0,width:1,height:1}),{x:0,y:0,width:1,height:1})
})
test('Chinese original and mojibake filename are preserved/repaired',()=>{
  assert.equal(repairName('模拟合同.pdf'),'模拟合同.pdf')
  assert.equal(repairName(Buffer.from('模拟合同.pdf').toString('latin1')),'模拟合同.pdf')
})
test('schema mirror remains consistent with runtime initializer',async()=>{
  const sql=await fs.readFile('backend/schema.sql','utf8')
  for(const statement of sealSchema)assert.ok(sql.includes(statement))
})
test('actual pinned local worker health, not a configured-ready assumption',async()=>{
  const result=await runSealWorker({action:'health'},path.resolve('tmp/seal-health'))
  assert.equal(result.version,'4.11.0');assert.equal(result.orb,true);assert.equal(result.pdf,true)
})
test('invalid worker input produces classified error',async()=>{
  await assert.rejects(runSealWorker({action:'render',source:path.resolve('tmp/no-such-seal.pdf'),directory:path.resolve('tmp/seal-health'),extension:'.pdf'},path.resolve('tmp/seal-health')),e=>e.code==='visual_processing_failed')
})
test('actual Python transformation, degeneracy, gray fallback and score tests',()=>{
  const r=spawnSync(sealPython(),['tests/seal/test_visual.py'],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}})
  assert.equal(r.status,0,r.stderr||r.error?.message)
})
test('restart recovers interrupted jobs and removes expired temporary pages',async()=>{
  const base=path.resolve('tmp','seal-lifecycle-'+randomUUID()),id=randomUUID(),expired=randomUUID()
  const write=async(id,age,status)=>{const d=path.join(base,'jobs',id);await fs.mkdir(d,{recursive:true});await fs.writeFile(path.join(d,'job.json'),JSON.stringify({id,directory:d,createdAt:Date.now()-age,status,pages:[]}))}
  await write(id,1000,'matching');await write(expired,25*3600000,'done')
  const service=createSealService({}, {base})
  try{
    await service.ready;const job=await service.status(id);assert.equal(job.status,'failed');assert.match(job.error,/重启/)
    await assert.rejects(service.status(expired),e=>e.status===404)
    await assert.rejects(fs.access(path.join(base,'jobs',expired)))
  }finally{service.dispose();await fs.rm(base,{recursive:true,force:true})}
})

async function setupSealView(fetch){
  const {descriptor}=parse(await fs.readFile('src/components/SealRecognitionPanel.vue','utf8'))
  let code=compileScript(descriptor,{id:'seal-test',genDefaultAs:'component'}).content
  code=code.replace(/import[^\n]+from ['"]vue['"];?/g,'')
  const ctx={...vue,onMounted(){},onBeforeUnmount(){},fetch,FormData,Blob,File,Error,console,setTimeout,clearTimeout,
    sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},window:{},document:{}}
  vm.createContext(ctx);new vm.Script(code+'\n;globalThis.state=component.setup({}, {expose(){}})').runInContext(ctx)
  return ctx.state
}
test('failed or oversized seal upload clears the previous result',async()=>{
  const state=await setupSealView(async()=>{throw new Error('network unavailable')})
  state.job.value={id:'previous',status:'done',result:{status:'MATCH'}}
  await state.upload({target:{files:[new File(['bad'],'new.pdf')],value:'new.pdf'}})
  assert.equal(state.job.value,null);assert.match(state.error.value,/network/)
  state.job.value={id:'previous',status:'done',result:{status:'MATCH'}}
  await state.upload({target:{files:[{size:51*1024*1024}],value:'too-large'}})
  assert.equal(state.job.value,null);assert.match(state.error.value,/50 MB/)
})
test('changing the selected seal identity revokes earlier confirmation',async()=>{
  const state=await setupSealView(async()=>{})
  state.groupId.value='1';await vue.nextTick();state.confirmed.value=true
  state.groupId.value='2';await vue.nextTick();assert.equal(state.confirmed.value,false)
})
