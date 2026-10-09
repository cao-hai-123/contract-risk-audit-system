import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { pool } from '../backend/db.js'
import { redactEvidence,getCorpusSupport } from '../backend/services/real-contract-corpus.js'
import { matchStandardClauses } from '../backend/services/standard-clause-service.js'
const hash=value=>crypto.createHash('sha256').update(value).digest('hex')
const root=path.resolve('data/real-contract-corpus')
const bundle=JSON.parse(await fs.readFile(path.join(root,'library-bundle.json'),'utf8'))
const receipt={checkedAt:new Date().toISOString(),buildId:bundle.buildId,checks:[],passed:false}
try{
  const documents=new Map(),held=new Set(bundle.sources.filter(s=>s.split==='holdout').map(s=>s.sha256))
  for(const s of bundle.sources){
    const d=JSON.parse(await fs.readFile(path.join(root,'documents',s.sha256+'.json'),'utf8'))
    const source=path.resolve('matchreal',d.source)
    assert.ok(source.startsWith(path.resolve('matchreal')+path.sep))
    assert.equal(hash(await fs.readFile(source)),s.sha256)
    documents.set(s.sha256,d)
  }
  assert.equal(new Set(bundle.evidence.map(e=>e.id)).size,bundle.evidence.length)
  for(const e of bundle.evidence){
    assert.ok(!held.has(e.sourceHash));const d=documents.get(e.sourceHash)
    const p=d.pages.find(p=>p.page===e.page);assert.equal(p.status,'text_extracted')
    const original=p.text.slice(e.start,e.end)
    assert.equal(hash(original),e.quoteHash);assert.equal(redactEvidence(original),e.quote)
    assert.equal(e.reviewStatus,'candidate_unreviewed')
  }
  receipt.checks.push({name:'all_source_hashes_spans_holdout_and_candidate_gates',sources:documents.size,evidence:bundle.evidence.length})
  if(process.argv.includes('--mysql')){
    const [sources]=await pool.query('SELECT COUNT(*) n FROM real_contract_corpus_sources WHERE build_id=?',[bundle.buildId])
    const [evidence]=await pool.query('SELECT COUNT(*) n FROM real_contract_clause_evidence WHERE build_id=?',[bundle.buildId])
    assert.equal(Number(sources[0].n),bundle.sources.length);assert.equal(Number(evidence[0].n),bundle.evidence.length)
    const support=await getCorpusSupport();assert.equal(support.buildId,bundle.buildId)
    const result=await matchStandardClauses({sourceFile:'模拟采购合同.docx',paragraphStructure:[{index:1,content:'甲乙双方约定采购设备十台，合同金额十万元，验收合格后付款并开具发票。双方协商解决争议。'}]},
      {dependencies:{localReview:async()=>({status:'disabled',decisions:[]})}})
    assert.equal(result.corpusSupport.status,'candidate_evidence_only')
    assert.ok(result.items.length>0)
    assert.ok(result.items.every(i=>i.status!=='完整'||i.missingRequirements.length===0))
    receipt.checks.push({name:'business_mysql_counts_and_live_service_readback',topics:result.items.length,sourceCount:support.sourceCount})
  }
  receipt.passed=true
}catch(error){receipt.error=error.code||error.name;process.exitCode=1}
finally{await pool.end();await fs.writeFile(path.join(root,'evaluation','integrity'+(process.argv.includes('--mysql')?'-mysql':'')+'.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2))}
