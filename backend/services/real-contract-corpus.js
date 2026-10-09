import crypto from 'node:crypto'
import { pool } from '../db.js'

export const corpusVersion = 'real-contract-evidence-v1'
const hash = text => crypto.createHash('sha256').update(text).digest('hex')
export function redactEvidence(text) {
  return String(text).replace(/(?<!\d)\d{15,19}[Xx]?(?!\d)/g,'[号码已隐去]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[手机已隐去]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[邮箱已隐去]')
}
export function buildEvidenceBundle(documents, definitions) {
  const sources=[], evidence=[], textGroups=new Map()
  for(const doc of [...documents].sort((a,b)=>a.sha256.localeCompare(b.sha256))) {
    const text=(doc.pages||[]).map(p=>p.text||'').join('\n')
    const textHash=hash(text.normalize('NFKC').replace(/\s+/g,''))
    const duplicate=textGroups.get(textHash)
    if(text.trim()) textGroups.set(textHash,duplicate||doc.sha256)
    // No learned rule or reference example from the holdout is added to runtime support.
    const split=Number.parseInt(textHash.slice(0,8),16)%5===0?'holdout':'development'
    const announcement=/合同公告|合同公示/.test(doc.source) && (doc.pages||[]).length<=3 && !/违约|争议|不可抗力/.test(text)
    const eligible=!duplicate && !announcement && text.length>=100 && doc.status!=='failed'
    sources.push({sha256:doc.sha256,source:doc.source,textHash,split,status:doc.status,
      sourceKind:doc.source_kind,provenance:doc.provenance||{},pageCount:doc.pages?.length||0,
      reviewStatus:announcement?'notice_summary_excluded':duplicate?'duplicate_text':!eligible?'text_unusable':'candidate_unreviewed',
      duplicateOf:duplicate||null})
    if(!eligible || split!=='development') continue
    for(const page of doc.pages||[]) {
      if(page.status!=='text_extracted' || (page.method==='rapidocr' && page.confidence<0.9)) continue
      const content=page.text||''
      for(const clause of definitions) {
        const keyword=clause.keywords.find(w=>content.includes(w))
        if(!keyword)continue
        const offset=content.indexOf(keyword), start=Math.max(0,offset-80),end=Math.min(content.length,offset+320)
        const original=content.slice(start,end)
        evidence.push({id:hash(doc.sha256+':'+page.page+':'+clause.code),sourceHash:doc.sha256,code:clause.code,page:page.page,
          start,end,quoteHash:hash(original),quote:redactEvidence(original),textMethod:page.method,
          confidence:page.method==='native'?null:page.confidence,reviewStatus:'candidate_unreviewed'})
      }
    }
  }
  const buildId=hash(JSON.stringify({version:corpusVersion,sources,evidence,definitions}))
  const topics=definitions.map(d=>({code:d.code,title:d.title,requirements:d.requirements,profiles:d.metadata?.profiles||[],
    candidateSourceCount:new Set(evidence.filter(e=>e.code===d.code).map(e=>e.sourceHash)).size,
    candidateEvidenceCount:evidence.filter(e=>e.code===d.code).length,
    approvedStandardSources:0,meaning:'真实合同主题证据候选；未经法律审定，不改变标准判定或等同合规条款'}))
  return {buildId,version:corpusVersion,sources,evidence,topics,legalReview:'pending',trainedModel:false}
}

export async function publishEvidenceBundle(bundle) {
  // Separate tables prevent empirical clauses from silently overwriting approved standard definitions.
  await pool.query(`CREATE TABLE IF NOT EXISTS real_contract_corpus_builds (
    build_id CHAR(64) PRIMARY KEY, version VARCHAR(80) NOT NULL, metadata_json JSON NOT NULL,
    published_at DATETIME(3) NOT NULL, INDEX idx_real_corpus_published(published_at,build_id)) ENGINE=InnoDB`)
  await pool.query(`CREATE TABLE IF NOT EXISTS real_contract_corpus_sources (
    build_id CHAR(64) NOT NULL, source_hash CHAR(64) NOT NULL, metadata_json JSON NOT NULL,
    PRIMARY KEY(build_id,source_hash)) ENGINE=InnoDB`)
  await pool.query(`CREATE TABLE IF NOT EXISTS real_contract_clause_evidence (
    build_id CHAR(64) NOT NULL, evidence_id CHAR(64) NOT NULL, clause_code VARCHAR(80) NOT NULL,
    source_hash CHAR(64) NOT NULL, page_number INT NOT NULL, evidence_json JSON NOT NULL,
    PRIMARY KEY(build_id,evidence_id), INDEX idx_real_clause(build_id,clause_code,source_hash)) ENGINE=InnoDB`)
  const db=await pool.getConnection()
  try {
    await db.beginTransaction()
    const [existing]=await db.query('SELECT build_id FROM real_contract_corpus_builds WHERE build_id=?',[bundle.buildId])
    if(existing.length){await db.rollback();return {status:'already_published',buildId:bundle.buildId}}
    for(const s of bundle.sources) await db.execute('INSERT INTO real_contract_corpus_sources VALUES (?,?,?)',[bundle.buildId,s.sha256,JSON.stringify(s)])
    for(const e of bundle.evidence) await db.execute('INSERT INTO real_contract_clause_evidence VALUES (?,?,?,?,?,?)',[bundle.buildId,e.id,e.code,e.sourceHash,e.page,JSON.stringify(e)])
    await db.execute('INSERT INTO real_contract_corpus_builds VALUES (?,?,?,?)',[bundle.buildId,bundle.version,JSON.stringify({topics:bundle.topics,legalReview:bundle.legalReview,trainedModel:false,registeredFiles:bundle.sources.length,sourceCount:new Set(bundle.evidence.map(e=>e.sourceHash)).size}),new Date()])
    await db.commit();return {status:'published_as_unreviewed_evidence',buildId:bundle.buildId}
  }catch(error){await db.rollback();throw error}finally{db.release()}
}

export async function getCorpusSupport() {
  try {
    const [rows]=await pool.query('SELECT build_id,metadata_json FROM real_contract_corpus_builds ORDER BY published_at DESC,build_id DESC LIMIT 1')
    if(!rows.length)return {status:'not_built',topics:[]}
    const data=typeof rows[0].metadata_json==='string'?JSON.parse(rows[0].metadata_json):rows[0].metadata_json
    return {status:'candidate_evidence_only',buildId:rows[0].build_id,topics:data.topics,sourceCount:data.sourceCount,
      message:'真实合同证据库已建立，候选条款未经法律审定；出现次数不等于标准有效性或比对准确率。'}
  }catch(error){return {status:error.code==='ER_NO_SUCH_TABLE'?'not_built':'unavailable',topics:[]}}
}
