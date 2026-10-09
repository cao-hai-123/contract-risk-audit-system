import fs from 'node:fs/promises'
import path from 'node:path'
import { buildEvidenceBundle,publishEvidenceBundle } from '../backend/services/real-contract-corpus.js'
import { getEmbeddedStandardClauses } from '../backend/services/standard-clause-service.js'
import { pool } from '../backend/db.js'
const root=path.resolve('data/real-contract-corpus')
try {
  const inventory=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'))
  const hashes=new Set(inventory.files.filter(r=>!['duplicate','excluded_by_prior_review','failed'].includes(r.status)).map(r=>r.sha256))
  const documents=await Promise.all([...hashes].map(h=>fs.readFile(path.join(root,'documents',h+'.json'),'utf8').then(JSON.parse)))
  const bundle=buildEvidenceBundle(documents,getEmbeddedStandardClauses())
  await fs.writeFile(path.join(root,'library-bundle.json'),JSON.stringify(bundle,null,2))
  let publication={status:'offline_build_only'}
  if(process.argv.includes('--publish')) {
    try{publication=await publishEvidenceBundle(bundle)}
    catch(error){publication={status:'failed',error:error.code||error.name};process.exitCode=1}
  }
  const result={builtAt:new Date().toISOString(),buildId:bundle.buildId,sources:bundle.sources.length,evidence:bundle.evidence.length,
    topics:bundle.topics.length,topicsWithEvidence:bundle.topics.filter(t=>t.candidateSourceCount).length,
    holdout:bundle.sources.filter(s=>s.split==='holdout').length,noticeSummaries:bundle.sources.filter(s=>s.reviewStatus==='notice_summary_excluded').length,
    sourceStatuses:Object.fromEntries([...new Set(bundle.sources.map(s=>s.status))].map(status=>[status,bundle.sources.filter(s=>s.status===status).length])),publication}
  await fs.writeFile(path.join(root,'build-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}catch(error){console.error('Corpus build failed: '+(error.code||error.name));process.exitCode=1}finally{await pool.end()}
