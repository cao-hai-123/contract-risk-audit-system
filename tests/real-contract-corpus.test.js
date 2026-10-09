import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { buildEvidenceBundle, redactEvidence } from '../backend/services/real-contract-corpus.js'
import { getEmbeddedStandardClauses, matchClause } from '../backend/services/standard-clause-service.js'
const hash=t=>crypto.createHash('sha256').update(t).digest('hex')
const definitions=getEmbeddedStandardClauses()
const doc=(text,extra={})=>({sha256:hash(text),source:'模拟合同.pdf',source_kind:'user_supplied_unverified_origin',status:'extracted',pages:[{page:1,text,method:'native',status:'text_extracted'}],...extra})
const text='模拟合同标的为技术服务，合同价款十万元，付款按照约定的进度支付并提供发票。乙方应当按技术要求交付成果，甲方应按验收标准验收。不合格应返工，发生争议应协商，协商不成向人民法院起诉。双方联系方式变更应当通知对方。'

test('no complete status while a required element has no source evidence',()=>{
  const result=matchClause(definitions.find(d=>d.code==='price_payment'),{paragraphStructure:[{index:1,content:'合同金额为十万元，合同价款按约定付款，双方支付结算。'}]})
  assert.equal(result.status,'部分具备');assert.ok(result.missingRequirements.includes('发票或结算凭证'))
})
test('real corpus stays unreviewed and cannot become active standards or training weights',()=>{
  const b=buildEvidenceBundle([doc(text)],definitions)
  assert.equal(b.legalReview,'pending');assert.equal(b.trainedModel,false)
  assert.ok(b.topics.every(t=>t.approvedStandardSources===0))
  assert.equal(b.sources[0].sourceKind,'user_supplied_unverified_origin')
})
test('holdout never contributes runtime evidence and citations reconstruct the exact source',()=>{
  const docs=Array.from({length:25},(_,i)=>doc(text+'模拟版本'+i))
  const b=buildEvidenceBundle(docs,definitions),held=new Set(b.sources.filter(s=>s.split==='holdout').map(s=>s.sha256))
  assert.ok(held.size>0);assert.ok(b.evidence.length>0)
  for(const e of b.evidence){assert.ok(!held.has(e.sourceHash));const d=docs.find(d=>d.sha256===e.sourceHash);assert.equal(hash(d.pages[0].text.slice(e.start,e.end)),e.quoteHash)}
})
test('text duplicates cannot increase source evidence or cross the split boundary',()=>{
  const b=buildEvidenceBundle([doc(text),doc(text,{sha256:hash('binary copy')})],definitions)
  assert.equal(b.sources.filter(s=>s.reviewStatus==='duplicate_text').length,1)
  assert.equal(new Set(b.sources.map(s=>s.split)).size,1)
})
test('summary notices and unfinished or low-confidence OCR cannot provide evidence',()=>{
  const announcement=doc('采购合同公告：合同编号、采购人、供应商、合同金额、签订时间。'.repeat(8),{source:'合同公告.pdf'})
  const poor=doc(text,{pages:[{page:1,text,method:'rapidocr',confidence:.4,status:'text_extracted'}]})
  const pending=doc(text+'待识别',{pages:[{page:1,text,method:'native',status:'ocr_pending'}]})
  const b=buildEvidenceBundle([announcement,poor,pending],definitions)
  assert.equal(b.evidence.length,0);assert.equal(b.sources.find(s=>s.source===announcement.source).reviewStatus,'notice_summary_excluded')
})
test('basic identifier redaction and reproducible bundle identifiers',()=>{
  const redacted=redactEvidence('手机13800138000 邮箱demo@example.com 卡号6222021234567890123')
  assert.ok(!redacted.includes('13800138000'));assert.ok(!redacted.includes('demo@example.com'));assert.ok(!redacted.includes('6222021234567890123'))
  assert.equal(buildEvidenceBundle([doc(text)],definitions).buildId,buildEvidenceBundle([doc(text)],definitions).buildId)
})
