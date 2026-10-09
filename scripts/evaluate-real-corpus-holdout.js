import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { matchClause, getEmbeddedStandardClauses } from '../backend/services/standard-clause-service.js'
import { pool } from '../backend/db.js'
const root='data/real-contract-corpus'
const bundle=JSON.parse(await fs.readFile(root+'/library-bundle.json','utf8'))
// Frozen source captured before changing the matcher. Resolve its original relative imports.
const base=path.resolve('backend/services')
const oldSource=(await fs.readFile('tests/fixtures/matcher-baseline/standard-clause-service-before-20260924.txt','utf8'))
  .replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g,(_,quote,relative)=>`from ${quote}${pathToFileURL(path.resolve(base,relative)).href}${quote}`)
const temporary=path.resolve('tmp/real-corpus-evaluation/baseline.mjs')
await fs.writeFile(temporary,oldSource)
const old=await import(pathToFileURL(temporary).href)
const definitions=getEmbeddedStandardClauses(),results=[]
for(const source of bundle.sources.filter(s=>s.split==='holdout'&&s.status==='extracted'&&s.reviewStatus==='candidate_unreviewed')) {
  const doc=JSON.parse(await fs.readFile(`${root}/documents/${source.sha256}.json`,'utf8'))
  const paragraphs=doc.pages.flatMap(p=>p.text.split(/\n+/).filter(Boolean)).map((content,i)=>({index:i+1,content}))
  const contract={sourceFile:source.source,paragraphStructure:paragraphs}
  const before=definitions.map(d=>old.matchClause(d,contract)),after=definitions.map(d=>matchClause(d,contract))
  results.push({sourceHash:source.sha256,checks:after.length,
    contradictoryCompleteBefore:before.filter(x=>x.status==='完整'&&x.missingRequirements.length>0).length,
    contradictoryCompleteAfter:after.filter(x=>x.status==='完整'&&x.missingRequirements.length>0).length,
    changedToPartial:after.filter((x,i)=>x.status==='部分具备'&&before[i].status==='完整').length})
}
const receipt={checkedAt:new Date().toISOString(),buildId:bundle.buildId,metric:'required_evidence_consistency_not_legal_accuracy',
  note:'All 40 topics exercised as diagnostic probes, not an applicability judgement; no lawyer labels, no precision/recall claim. Exact-text split only; near-duplicate families not certified independent.',
  documents:results.length,checks:results.reduce((n,r)=>n+r.checks,0),before:results.reduce((n,r)=>n+r.contradictoryCompleteBefore,0),after:results.reduce((n,r)=>n+r.contradictoryCompleteAfter,0),results}
await fs.writeFile(root+'/evaluation/holdout-consistency.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({...receipt,results:undefined},null,2));await pool.end()
