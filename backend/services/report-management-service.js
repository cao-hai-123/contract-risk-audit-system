import { contractMetadataRows, evidenceLocation } from './report-content.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import { PassThrough } from 'node:stream'
import { createManagedReport, findOrCreateContractVersion, getManagedReport, listContractVersions, listManagedReports, updateManagedReportReview } from '../db.js'
import { auditContractRisk } from './risk-audit-service.js'
import { matchStandardClauses } from './standard-clause-service.js'
import { buildManagedAuditReportDocx } from './report-generator.js'
import { contentFingerprint, saveAnalysisRun, resolveAnalysisRun } from './contract-integrity-service.js'
import { assertUsableContract } from '../../shared/contract-content.js'

const allowedReviewStates = new Set(['待人工确认', '已人工确认', '需复核'])
const chineseFontPath = process.env.REPORT_FONT_PATH || 'C:\\Windows\\Fonts\\simfang.ttf'

export async function prepareManagedReport(contract, { allowCloudReview = false, auditRunId, matchRunId } = {}) {
  assertUsableContract(contract)
  // Reuse immutable results already seen by the user; only missing analyses are run.
  const audit = auditRunId ? await resolveAnalysisRun(contract, 'risk', auditRunId)
    : await saveAnalysisRun(contract, 'risk', await auditContractRisk(contract, { allowCloudReview }))
  const match = matchRunId ? await resolveAnalysisRun(contract, 'standard', matchRunId)
    : await saveAnalysisRun(contract, 'standard', await matchStandardClauses(contract, { allowCloudReview }))
  const versionInput = buildVersionInput(contract)
  const versionResult = await findOrCreateContractVersion(versionInput)
  const snapshot = { contract: normalizeContractSnapshot(contract), audit, match, preparedAt: new Date().toISOString() }
  const report = await createManagedReport({
    contractVersionId: versionResult.version.id,
    sourceFile: snapshot.contract.sourceFile,
    contractType: snapshot.contract.contractType?.predicted || '未识别',
    snapshot
  })
  return { report: { ...report, versionNumber: versionResult.version.versionNumber, changeSummary: versionResult.version.changeSummary }, version: versionResult.version, isNewVersion: versionResult.created }
}

export async function listReportManagementData() {
  const [reports, versions] = await Promise.all([listManagedReports(), listContractVersions()])
  return { reports, versions }
}

export async function setManagedReportReview(id, status, reviewerNote) {
  if (!allowedReviewStates.has(status)) throw new Error('报告复核状态仅支持待人工确认、已人工确认或需复核。')
  const report = await updateManagedReportReview(id, status, reviewerNote)
  if (!report) throw new Error('未找到需要更新的报告。')
  return report
}

export async function exportManagedReport(id, format) {
  const report = await getManagedReport(id)
  if (!report) throw new Error('未找到需要导出的报告。')
  const normalizedFormat = String(format || '').toLowerCase()
  if (normalizedFormat === 'word') return { report, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx', buffer: await buildManagedAuditReportDocx(report) }
  if (normalizedFormat === 'html') return { report, contentType: 'text/html; charset=utf-8', extension: 'html', buffer: Buffer.from(buildManagedReportHtml(report), 'utf8') }
  if (normalizedFormat === 'pdf') return { report, contentType: 'application/pdf', extension: 'pdf', buffer: await buildManagedReportPdf(report) }
  throw new Error('仅支持导出 Word、HTML 或 PDF 格式。')
}

export function safeReportFileStem(value) {
  return String(value || 'contract-report').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'contract-report'
}

export function buildVersionInput(contract) {
  const sourceFile = String(contract.sourceFile || '未命名合同')
  const normalizedSource = sourceFile.normalize('NFC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ')
  const contractKey = crypto.createHash('sha256').update(normalizedSource).digest('hex')
  const contentHash = contentFingerprint(contract)
  const summary = {
    fingerprintVersion: 'recognized-text-v2',
    contractType: contract.contractType?.predicted || '未识别',
    textLength: Number(contract.documentParsing?.textLength || 0),
    paragraphCount: Array.isArray(contract.paragraphStructure) ? contract.paragraphStructure.length : 0,
    keyElements: Object.keys(contract.keyElements || {}).filter((key) => Boolean(contract.keyElements[key])).length
  }
  return { contractKey, contentHash, sourceFile, summary, changeSummary: `基于当前可识别文本生成；共 ${summary.paragraphCount} 个段落，已识别 ${summary.keyElements} 项关键要素。` }
}

function normalizeContractSnapshot(contract) {
  return structuredClone(contract)
}

function buildManagedReportHtml(report) {
  const contract = report.snapshot?.contract || {}
  const audit = report.snapshot?.audit || {}
  const match = report.snapshot?.match || {}
  const findings = [...(audit.risks || []), ...(audit.missingClauses || [])]
  const incomplete = (match.items || []).filter((item) => item.status !== '完整')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>企业合同统一审核报告</title><style>body{margin:0;background:#f3f4f5;color:#1f1f1f;font-family:SimSun,"Microsoft YaHei",serif;line-height:1.75}.page{max-width:900px;margin:32px auto;padding:48px;background:#fff;border:1px solid #d0d0d0}h1{text-align:center;margin:0 0 8px;font-size:28px}h2{margin:30px 0 12px;font-size:18px;border-left:4px solid #444;padding-left:10px}.meta{text-align:center;color:#555;margin:0 0 28px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px 11px;border:1px solid #bdbdbd;text-align:left;vertical-align:top}th{width:180px;background:#f1f1f1}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stats div{padding:12px;border:1px solid #cfcfcf;background:#fafafa}.stats span,.stats strong{display:block}.stats span{font-size:12px;color:#555}.stats strong{margin-top:3px;font-size:20px}article{margin:13px 0;padding:14px;border:1px solid #d3d3d3}article h3{margin:0 0 8px;font-size:16px}article p{margin:6px 0}.note{color:#555;font-size:12px}</style></head><body><main class="page"><h1>企业合同统一审核报告</h1><p class="meta">版本 V${report.versionNumber || 1}　生成时间：${escapeHtml(formatDate(report.createdAt))}</p><h2>一、审核结果概览</h2><table>${contractMetadataRows(report).map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}<tr><th>审核文件</th><td>${escapeHtml(contract.sourceFile || report.sourceFile)}</td></tr><tr><th>合同类型</th><td>${escapeHtml(contract.contractType?.predicted || report.contractType)}</td></tr><tr><th>人工复核状态</th><td>${escapeHtml(report.status)}</td></tr><tr><th>风险等级</th><td>${escapeHtml(audit.summary?.overallLevel || '待评估')}</td></tr><tr><th>风险评分</th><td>${escapeHtml(`${audit.summary?.score ?? '待评估'} / 100`)}</td></tr><tr><th>完整性评价</th><td>${escapeHtml(match.summary?.overall || '待评估')}</td></tr></table><h2>二、风险统计</h2><section class="stats"><div><span>高风险</span><strong>${audit.summary?.high || 0}</strong></div><div><span>中风险</span><strong>${audit.summary?.medium || 0}</strong></div><div><span>低风险</span><strong>${audit.summary?.low || 0}</strong></div><div><span>缺失条款</span><strong>${audit.summary?.missing || 0}</strong></div></section><h2>三、风险与缺失条款</h2>${findings.length ? findings.map((item, index) => `<article><h3>${index + 1}. ${escapeHtml(item.title || '审核事项')}（${escapeHtml(item.level || '待评估')}）</h3><p>原文位置：${escapeHtml(evidenceLocation(item))}</p><p>识别依据：${escapeHtml(item.evidence || '未在已解析文本中识别到完整条款。')}</p><p>审核说明：${escapeHtml(item.reason || '未提供')}</p><p>修改建议：${escapeHtml(item.suggestion || '请结合交易实际情况补充或调整。')}</p></article>`).join('') : '<p>本次未识别出需列示的风险或缺失条款。</p>'}<h2>四、标准条款完整性</h2><p>完整 ${match.summary?.complete || 0} 项；部分具备 ${match.summary?.partial || 0} 项；缺失 ${match.summary?.missing || 0} 项。</p>${incomplete.length ? incomplete.map((item, index) => `<article><h3>${index + 1}. ${escapeHtml(item.title || '标准条款')}（${escapeHtml(item.status || '待评估')}）</h3><p>原文位置：${escapeHtml(evidenceLocation(item))}</p><p>识别依据：${escapeHtml(item.evidence || '未提供')}</p><p>完善建议：${escapeHtml(item.suggestion || '请结合合同实际情况补充。')}</p></article>`).join('') : '<p>未识别出需要补充的标准条款要素。</p>'}<h2>五、合同版本与人工确认</h2><p>${escapeHtml(report.changeSummary || '初始版本：基于当前可识别文本生成。')}</p><p>复核备注：${escapeHtml(report.reviewerNote || '尚未填写人工复核备注。')}</p><p class="note">本报告仅用于合同审阅辅助，不构成法律意见或最终法律结论。</p></main></body></html>`
}

function buildManagedReportPdf(report) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 56, info: { Title: '企业合同统一审核报告', Author: '企业合同智能审核与风险预警系统' } })
    const output = new PassThrough()
    const chunks = []
    output.on('data', (chunk) => chunks.push(chunk))
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
    document.on('error', reject)
    document.pipe(output)
    if (!fs.existsSync(chineseFontPath)) { document.end(); reject(Object.assign(new Error('缺少中文 PDF 字体，请配置 REPORT_FONT_PATH 后重试。'), { status: 503 })); return }
    document.font(chineseFontPath)

    const contract = report.snapshot?.contract || {}
    const audit = report.snapshot?.audit || {}
    const match = report.snapshot?.match || {}
    const findings = [...(audit.risks || []).map((item) => ({ ...item, kind: '风险条款' })), ...(audit.missingClauses || []).map((item) => ({ ...item, kind: '缺失条款' }))]
    const incomplete = (match.items || []).filter((item) => item.status !== '完整')
    writePdfTitle(document, '企业合同统一审核报告')
    writePdfLine(document, `版本 V${report.versionNumber || 1}　生成时间：${formatDate(report.createdAt)}`, 10, '#555555', 'center')
    writePdfSection(document, '一、审核结果概览')
    writePdfRows(document, [
      ...contractMetadataRows(report),
      ['审核文件', contract.sourceFile || report.sourceFile], ['合同类型', contract.contractType?.predicted || report.contractType], ['人工复核状态', report.status], ['综合风险等级', audit.summary?.overallLevel || '待评估'], ['风险评分', `${audit.summary?.score ?? '待评估'} / 100`], ['完整性评价', match.summary?.overall || '待评估']
    ])
    writePdfSection(document, '二、风险统计')
    writePdfLine(document, `高风险 ${audit.summary?.high || 0} 项；中风险 ${audit.summary?.medium || 0} 项；低风险 ${audit.summary?.low || 0} 项；缺失条款 ${audit.summary?.missing || 0} 项。`)
    writePdfSection(document, '三、风险与缺失条款')
    if (!findings.length) writePdfLine(document, '本次未识别出需列示的风险或缺失条款。')
    findings.forEach((item, index) => {
      ensurePdfSpace(document, 110)
      writePdfLine(document, `${index + 1}. ${item.kind}：${item.title || '审核事项'}（${item.level || '待评估'}）`, 11, '#1F1F1F')
      writePdfLine(document, `原文位置：${evidenceLocation(item)}`, 10)
      writePdfLine(document, `审核说明：${item.reason || '未提供'}`, 10)
      writePdfLine(document, `识别依据：${item.evidence || '未在已解析文本中识别到完整条款。'}`, 10)
      writePdfLine(document, `修改建议：${item.suggestion || '请结合交易实际情况补充或调整。'}`, 10)
    })
    writePdfSection(document, '四、标准条款完整性')
    writePdfLine(document, `完整 ${match.summary?.complete || 0} 项；部分具备 ${match.summary?.partial || 0} 项；缺失 ${match.summary?.missing || 0} 项。`)
    if (!incomplete.length) writePdfLine(document, '未识别出需要补充的标准条款要素。')
    incomplete.forEach((item, index) => {
      ensurePdfSpace(document, 100)
      writePdfLine(document, `${index + 1}. ${item.title || '标准条款'}（${item.status || '待评估'}）`, 11, '#1F1F1F')
      writePdfLine(document, `原文位置：${evidenceLocation(item)}`, 10)
      writePdfLine(document, `识别依据：${item.evidence || '未提供'}`, 10)
      writePdfLine(document, `完善建议：${item.suggestion || '请结合合同实际情况补充。'}`, 10)
    })
    writePdfSection(document, '五、合同版本与人工确认')
    writePdfLine(document, report.changeSummary || '初始版本：基于当前可识别文本生成。')
    writePdfLine(document, `复核备注：${report.reviewerNote || '尚未填写人工复核备注。'}`)
    writePdfLine(document, '本报告仅用于合同审阅辅助，不构成法律意见或最终法律结论。', 9, '#555555')
    document.end()
  })
}

function writePdfTitle(document, value) {
  document.fontSize(19).fillColor('#1F1F1F').text(value, { align: 'center' })
  document.moveDown(0.5)
}

function writePdfSection(document, value) {
  ensurePdfSpace(document, 54)
  document.moveDown(0.7).fontSize(13).fillColor('#1F1F1F').text(value)
  document.moveDown(0.25)
}

function writePdfRows(document, rows) {
  rows.forEach(([label, value]) => writePdfLine(document, `${label}：${value || '未识别'}`, 10))
}

function writePdfLine(document, value, size = 10, color = '#1F1F1F', align = 'left') {
  ensurePdfSpace(document, 38)
  const text = Array.from(String(value || '').replace(/\s+/g, ' ').trim(), (character) => {
    const point = character.codePointAt(0)
    return document._font.font.hasGlyphForCodePoint(point) ? character : '[U+' + point.toString(16).toUpperCase() + ']'
  }).join('')
  document.fontSize(size).fillColor(color).text(text, { align, lineGap: 4 })
  document.moveDown(0.25)
}

function ensurePdfSpace(document, minimum) {
  if (document.y + minimum > document.page.height - document.page.margins.bottom) document.addPage()
}

function formatDate(value) {
  const date = new Date(value || Date.now())
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(date)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}
