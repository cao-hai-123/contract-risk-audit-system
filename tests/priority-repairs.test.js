import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as vue from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { Document, Packer, Paragraph } from 'docx'
import PDFDocument from 'pdfkit'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import * as contractState from '../shared/contract-content.js'
import { createLatestRequest } from '../src/utils/latest-request.js'
import { parseContractDocument } from '../backend/services/document-parser.js'
import { analyzeContractWithDeepSeek, organizeReportParagraphsWithDeepSeek } from '../backend/services/deepseek-client.js'
import { runRuleAudit, auditContractRisk, mergeAiReview, riskRuleLibrary } from '../backend/services/risk-audit-service.js'
import { matchClause, mergeModelReview } from '../backend/services/standard-clause-service.js'
import { splitParagraphs, findSourceEvidence, reviewCandidates, requestJson } from '../backend/services/model-review-protocol.js'
import { buildVersionInput } from '../backend/services/report-management-service.js'
import { sqlLiteral } from '../backend/services/mysql-backup-service.js'

process.env.LOCAL_LLM_MODE = 'disabled'
process.env.DEEPSEEK_API_DISABLED = 'true'

export function sample(lines = ['甲方应按照约定支付人民币12345元，乙方应按期交付软件服务。'], file = '脱敏测试合同.docx') {
  return { sourceFile: file, analysisState: 'ready', parseSnapshotId: crypto.randomUUID(),
    paragraphStructure: lines.map((content, i) => ({ index: i + 1, content, page: 1, charStart: i * 100 })),
    documentParsing: { textLength: lines.join('\n').length, warnings: [], coverage: { complete: true } },
    keyElements: {}, contractType: { predicted: '服务外包合同' }, ai: { used: false, status: 'missing_api_key' }, ocr: { required: false } }
}
const disabled = async () => ({ status: 'disabled', decisions: [] })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const jsonResponse = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload })
function vueSetup(file, fetchImpl, props = {}) {
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'))
  const compiled = compileScript(descriptor, { id: file, genDefaultAs: '__component' })
  const imports = {}
  let code = compiled.content.replace(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_, bindings, source) => {
    if (bindings.trim().startsWith('{')) {
      for (const entry of bindings.replace(/[{}]/g, '').split(',')) {
        const [name, alias] = entry.trim().split(/\s+as\s+/)
        imports[alias || name] = source === 'vue' ? vue[name] : name === 'createLatestRequest' ? createLatestRequest : contractState[name] || {}
      }
    } else imports[bindings.trim()] = {}
    return ''
  })
  code += '\n;globalThis.result = __component.setup(props, { expose() {}, emit: (...args) => emitted.push(args) });'
  const context = { ...imports, props: vue.reactive(props), emitted: [], fetch: fetchImpl, Error, AbortController, FormData, File, Blob, URL, crypto, structuredClone, console,
    localStorage: { getItem: () => null, setItem() {} },
    window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {}, setTimeout },
    document: { getElementById: () => ({ value: '', click() {} }), body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }) } }
  vm.createContext(context); new vm.Script(code, { filename: file }).runInContext(context)
  return { state: context.result, props: context.props, emitted: context.emitted }
}

test('all Vue scripts and templates compile', () => {
  for (const file of ['src/App.vue', ...fs.readdirSync('src/components').filter((name) => name.endsWith('.vue')).map((name) => 'src/components/' + name)]) {
    const { descriptor, errors } = parse(fs.readFileSync(file, 'utf8'))
    assert.equal(errors.length, 0)
    compileScript(descriptor, { id: file })
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: file, id: file }).errors, [])
  }
})
test('D01 failed upload holds no demo or previous contract data', async () => {
  const { state } = vueSetup('src/App.vue', async () => { throw new Error('Failed to fetch') })
  await state.runBackendParse(new File(['bad'], '失败合同.pdf'))
  assert.equal(state.parsedContract.value.analysisState, 'failed')
  assert.equal(state.parsedContract.value.paragraphStructure.length, 0)
  assert.deepEqual(Object.keys(state.parsedContract.value.keyElements), [])
  assert.equal(state.canAnalyze.value, false)
  assert.match(state.parseError.value, /npm run dev/)
})
test('D01 later upload wins even when aborted fetch resolves afterward', async () => {
  const a = deferred(), b = deferred(); let calls = 0
  const { state } = vueSetup('src/App.vue', () => (++calls === 1 ? a.promise : b.promise))
  const first = state.runBackendParse(new File(['a'], '旧合同.docx'))
  const second = state.runBackendParse(new File(['b'], '新合同.docx'))
  b.resolve(jsonResponse({ parsed: sample(undefined, '新合同.docx') })); await second
  a.resolve(jsonResponse({ parsed: sample(undefined, '旧合同.docx') })); await first
  assert.equal(state.parsedContract.value.sourceFile, '新合同.docx')
  assert.equal(state.isParsing.value, false)
})
test('D01 reset invalidates in-flight upload and unsupported selection clears data', async () => {
  const pending = deferred()
  const { state } = vueSetup('src/App.vue', () => pending.promise)
  const active = state.runBackendParse(new File(['a'], '旧合同.docx'))
  state.resetDemo()
  pending.resolve(jsonResponse({ parsed: sample() })); await active
  assert.equal(state.parsedContract.value.analysisState, 'demo')
  await state.handleFileChange({ target: { files: [new File(['x'], '不支持.exe')], value: 'x' } })
  assert.equal(state.parsedContract.value.analysisState, 'failed')
  assert.equal(state.canAnalyze.value, false)
})
test('D13 contract switch clears dialogue and ignores old assistant response', async () => {
  const pending = deferred()
  const { state, props } = vueSetup('src/components/ContractAssistantFloat.vue', () => pending.promise, { contract: sample() })
  const active = state.sendQuestion('请概括旧合同。')
  props.contract = sample(['新合同明确采用月结方式付款。'], '新合同.docx')
  await vue.nextTick()
  pending.resolve(jsonResponse({ reply: { engine: {}, answer: '旧合同答案', citations: [] } })); await active
  assert.equal(state.messages.value.length, 0)
  assert.equal(state.isSending.value, false)
  assert.equal(state.allowWebSearch.value, false)
})
test('shared guards reject demo, failed and empty inputs', () => {
  for (const state of ['demo', 'failed', 'parsing', 'empty']) assert.equal(contractState.hasUsableContract({ ...sample(), analysisState: state }), false)
  assert.throws(() => contractState.assertUsableContract({ paragraphStructure: [] }), /上传/)
})
test('D02 cannot add known but non-candidate risk or invented evidence', () => {
  const contract = sample(['乙方对服务事故承担一切责任，赔偿甲方全部损失。'])
  const baseline = runRuleAudit(contract)
  const result = mergeAiReview({ status: 'success', decisions: [
    { candidateId: 'unilateral_change', decision: 'retain', evidence: [{ paragraphIndex: 1, quote: '这是虚构的原文依据。' }] },
    { candidateId: 'unlimited_liability', decision: 'retain', evidence: [{ paragraphIndex: 1, quote: '另一段虚构的原文依据。' }] }
  ] }, baseline, contract)
  assert.deepEqual(result.audit.risks, baseline.risks)
  assert.equal(result.stage.acceptedDecisions, 0)
  assert.equal(result.stage.ignoredDecisions, 2)
})
test('D02 empty decisions preserve candidates; unsupported rejection stays flagged', () => {
  const contract = sample(['乙方承担一切责任并赔偿甲方全部损失。'])
  const baseline = runRuleAudit(contract)
  assert.deepEqual(mergeAiReview({ status: 'success', decisions: [] }, baseline, contract).audit.risks, baseline.risks)
  const result = mergeAiReview({ status: 'success', decisions: [{ candidateId: 'unlimited_liability', decision: 'reject', reasonCode: 'uncertain',
    evidence: [{ paragraphIndex: 1, quote: contract.paragraphStructure[0].content }] }] }, baseline, contract)
  assert.equal(result.audit.risks[0].reviewStatus, 'needs_human_review')
  assert.equal(result.audit.rejectedFindings.length, 0)
})
test('D02 verified reciprocal termination can explicitly reject an imbalance candidate', () => {
  const contract = sample(['双方均有权单方解除本合同，但应提前三十日书面通知对方。'])
  const baseline = runRuleAudit(contract)
  assert.ok(baseline.risks.some((item) => item.ruleId === 'unilateral_termination'))
  const result = mergeAiReview({ status: 'success', decisions: [{ candidateId: 'unilateral_termination', decision: 'reject', reasonCode: 'reciprocal',
    evidence: [{ paragraphIndex: 1, quote: contract.paragraphStructure[0].content }] }] }, baseline, contract)
  assert.ok(!result.audit.risks.some((item) => item.ruleId === 'unilateral_termination'))
  assert.equal(result.audit.rejectedFindings.length, 1)
})
test('D08 provider truthfully excludes unavailable local model and reports cloud failure', async () => {
  const contract = sample(['乙方承担一切责任并赔偿甲方全部损失。'])
  const cloudReview = async () => ({ status: 'success', coverage: { complete: true }, decisions: [{ candidateId: 'unlimited_liability', decision: 'retain',
    evidence: [{ paragraphIndex: 1, quote: contract.paragraphStructure[0].content }] }] })
  const cloud = await auditContractRisk(contract, { allowCloudReview: true, dependencies: { loadRules: async () => riskRuleLibrary, localReview: disabled, cloudReview } })
  assert.match(cloud.engine.provider, /DeepSeek/)
  assert.doesNotMatch(cloud.engine.provider, /Qwen/)
  const failed = await auditContractRisk(contract, { allowCloudReview: true, dependencies: { loadRules: async () => riskRuleLibrary, localReview: disabled, cloudReview: async () => { throw new Error('offline') } } })
  assert.equal(failed.engine.stages.cloud.status, 'connection_failed')
  assert.equal(failed.engine.status, 'hybrid_rule_based')
})
test('D08 default-off cloud review never invokes cloud dependency', async () => {
  let calls = 0
  await auditContractRisk(sample(), { dependencies: { loadRules: async () => riskRuleLibrary, localReview: disabled, cloudReview: async () => { calls++; throw Error() } } })
  assert.equal(calls, 0)
})

test('D02 a model calling an affirmative risk negated cannot remove it or claim participation', async () => {
  const contract = sample(['乙方承担一切责任并赔偿甲方全部损失。'])
  const result = await auditContractRisk(contract, { dependencies: { loadRules: async () => riskRuleLibrary, localReview: async () => ({ status: 'success', coverage: { complete: true },
    decisions: [{ candidateId: 'unlimited_liability', decision: 'reject', reasonCode: 'negated', evidence: [{ paragraphIndex: 1, quote: contract.paragraphStructure[0].content }] }] }) } })
  assert.ok(result.risks.some((item) => item.ruleId === 'unlimited_liability'))
  assert.equal(result.engine.stages.local.status, 'no_verifiable_decisions')
  assert.doesNotMatch(result.engine.provider, /Qwen|DeepSeek/)
})
test('D06 unrelated payment term cannot complete confidentiality', () => {
  const result = runRuleAudit(sample(['保密。', '付款期限为三天。']))
  assert.ok(result.missingClauses.some((item) => item.ruleId === 'missing_confidentiality'))
})
const delivery = { code: 'delivery_acceptance', category: '交付验收', title: '交付验收', keywords: ['交付', '验收', '成果', '质量标准', '整改'],
  requirements: ['交付物', '验收标准', '验收期限', '不合格处理'], suggestion: '明确验收机制。' }
test('D06 unrelated paragraphs do not form a complete delivery clause', () => {
  const contract = sample(['交付待定。', '检查资料。', '工作日召开会议。', '其他费用赔偿。', '研究成果另行归档。'])
  const result = matchClause(delivery, contract)
  assert.notEqual(result.status, '完整')
  assert.ok(result.missingRequirements.includes('验收标准'))
  assert.ok(result.missingRequirements.includes('验收期限'))
})
test('D06 a real coherent delivery clause remains complete', () => {
  const contract = sample(['乙方交付软件成果，甲方按质量标准验收并确认，交付后三个工作日内完成检查；不合格应整改或返工。'])
  assert.equal(matchClause(delivery, contract).status, '完整')
})

test('malformed paragraph payloads are rejected as invalid contracts', () => {
  for (const paragraphStructure of [{ content: '不是段落数组' }, '不是段落数组', 17, null]) {
    assert.equal(contractState.hasUsableContract({ paragraphStructure }), false)
    assert.throws(() => contractState.assertUsableContract({ paragraphStructure }), { status: 422 })
  }
})

test('standard model evidence with invalid array shape cannot change results', () => {
  const contract = sample(['乙方向甲方交付软件成果，其他安排待定。'])
  const initial = matchClause(delivery, contract)
  for (const evidence of [{ paragraphIndex: 1, quote: contract.paragraphStructure[0].content }, 'invalid', null]) {
    const result = mergeModelReview([initial], { status: 'success', decisions: [{ candidateId: delivery.code, decision: 'retain', status: '完整', evidence, requirementEvidence: [null] }] }, contract, [delivery])
    assert.deepEqual(result.items[0], initial)
  }
})

test('report review response cannot replace a subsequently selected report', async () => {
  const pending = deferred()
  const { state } = vueSetup('src/components/ReportManagementPanel.vue', () => pending.promise, { contract: sample() })
  state.selectReport({ id: 'first', status: '待人工确认', sourceFile: '第一份脱敏合同.docx' })
  const save = state.saveReview()
  state.selectReport({ id: 'second', status: '需复核', sourceFile: '第二份脱敏合同.docx' })
  pending.resolve(jsonResponse({ report: { id: 'first', status: '已人工确认' } }))
  await save
  assert.equal(state.currentReport.value.id, 'second')
  assert.equal(state.reviewStatus.value, '需复核')
})

test('report generation ignores an old contract response after switching inputs', async () => {
  const pending = deferred()
  const { state, props, emitted } = vueSetup('src/components/ReportManagementPanel.vue', () => pending.promise, { contract: sample() })
  const run = state.prepareReport()
  props.contract = sample(['第二份脱敏合同约定软件服务费用人民币12345元。'], 'second.docx')
  await vue.nextTick()
  pending.resolve(jsonResponse({ report: { id: 'old', snapshot: { audit: {}, match: {} } } }))
  await run
  assert.equal(state.currentReport.value, null)
  assert.equal(emitted.length, 0)
})
test('D15 model cannot upgrade on fabricated quote or downgrade deterministic completeness', () => {
  const contract = sample(['乙方交付软件成果，甲方按质量标准验收并确认，交付后三个工作日内完成检查；不合格应整改或返工。'])
  const complete = matchClause(delivery, contract)
  const result = mergeModelReview([complete], { status: 'success', decisions: [{ candidateId: delivery.code, decision: 'retain', status: '缺失',
    evidence: [{ paragraphIndex: 1, quote: contract.paragraphStructure[0].content }] }] }, contract, [delivery])
  assert.equal(result.items[0].status, '完整')
  const partialContract = sample(['乙方将在双方约定的日期交付软件成果。'])
  const partial = matchClause(delivery, partialContract)
  const forged = mergeModelReview([partial], { status: 'success', decisions: [{ candidateId: delivery.code, decision: 'retain', status: '完整',
    evidence: [{ paragraphIndex: 1, quote: '虚构的验收条款内容，不存在于合同中。' }] }] }, partialContract, [delivery])
  assert.equal(forged.items[0].status, partial.status)
})
test('D09 inferred field/type/title changes do not change recognized-content version', () => {
  const contract = sample()
  const changed = structuredClone(contract)
  changed.keyElements.amount = '模型产生的另一金额'
  changed.contractType.predicted = '采购合同'
  changed.paragraphStructure[0].title = '另一语义标题'
  assert.equal(buildVersionInput(contract).contentHash, buildVersionInput(changed).contentHash)
  changed.paragraphStructure[0].content += '新增了实际约定。'
  assert.notEqual(buildVersionInput(contract).contentHash, buildVersionInput(changed).contentHash)
})
test('D03 UTF-8 hex SQL literal round-trips quotes, slashes, emoji, NUL and newlines', () => {
  const value = JSON.stringify({ text: '模拟"双引号" 单引号\' 反斜杠\\ 换行\n中文🙂\u0000' })
  const literal = sqlLiteral(value)
  assert.equal(Buffer.from(literal.match(/X'([a-f0-9]*)'/)[1], 'hex').toString('utf8'), value)
  assert.equal(sqlLiteral(null), 'NULL')
})
test('D05 chunking preserves every character and final paragraph, including surrogate pairs', () => {
  const paragraphs = Array.from({ length: 605 }, (_, i) => ({ index: i + 1, content: '第' + (i + 1) + '段🙂正文' }))
  const chunks = splitParagraphs(paragraphs, 17)
  const text = chunks.flat().map((part) => part.text).join('')
  assert.equal(text, paragraphs.map((p) => p.content).join(''))
  assert.match(chunks.at(-1).at(-1).text, /正文/)
  assert.throws(() => splitParagraphs(paragraphs, 1), RangeError)
})
test('D05 actual 605-paragraph DOCX is not truncated and trailing risk remains visible', async () => {
  const lines = Array.from({ length: 604 }, (_, i) => '第' + (i + 1) + '段为脱敏模拟的合同正文内容。')
  lines.push('乙方承担一切责任并赔偿甲方全部损失。')
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: lines.map((text) => new Paragraph(text)) }] }))
  const parsed = await parseContractDocument({ originalname: '长合同.docx', buffer })
  assert.equal(parsed.paragraphs.length, 605)
  assert.equal(parsed.paragraphs.at(-1).content, lines.at(-1))
  assert.ok(runRuleAudit({ ...sample(), paragraphStructure: parsed.paragraphs }).risks.some((r) => r.paragraphIndex === 605))
})
test('D08 empty cloud JSON and all-unknown extraction fall back truthfully', async () => {
  const contract = sample(), parserResult = { text: contractState.recognizedText(contract), paragraphs: contract.paragraphStructure, warnings: [], ocr: {} }
  const result = await analyzeContractWithDeepSeek({ text: parserResult.text, fileName: contract.sourceFile, parserResult,
    dependencies: { loadRules: async () => riskRuleLibrary, apiKey: 'test', request: async () => ({}) } })
  assert.equal(result.ai.used, false)
  assert.equal(result.ai.status, 'invalid_output')
  assert.equal(result.ai.provider, '本地规则解析')
  assert.equal(result.ai.requestedProvider, 'DeepSeek')
  const unknown = await analyzeContractWithDeepSeek({ text: parserResult.text, fileName: contract.sourceFile, parserResult,
    dependencies: { loadRules: async () => riskRuleLibrary, apiKey: 'test', request: async () => ({ contractType: { predicted: '服务外包合同' }, keyElements: Object.fromEntries(['parties','signedDate','amount','performancePeriod','disputeResolution'].map((key) => [key, '未识别'])) }) } })
  assert.equal(unknown.ai.status, 'empty_extraction')
})
test('D05 extraction sends final text chunk and fails over completely on later error', async () => {
  const contract = sample(Array.from({ length: 90 }, (_, i) => '第' + i + '段' + '模拟履约安排。'.repeat(40)))
  let prompts = []
  const parserResult = { text: contractState.recognizedText(contract), paragraphs: contract.paragraphStructure, warnings: [], ocr: {} }
  const request = async ({ prompt }) => { prompts.push(prompt); return { contractType: { predicted: '服务外包合同' }, keyElements: { parties: '模拟甲方和乙方', signedDate: '未识别', amount: '未识别', performancePeriod: '未识别', disputeResolution: '未识别' } } }
  const result = await analyzeContractWithDeepSeek({ text: parserResult.text, fileName: contract.sourceFile, parserResult, dependencies: { loadRules: async () => riskRuleLibrary, apiKey: 'test', request } })
  assert.ok(prompts.length > 1)
  assert.ok(prompts.at(-1).includes('第89段'))
  assert.equal(result.ai.coverage.complete, true)
  let calls = 0
  const failed = await analyzeContractWithDeepSeek({ text: parserResult.text, fileName: contract.sourceFile, parserResult,
    dependencies: { loadRules: async () => riskRuleLibrary, apiKey: 'test', request: async (input) => { if (++calls > 1) throw new Error('offline'); return request(input) } } })
  assert.equal(failed.ai.used, false)
  assert.equal(failed.paragraphStructure.length, 90)
  assert.equal(failed.ai.coverage.complete, false)
})
test('D05 semantic grouping preserves all paragraphs and rejects omissions/rewrites', async () => {
  const contract = sample(Array.from({ length: 200 }, (_, i) => '第' + (i + 1) + '段：不可删除的原始合同正文。'))
  const result = await organizeReportParagraphsWithDeepSeek(contract, { apiKey: 'test', request: async ({ prompt }) => {
    const { paragraphs } = JSON.parse(prompt)
    return { sections: [{ title: '语义分组', paragraphIds: paragraphs.map((p) => p.id) }] }
  } })
  assert.equal(result.provider, 'DeepSeek')
  assert.equal(result.sections.flatMap((s) => s.paragraphs).map((p) => p.text).join(''), contract.paragraphStructure.map((p) => p.content).join(''))
  const fallback = await organizeReportParagraphsWithDeepSeek(contract, { apiKey: 'test', request: async () => ({ sections: [{ title: '伪造', paragraphIds: ['fake'] }] }) })
  assert.equal(fallback.provider, '本地规则')
  assert.equal(fallback.sections[0].paragraphs.length, 200)
})
test('source quotes require exact content and matching paragraph identity', () => {
  const contract = sample()
  assert.equal(findSourceEvidence(contract, { paragraphIndex: 99, quote: contract.paragraphStructure[0].content }), null)
  assert.equal(findSourceEvidence(contract, { paragraphIndex: 1, quote: '一段从未出现过的文字' }), null)
  assert.equal(findSourceEvidence(contract, { paragraphIndex: 1, quote: contract.paragraphStructure[0].content }).charStart, 0)
})
test('model JSON transport rejects empty content and classifies bounded partial review', async () => {
  await assert.rejects(() => requestJson({ endpoint: 'https://invalid.test', prompt: '', fetchImpl: async () => jsonResponse({ choices: [] }) }), /结构化/)
  const contract = sample(['合同模拟条款。'.repeat(100)])
  let calls = 0
  const result = await reviewCandidates({ contract, candidates: [{ candidateId: 'x' }], kind: 'risk', sourceBudget: 50,
    request: async () => { if (++calls === 2) throw Object.assign(new Error(), { httpStatus: 429 }); return { decisions: [] } } })
  assert.equal(result.status, 'partial')
  assert.equal(result.failureClass, 'rate_limited')
  assert.equal(result.coverage.complete, false)
})

async function pdfBuffer(write) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 })
  const parts = []; doc.on('data', (part) => parts.push(part))
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(parts))))
  write(doc); doc.end(); return done
}
test('D04 blank PDF cannot become a page-marker contract', async () => {
  const buffer = await pdfBuffer(() => {})
  const parsed = await parseContractDocument({ originalname: '空白.pdf', buffer, }, { ocrFactory: async () => { throw new Error('blank pages need no OCR') } })
  assert.equal(parsed.text.trim(), '')
  assert.equal(parsed.paragraphs.length, 0)
  assert.equal(parsed.pages[0].status, 'blank')
})
test('D04 real scan and mixed PDF OCR preserves page evidence and text layers', { timeout: 120000 }, async () => {
  GlobalFonts.registerFromPath('C:/Windows/Fonts/simfang.ttf', 'RepairTest')
  const canvas = createCanvas(1300, 520), ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1300, 520); ctx.fillStyle = 'black'; ctx.font = '42px RepairTest'
  ctx.fillText('模拟合同金额人民币12345元。', 50, 100)
  ctx.fillText('甲方应在验收后十日内支付款项。', 50, 190)
  ctx.fillText('双方发生争议应先协商解决。', 50, 280)
  const png = canvas.toBuffer('image/png')
  const buffer = await pdfBuffer((doc) => {
    doc.image(png, 40, 50, { width: 500 })
    doc.addPage().font('Helvetica').fontSize(14).text('Native contract header with more than twenty characters.')
    doc.image(png, 40, 130, { width: 500 })
    doc.addPage()
  })
  const parsed = await parseContractDocument({ originalname: '扫描混合脱敏合同.pdf', buffer })
  assert.equal(parsed.coverage.complete, true, JSON.stringify(parsed.warnings))
  assert.equal(parsed.ocr.status, 'success')
  assert.ok(parsed.pages[0].method.includes('ocr'))
  assert.ok(parsed.pages[1].method.includes('ocr'))
  assert.match(parsed.pages[1].text, /Native contract header/)
  assert.match(parsed.pages[0].text.replace(/\s/g, ''), /12345/)
  assert.match(parsed.pages[0].text.replace(/\s/g, ''), /合同金额人民币/)
  assert.ok(parsed.paragraphs.some((p) => p.page === 2 && p.content.includes('12345')))
  assert.equal(parsed.pages[2].status, 'blank')
})
test('D04 unreadable scan is explicitly incomplete and worker is terminated', async () => {
  const canvas = createCanvas(300, 150), ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 300, 150); ctx.fillStyle = 'black'; ctx.fillRect(40, 40, 200, 20)
  const buffer = await pdfBuffer((doc) => doc.image(canvas.toBuffer('image/png'), 40, 40))
  let terminated = false
  const parsed = await parseContractDocument({ originalname: '不可识别扫描.pdf', buffer },
    { ocrFactory: async () => ({ recognize: async () => { throw new Error('recognition failed') }, terminate: async () => { terminated = true } }) })
  assert.equal(parsed.coverage.complete, false)
  assert.deepEqual(parsed.coverage.failedPages, [1])
  assert.equal(terminated, true)
})
