import 'dotenv/config'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { buildAssistantContext } from '../backend/services/contract-assistant-service.js'
import { pool } from '../backend/db.js'
const paragraphs=Array.from({length:75},(_,i)=>({index:i+1,page:Math.floor(i/5)+1,content:`第${i+1}项模拟巡检记录：双方定期检查设备运行状态，记录维护情况并签字。`}))
paragraphs.push({index:76,page:16,content:'模拟常规工作说明。'.repeat(130)+'合同转让：未经对方事先书面同意，任何一方不得将合同权利义务转让给第三人。'})
const result={checkedAt:new Date().toISOString(),runs:[]}
try{
 for(let i=0;i<2;i++){
  const start=Date.now();const context=await buildAssistantContext({question:'合同转让需要什么同意？',contract:{sourceFile:'模拟全文检索验收',paragraphStructure:paragraphs}})
  assert.equal(context.retrieval.semantic.status,'ready');assert.equal(context.retrieval.semantic.coverage.complete,true)
  assert.ok(context.retrieval.semantic.coverage.totalChunks>48)
  assert.ok(context.sources.some(s=>s.type==='contract'&&s.paragraphIndex===76&&s.excerpt.includes('事先书面同意')))
  result.runs.push({elapsedMs:Date.now()-start,coverage:context.retrieval.semantic.coverage,foundTail:true})
 }
 assert.equal(result.runs[1].coverage.reusedChunks,result.runs[1].coverage.totalChunks)
 result.status='passed'
}catch(e){result.status='failed';result.error=e.message;process.exitCode=1}
finally{await pool.end();await fs.mkdir('tmp/backup-retrieval',{recursive:true});await fs.writeFile('tmp/backup-retrieval/retrieval.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))}
