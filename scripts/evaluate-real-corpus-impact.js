import fs from 'node:fs/promises'
import path from 'node:path'
import { matchClause, getEmbeddedStandardClauses, matchStandardClauses } from '../backend/services/standard-clause-service.js'
import { parseContractDocument } from '../backend/services/document-parser.js'
import { pool } from '../backend/db.js'

// Synthetic diagnostic controls, not a human-labelled real-world accuracy benchmark.
const controls = [
  ['price_payment','合同金额为十万元，合同价款按约定付款，双方支付结算。','部分具备'],
  ['price_payment','合同金额为十万元，合同价款按约定付款，双方支付结算，提供发票。','完整'],
  ['change_termination','合同变更、解除、终止均应协商一致，提前三十日书面通知。','部分具备'],
  ['change_termination','合同变更、解除、终止均应协商一致，提前三十日书面通知，终止后结清费用并交接。','完整'],
  ['force_majeure','不可抗力不能履行时应及时通知并提供证明。','部分具备'],
  ['force_majeure','不可抗力不能履行时应及时通知并提供证明，双方协商延期履行。','完整'],
  ['confidentiality','保密范围为秘密信息及数据知识产权，保密义务要求不得泄露商业秘密。','部分具备'],
  ['confidentiality','保密范围为秘密信息及数据知识产权，保密义务要求不得泄露商业秘密，保密期限三年。','完整'],
  ['subject_scope','标的是提供服务内容，项目内容及工作内容为交付货物，范围为十件。','部分具备'],
  ['subject_scope','标的是提供服务内容，项目内容及工作内容为交付货物，范围为十件，质量符合国家标准。','完整'],
  ['notice','通知应以电子邮件送达约定地址，联系方式载于本合同。','部分具备'],
  ['notice','通知应以电子邮件送达约定通讯地址，联系方式变更应书面通知。','完整'],
  ['delivery_acceptance','交付成果，验收合格后十日内付款，乙方提供日常修复服务。','部分具备'],
  ['delivery_acceptance','交付成果，按技术标准验收，收到后五日内验收，不合格应返工。','完整']
]
const definitions = getEmbeddedStandardClauses()
const controlsResult = controls.map(([code,text,expected],i) => {
  const result = matchClause(definitions.find(d=>d.code===code),{paragraphStructure:[{index:1,content:text}]})
  return {id:i+1,code,expected,actual:result.status,passed:result.status===expected,missing:result.missingRequirements,
    contradictoryComplete:result.status==='完整' && result.missingRequirements.length>0}
})
const external=[]
for(const file of ['dongguan-housing-rental-contract.docx','shanghai-affordable-rental-housing-contract.pdf','dongguan-market-management-service-contract.docx']) {
  const parsed=await parseContractDocument({originalname:file,buffer:await fs.readFile(path.resolve('tests/fixtures/external-contracts',file))})
  const result=await matchStandardClauses({sourceFile:file,paragraphStructure:parsed.paragraphs},{dependencies:{loadClauses:async()=>definitions,localReview:async()=>({status:'disabled',decisions:[]})}})
  external.push({file,parseComplete:parsed.coverage.complete,...result.summary,
    contradictions:result.items.filter(r=>r.status==='完整'&&r.missingRequirements.length).length})
}
const receipt={at:new Date().toISOString(),kind:'synthetic_diagnostic_plus_external_smoke_not_population_accuracy',controls:controlsResult,
  diagnosticAccuracy:controlsResult.filter(r=>r.passed).length/controls.length,external}
await fs.mkdir('data/real-contract-corpus/evaluation',{recursive:true})
const phase=process.argv.includes('--before')?'before':'after'
await fs.writeFile(`data/real-contract-corpus/evaluation/${phase}.json`,JSON.stringify(receipt,null,2))
console.log(JSON.stringify(receipt,null,2))
await pool.end()
