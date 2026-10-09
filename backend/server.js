import { previewDeletion, executeDeletion, lockContract } from './services/data-lifecycle-service.js'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool, getManagedReport, initializeDatabase, getRiskRuleDefinitions, listFamieModelVersions, registerFamieModelVersion, saveContractParseRecord, saveRiskAuditRecord } from './db.js'
import { organizeReportParagraphsWithDeepSeek } from './services/deepseek-client.js'
import { analyzeContract } from './services/contract-analysis-service.js'
import { parseContractDocument } from './services/document-parser.js'
import { archiveOperations, createOperationBackup, deleteOperations, getOperationById, listOperationPage, recordOperation } from './services/mysql-operation-store.js'
import { buildAuditReportDocx, buildRiskAuditChecklistDocx, buildStandardClauseMatchDocx } from './services/report-generator.js'
import { exportManagedReport, listReportManagementData, prepareManagedReport, safeReportFileStem, setManagedReportReview } from './services/report-management-service.js'
import { auditContractRisk, riskRuleLibrary, syncRiskRuleLibrary } from './services/risk-audit-service.js'
import { ensureEmbeddedModelServer, getEmbeddedModelStatus, stopEmbeddedModelServer } from './services/embedded-llm-service.js'
import { ensureEmbeddedEmbeddingServer, getEmbeddedEmbeddingStatus, stopEmbeddedEmbeddingServer } from './services/embedded-embedding-service.js'
import { getStandardClauseLibrary, matchStandardClauses, syncStandardClauseLibrary } from './services/standard-clause-service.js'
import { buildFamieAnnotationDataset, buildFamieEntityTypeFile, getFamieStatus } from './services/famie-service.js'
import { answerContractQuestion } from './services/contract-assistant-service.js'

import { resolveStoredContract, saveParseSnapshot, saveAnalysisRun, resolveAnalysisRun } from './services/contract-integrity-service.js'
import { describeStartupError } from './services/startup-error.js'
import { createSealRouter } from './routes/seal.js'

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } })
const famieModelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } })
const port = Number(process.env.PORT || 3001)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(__dirname, '../dist')

const trustedOrigins = new Set((process.env.UI_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001,http://127.0.0.1:8080').split(','))
app.use(cors({ origin(origin, callback) { callback(!origin || trustedOrigins.has(origin) ? null : Object.assign(new Error('请求来源未授权。'), { status: 403 }), true) } }))
app.use(express.json({ limit: '16mb' }))
app.use(express.static(distPath))
app.use('/api/seal', createSealRouter(pool))

app.get('/api/health', async (_request, response, next) => {
  try { await pool.query('SELECT 1') } catch { return next(Object.assign(new Error('MySQL 不可用，请检查数据库服务后重试。'), { status: 503, code: 'database_unavailable' })) }
  response.json({
    status: 'ok',
    service: 'contract-intelligent-parser',
    database: 'mysql',
    deepseek: {
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      trackingId: process.env.DEEPSEEK_TRACKING_ID || '14ef73d6-457f-4e07-af5c-02aa83ba6f75'
    },
    localModel: getEmbeddedModelStatus(),
    embeddingModel: getEmbeddedEmbeddingStatus()
  })
})

const contractRoutes = new Set(['/api/assistant/chat', '/api/contracts/report', '/api/contracts/preview-segments', '/api/famie/annotation-dataset', '/api/contracts/standard-clause-match', '/api/contracts/standard-clause-match/export', '/api/contracts/risk-audit', '/api/contracts/risk-audit/export', '/api/report-management/prepare'])
app.use(async (request, _response, next) => {
  if (request.method !== 'POST' || !contractRoutes.has(request.path)) return next()
  try { request.body.contract = await resolveStoredContract(request.body?.contract); next() } catch (error) { next(error) }
})

function contractPost(route, handler) {
  app.post(route, async (request,response,next)=>{
    let release
    try {
      release=await lockContract(request.body.contract.sourceFile)
      request.body.contract=await resolveStoredContract(request.body.contract)
      await handler(request,response,next)
    } catch(error){next(error)} finally {if(release)await release()}
  })
}
function reportHandler(handler) {
  return async(request,response,next)=>{
    let release
    try {
      const report=await getManagedReport(request.params.id)
      if(!report)throw Object.assign(Error('报告不存在或已删除'),{status:404})
      release=await lockContract(report.sourceFile)
      if(!await getManagedReport(request.params.id))throw Object.assign(Error('报告不存在或已删除'),{status:404})
      await handler(request,response,next)
    }catch(error){next(error)}finally{if(release)await release()}
  }
}

app.post('/api/contracts/parse', upload.single('contract'), async (request, response, next) => {
  let release
  try {
  const parserResult = await parseContractDocument(request.file)
  if (!parserResult.supported) {
    response.status(400).json({ message: `暂不支持 .${parserResult.fileType} 格式。请上传 PDF、Word（.doc/.docx）或图片合同。` })
    return
  }
  if (!parserResult.text || parserResult.text.replace(/\s/g, '').length < 10 || !parserResult.coverage.complete) {
    response.status(422).json({ message: '未能完整识别有效合同正文，请检查空白页、损坏或低清扫描页面。扫描 Word 可转换为 PDF 或清晰图片后重试。', warnings: parserResult.warnings, coverage: parserResult.coverage })
    return
  }
  release = await lockContract(parserResult.fileName)
  let parsed = await analyzeContract({
    text: parserResult.text,
    fileName: parserResult.fileName,
    parserResult
  })

  parsed = await saveParseSnapshot(parsed)
  const persistence = await recordOperation('contract_parse', {
    sourceFile: parserResult.fileName,
    fileType: parserResult.fileType,
    parsed
  })
  await saveContractParseRecord({
    fileName: parserResult.fileName,
    fileType: parserResult.fileType,
    contractType: parsed.contractType?.predicted || '其他',
    keyElements: parsed.keyElements || {},
    paragraphStructure: parsed.paragraphStructure || [],
    ocrConfidence: parsed.ocr?.confidence || 0
  })

  response.json({ parsed, persistence })
  } catch (error) { next(error) } finally { if(release)await release() }
})

contractPost('/api/assistant/chat', async (request, response, next) => {
  try {
    const question = String(request.body?.question || '').trim()
    const contract = request.body?.contract
    if (!question) {
      response.status(400).json({ message: '请输入需要咨询的合同问题。' })
      return
    }
    if (!contract || !Array.isArray(contract.paragraphStructure)) {
      response.status(400).json({ message: '请先上传并解析合同，再进行合同优化问答。' })
      return
    }

    const allowWebSearch = request.body?.allowWebSearch === true
    const reply = await answerContractQuestion({ question, contract, history: request.body?.history, allowWebSearch })
    const persistence = await recordOperation('contract_assistant_chat', {
      sourceFile: contract.sourceFile || '未命名合同',
      contractType: contract.contractType?.predicted || '未识别',
      questionLength: question.length,
      answerLength: reply.answer.length,
      engine: reply.engine,
      retrieval: {
        semantic: reply.retrieval?.semantic,
        web: { requested: allowWebSearch, status: reply.retrieval?.web?.status, resultCount: reply.retrieval?.web?.resultCount || 0 }
      },
      citationSources: reply.citations.map(({ id, type, title, url }) => ({ id, type, title, url }))
    })
    response.json({ reply, persistence })
  } catch (error) {
    next(error)
  }
})

contractPost('/api/contracts/report', async (request, response, next) => {
  try {
    const contract = request.body?.contract
    if (!contract || !Array.isArray(contract.paragraphStructure)) {
      response.status(400).json({ message: '缺少可用于生成报告的合同解析数据。' })
      return
    }

    const organizedReport = await organizeReportParagraphsWithDeepSeek(contract)
    const documentBuffer = await buildAuditReportDocx(contract, organizedReport)
    const fileName = `${safeFileStem(contract.sourceFile)}-audit-report.docx`
    const encodedFileName = encodeURIComponent(fileName)
    await recordOperation('audit_report_generate', {
      sourceFile: contract.sourceFile || '未命名合同',
      contractType: contract.contractType?.predicted || '其他',
      segmentationProvider: organizedReport.provider,
      fileName,
      byteLength: documentBuffer.length
    })

    response.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="contract-audit-report.docx"; filename*=UTF-8''${encodedFileName}`,
      'Content-Length': documentBuffer.length
    })
    response.send(documentBuffer)
  } catch (error) {
    next(error)
  }
})

contractPost('/api/contracts/preview-segments', async (request, response, next) => {
  try {
    const contract = request.body?.contract
    if (!contract || !Array.isArray(contract.paragraphStructure)) {
      response.status(400).json({ message: '缺少可用于整理预览的合同解析数据。' })
      return
    }

    const organizedPreview = await organizeReportParagraphsWithDeepSeek(contract)
    const persistence = await recordOperation('ocr_preview_segment', {
      sourceFile: contract.sourceFile || '未命名合同',
      provider: organizedPreview.provider,
      status: organizedPreview.status,
      sections: organizedPreview.sections
    })
    response.json({
      sections: organizedPreview.sections,
      provider: organizedPreview.provider,
      status: organizedPreview.status,
      persistence
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/famie/status', async (_request, response) => {
  response.json({ famie: await getFamieStatus() })
})

contractPost('/api/famie/annotation-dataset', async (request, response, next) => {
  try {
    const dataset = buildFamieAnnotationDataset(request.body?.contract)
    await recordOperation('famie_annotation_dataset_export', {
      sourceFile: dataset.sourceFile,
      paragraphCount: dataset.paragraphCount,
      unitCount: dataset.unitCount,
      format: dataset.format,
      entityTypeCount: dataset.entityTypeCount,
      dataTransmission: 'manual_local_export_only'
    })
    response.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="famie-unlabeled-contract-elements.txt"; filename*=UTF-8''${encodeURIComponent(dataset.fileName)}`
    })
    response.send(dataset.text)
  } catch (error) {
    next(error)
  }
})

app.get('/api/famie/entity-types', (_request, response) => {
  const schema = buildFamieEntityTypeFile()
  response.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${schema.fileName}"; filename*=UTF-8''${encodeURIComponent(schema.fileName)}`
  })
  response.send(schema.text)
})

app.get('/api/famie/models', async (_request, response, next) => {
  try {
    response.json({ models: await listFamieModelVersions() })
  } catch (error) {
    next(error)
  }
})

app.post('/api/famie/models', famieModelUpload.single('model'), async (request, response, next) => {
  try {
    const registered = await registerFamieModelVersion({
      file: request.file,
      versionName: request.body?.versionName,
      notes: request.body?.notes
    })
    await recordOperation('famie_model_register', {
      fileName: registered.originalFileName,
      versionName: registered.versionName,
      byteLength: registered.byteLength,
      status: registered.status,
      sha256: registered.sha256
    })
    response.status(201).json({ model: registered })
  } catch (error) {
    next(error)
  }
})

app.get('/api/risk-rules', async (_request, response, next) => {
  try { response.json({ version: 'contract-library-2026.09.16-v3', rules: (await getRiskRuleDefinitions()).map(({ pattern, keywords, ...rule }) => rule) }) } catch (error) { next(error) }
})

app.get('/api/standard-clauses', async (_request, response, next) => {
  try {
    const clauses = await getStandardClauseLibrary()
    response.json({ count: clauses.length, clauses: clauses.map(({ keywords, requirements, sourceExamples, ...item }) => ({ ...item, requirementCount: requirements?.length || 0, sourceExamples: sourceExamples?.slice(0, 3) || [] })) })
  } catch (error) {
    next(error)
  }
})

contractPost('/api/contracts/standard-clause-match', async (request, response, next) => {
  try {
    const contract = request.body?.contract
    if (!contract || !Array.isArray(contract.paragraphStructure)) {
      response.status(400).json({ message: '缺少可用于标准条款匹配的合同解析数据。' })
      return
    }
    const allowCloudReview = request.body?.allowCloudReview === true
    const match = await saveAnalysisRun(contract, 'standard', await matchStandardClauses(contract, { allowCloudReview }))
    const persistence = await recordOperation('standard_clause_match', {
      sourceFile: contract.sourceFile || '未命名合同',
      contractType: contract.contractType?.predicted || '其他',
      cloudReviewRequested: allowCloudReview,
      summary: match.summary,
      engine: match.engine
    })
    response.json({ match, persistence })
  } catch (error) {
    next(error)
  }
})

contractPost('/api/contracts/standard-clause-match/export', async (request, response, next) => {
  try {
    const contract = request.body?.contract
    const match = await resolveAnalysisRun(contract, 'standard', request.body?.match?.analysisRunId)
    if (!contract || !match || !Array.isArray(contract.paragraphStructure)) {
      response.status(400).json({ message: '缺少可用于导出标准条款匹配报告的数据。' })
      return
    }
    const documentBuffer = await buildStandardClauseMatchDocx(contract, match)
    const fileName = `${safeFileStem(contract.sourceFile)}-standard-clause-match-report.docx`
    await recordOperation('standard_clause_match_export', {
      sourceFile: contract.sourceFile || '未命名合同',
      contractType: contract.contractType?.predicted || '其他',
      matchProvider: match.engine?.provider || '标准条款库',
      fileName,
      byteLength: documentBuffer.length
    })
    response.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="standard-clause-match-report.docx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': documentBuffer.length
    })
    response.send(documentBuffer)
  } catch (error) {
    next(error)
  }
})

contractPost('/api/contracts/risk-audit', async (request, response, next) => {
  try {
    const contract = request.body?.contract
    if (!contract || !Array.isArray(contract.paragraphStructure)) {
      response.status(400).json({ message: '缺少可用于风险审核的合同解析数据。' })
      return
    }

    const allowCloudReview = request.body?.allowCloudReview === true
    const audit = await saveAnalysisRun(contract, 'risk', await auditContractRisk(contract, { allowCloudReview }))
    const persistence = await recordOperation('contract_risk_audit', {
      fileName: contract.sourceFile || '未命名合同',
      contractType: contract.contractType?.predicted || '其他',
      cloudReviewRequested: allowCloudReview,
      summary: audit.summary,
      audit
    })
    await saveRiskAuditRecord({
      fileName: contract.sourceFile || '未命名合同',
      contractType: contract.contractType?.predicted || '其他',
      overallLevel: audit.summary.overallLevel,
      riskScore: audit.summary.score,
      audit
    })
    response.json({ audit, persistence })
  } catch (error) {
    next(error)
  }
})

contractPost('/api/contracts/risk-audit/export', async (request, response, next) => {
  try {
    const contract = request.body?.contract
    const audit = await resolveAnalysisRun(contract, 'risk', request.body?.audit?.analysisRunId)
    if (!contract || !audit || !Array.isArray(contract.paragraphStructure)) {
      response.status(400).json({ message: '缺少可用于导出风险审核清单的数据。' })
      return
    }

    const documentBuffer = await buildRiskAuditChecklistDocx(contract, audit)
    const fileName = `${safeFileStem(contract.sourceFile)}-risk-audit-checklist.docx`
    await recordOperation('risk_audit_checklist_export', {
      sourceFile: contract.sourceFile || '未命名合同',
      contractType: contract.contractType?.predicted || '其他',
      auditProvider: audit.engine?.provider || '增强规则库',
      fileName,
      byteLength: documentBuffer.length
    })
    response.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="risk-audit-checklist.docx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': documentBuffer.length
    })
    response.send(documentBuffer)
  } catch (error) {
    next(error)
  }
})

app.get('/api/report-management', async (_request, response, next) => {
  try {
    response.json({ database: 'mysql', ...(await listReportManagementData()) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/contract-versions', async (_request, response, next) => {
  try {
    const { versions } = await listReportManagementData()
    response.json({ database: 'mysql', versions })
  } catch (error) {
    next(error)
  }
})

contractPost('/api/report-management/prepare', async (request, response, next) => {
  try {
    const result = await prepareManagedReport(request.body?.contract, { allowCloudReview: request.body?.allowCloudReview === true, auditRunId: request.body?.auditRunId, matchRunId: request.body?.matchRunId })
    const persistence = await recordOperation('managed_report_generate', {
      sourceFile: result.report.sourceFile,
      contractType: result.report.contractType,
      reportId: result.report.id,
      versionNumber: result.report.versionNumber,
      status: result.report.status,
      cloudReviewRequested: request.body?.allowCloudReview === true,
      summary: result.report.snapshot.audit?.summary || {},
      completeness: result.report.snapshot.match?.summary || {}
    })
    response.status(201).json({ ...result, persistence })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/report-management/:id/review', reportHandler(async (request, response, next) => {
  try {
    const report = await setManagedReportReview(request.params.id, request.body?.status, request.body?.reviewerNote)
    const persistence = await recordOperation('managed_report_review', {
      sourceFile: report.sourceFile,
      reportId: report.id,
      versionNumber: report.versionNumber,
      status: report.status,
      hasReviewerNote: Boolean(report.reviewerNote)
    })
    response.json({ report, persistence })
  } catch (error) {
    next(error)
  }
}))

app.get('/api/report-management/:id/export', reportHandler(async (request, response, next) => {
  try {
    const exported = await exportManagedReport(request.params.id, request.query.format)
    const fileName = `${safeReportFileStem(exported.report.sourceFile)}-unified-audit-report-v${exported.report.versionNumber || 1}.${exported.extension}`
    await recordOperation('managed_report_export', {
      sourceFile: exported.report.sourceFile,
      reportId: exported.report.id,
      versionNumber: exported.report.versionNumber,
      format: exported.extension.toUpperCase(),
      fileName,
      byteLength: exported.buffer.length
    })
    response.set({
      'Content-Type': exported.contentType,
      'Content-Disposition': `attachment; filename="unified-audit-report.${exported.extension}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': exported.buffer.length
    })
    response.send(exported.buffer)
  } catch (error) {
    next(error)
  }
}))

app.get('/api/operations', async (request, response, next) => {
  try {
    const page = await listOperationPage(request.query)
    response.json({ database: 'mysql', count: page.operations.length, ...page })
  } catch (error) {
    next(error)
  }
})

app.get('/api/operations/:id/download', async (request, response, next) => {
  try {
    const operation = await getOperationById(request.params.id)
    if (!operation) {
      response.status(404).json({ message: '未找到对应的历史操作记录。' })
      return
    }
    const fileName = `${safeFileStem(operation.payload?.sourceFile || operation.payload?.fileName || 'operation')}-${operation.type}-record.html`
    response.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="operation-record.html"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    })
    response.send(buildOperationRecordHtml(operation))
  } catch (error) {
    next(error)
  }
})

app.patch('/api/operations/archive', async (request, response, next) => {
  try {
    const result = await archiveOperations(request.body?.ids)
    response.json(result)
  } catch (error) {
    next(error)
  }
})

app.post('/api/operations/deletion-preview', async(request,response,next)=>{
  try {response.json(await previewDeletion(request.body))}catch(error){next(error)}
})

app.delete('/api/operations', async (request, response, next) => {
  try {
    const result = await executeDeletion({ ...request.body, scope: request.body?.scope || 'history' })
    response.json(result)
  } catch (error) {
    next(error)
  }
})

app.delete('/api/operations/:id', async (request, response, next) => {
  try {
    const result = await executeDeletion({ ...request.body, scope:'history', ids:[request.params.id] })
    response.json(result)
  } catch (error) {
    next(error)
  }
})

app.get('/api/operations/backup', async (_request, response, next) => {
  try {
    const backup = await createOperationBackup()
    const body = `\uFEFF${backup}`
    response.set({
      'Content-Type': 'application/sql; charset=utf-8',
      'Content-Disposition': "attachment; filename=\"contract-audit-operations-backup.sql\"; filename*=UTF-8''contract-audit-operations-backup.sql"
    })
    response.send(body)
  } catch (error) {
    next(error)
  }
})

app.get('*', (_request, response) => {
  response.sendFile(path.join(distPath, 'index.html'))
})

app.use((error, _request, response, _next) => {
  const status = error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large' ? 413 : Number(error.status) || 500
  console.error('Contract request failed:', error.code || 'request_error')
  response.status(status).json({ code: error.code || 'request_error', message: status === 413 ? '文件或合同数据过大：上传文件上限 20 MB，结构化请求上限 16 MB。请拆分文档后重试。' : status < 500 || status === 503 ? error.message : '合同服务暂时无法完成请求，请检查 MySQL 和本地服务后重试。' })
})

startServer().catch(async (error) => {
  console.error('Contract parser startup failed:', describeStartupError(error))
  await Promise.allSettled([pool.end(), stopEmbeddedModelServer(), stopEmbeddedEmbeddingServer()])
  process.exitCode = 1
})

async function startServer() {
  await initializeDatabase()
  const ruleSync = await syncRiskRuleLibrary()
  const standardClauseSync = await syncStandardClauseLibrary()
  const [localModel, embeddingModel] = await Promise.all([ensureEmbeddedModelServer(), ensureEmbeddedEmbeddingServer()])
  app.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`Contract parser API listening on http://127.0.0.1:${port} with ${ruleSync.count} MySQL risk rules, ${standardClauseSync.count} standard clauses, local generation ${localModel.state}, and local embeddings ${embeddingModel.state}`)
  })
}

process.once('SIGINT', () => Promise.all([stopEmbeddedModelServer(), stopEmbeddedEmbeddingServer()]))
process.once('SIGTERM', () => Promise.all([stopEmbeddedModelServer(), stopEmbeddedEmbeddingServer()]))

function safeFileStem(value) {
  const stem = String(value || 'contract').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim()
  return stem || 'contract'
}

function buildOperationRecordHtml(operation) {
  const payload = operation.payload || {}
  const details = operationDetails(operation)
  const status = operation.archived ? '已归档' : '在用'
  const rows = details.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>历史操作记录</title><style>body{margin:0;background:#f3f6f8;color:#1f1f1f;font-family:"Microsoft YaHei",Arial,sans-serif;line-height:1.7}.page{max-width:860px;margin:36px auto;padding:42px;background:#fff;border:1px solid #d8d8d8}h1{margin:0 0 6px;text-align:center;font-size:26px}p.meta{text-align:center;color:#555;margin:0 0 30px}h2{margin:28px 0 12px;font-size:17px;border-left:4px solid #4a4a4a;padding-left:10px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 12px;border:1px solid #bfbfbf;text-align:left;vertical-align:top}th{width:180px;background:#f2f2f2;color:#333}.note{margin-top:28px;color:#555;font-size:12px}</style></head><body><main class="page"><h1>历史操作记录</h1><p class="meta">企业合同智能审核与风险预警系统</p><h2>记录信息</h2><table><tr><th>操作类型</th><td>${escapeHtml(operationLabel(operation.type))}</td></tr><tr><th>分析文件名</th><td>${escapeHtml(payload.sourceFile || payload.fileName || '未命名分析文件')}</td></tr><tr><th>记录时间</th><td>${escapeHtml(formatOperationDate(operation.createdAt))}</td></tr><tr><th>记录状态</th><td>${status}</td></tr>${operation.archivedAt ? `<tr><th>归档时间</th><td>${escapeHtml(formatOperationDate(operation.archivedAt))}</td></tr>` : ''}</table><h2>操作详情</h2><table>${rows}</table><p class="note">本记录用于追溯系统操作过程，不构成法律意见。</p></main></body></html>`
}

function operationDetails(operation) {
  const payload = operation.payload || {}
  if (operation.type === 'contract_parse') return [['解析状态', payload.parsed?.ai?.status || '未记录'], ['分析模型', payload.parsed?.ai?.provider || '本地基础解析'], ['合同类型', payload.parsed?.contractType?.predicted || '未识别'], ['文本长度', `${payload.parsed?.documentParsing?.textLength || 0} 字符`], ['解析摘要', payload.parsed?.summary || '未提供']]
  if (operation.type === 'contract_risk_audit') return [['审核引擎', payload.audit?.engine?.provider || '增强规则库'], ['审核状态', payload.audit?.engine?.status || '未记录'], ['云端复核选择', payload.cloudReviewRequested ? '已授权并请求 DeepSeek 云端复核' : '未请求云端复核'], ['综合风险等级', payload.summary?.overallLevel || '待评估'], ['风险评分', `${payload.summary?.score ?? '待评估'} / 100`], ['高风险数量', String(payload.summary?.high || 0)], ['中风险数量', String(payload.summary?.medium || 0)], ['低风险数量', String(payload.summary?.low || 0)], ['缺失条款数量', String(payload.summary?.missing || 0)]]
  if (operation.type === 'standard_clause_match') return [['匹配引擎', payload.engine?.provider || '标准条款库'], ['匹配状态', payload.engine?.status || '未记录'], ['云端复核选择', payload.cloudReviewRequested ? '已授权并请求 DeepSeek 云端复核' : '未请求云端复核'], ['完整性评价', payload.summary?.overall || '待评估'], ['完整性得分', `${payload.summary?.completenessScore ?? '待评估'} / 100`], ['完整条款', String(payload.summary?.complete || 0)], ['部分具备', String(payload.summary?.partial || 0)], ['缺失条款', String(payload.summary?.missing || 0)]]
  if (operation.type === 'contract_assistant_chat') return [['问答引擎', payload.engine?.provider || '未记录'], ['处理状态', payload.engine?.status || '未记录'], ['语义检索', payload.retrieval?.semantic?.provider || '词法相关性排序'], ['全网法律检索', payload.retrieval?.web?.requested ? `已开启，${payload.retrieval?.web?.resultCount || 0} 条官方来源` : '未开启'], ['来源数量', String(payload.citationSources?.length || 0)], ['提问长度', `${payload.questionLength || 0} 字符`], ['答复长度', `${payload.answerLength || 0} 字符`], ['隐私说明', '仅记录操作元数据，不保存问题和回答原文。']]
  if (operation.type === 'ocr_preview_segment') return [['分段来源', payload.provider || '本地结构化分段'], ['分段状态', payload.status || '未记录'], ['章节数量', String(payload.sections?.length || 0)]]
  if (operation.type === 'audit_report_generate' || operation.type === 'risk_audit_checklist_export' || operation.type === 'standard_clause_match_export') return [['生成文件', payload.fileName || '未记录'], ['生成方式', payload.segmentationProvider || payload.auditProvider || payload.matchProvider || '系统生成'], ['文件大小', `${payload.byteLength || 0} 字节`]]
  if (operation.type === 'managed_report_generate') return [['报告标识', payload.reportId || '未记录'], ['合同版本', `V${payload.versionNumber || 1}`], ['报告状态', payload.status || '待人工确认'], ['云端复核选择', payload.cloudReviewRequested ? '已授权并请求 DeepSeek 云端复核' : '未请求云端复核'], ['风险统计', `高 ${payload.summary?.high || 0} 项；中 ${payload.summary?.medium || 0} 项；低 ${payload.summary?.low || 0} 项；缺失 ${payload.summary?.missing || 0} 项`], ['完整性评价', `${payload.completeness?.overall || '待评估'}；${payload.completeness?.completenessScore ?? '待评估'} / 100`]]
  if (operation.type === 'managed_report_review') return [['报告标识', payload.reportId || '未记录'], ['合同版本', `V${payload.versionNumber || 1}`], ['人工复核状态', payload.status || '未记录'], ['复核备注', payload.hasReviewerNote ? '已填写（内容保存在报告快照中）' : '未填写']]
  if (operation.type === 'managed_report_export') return [['报告标识', payload.reportId || '未记录'], ['合同版本', `V${payload.versionNumber || 1}`], ['导出格式', payload.format || '未记录'], ['生成文件', payload.fileName || '未记录'], ['文件大小', `${payload.byteLength || 0} 字节`]]
  if (operation.type === 'famie_annotation_dataset_export') return [['导出样本数', `${payload.unitCount || 0} 条`], ['原始段落数', `${payload.paragraphCount || 0} 条`], ['标注实体类型', `${payload.entityTypeCount || 0} 类`], ['传输方式', payload.dataTransmission === 'manual_local_export_only' ? '仅本地手动导出，未自动上传' : '未记录']]
  if (operation.type === 'famie_model_register') return [['模型版本', payload.versionName || '未命名版本'], ['模型文件', payload.fileName || '未记录'], ['模型状态', payload.status || '未记录'], ['文件大小', `${payload.byteLength || 0} 字节`], ['校验摘要', payload.sha256 || '未记录']]
  return [['操作说明', '已完成系统操作留痕。']]
}

function operationLabel(type) {
  return { contract_parse: '合同智能解析', ocr_preview_segment: 'OCR 预览整理', contract_risk_audit: '合同风险审核', standard_clause_match: '标准条款匹配', contract_assistant_chat: '合同优化问答', audit_report_generate: '审核报告生成', risk_audit_checklist_export: '风险审核清单导出', standard_clause_match_export: '标准条款匹配报告导出', managed_report_generate: '统一审核报告生成', managed_report_review: '统一审核报告人工复核', managed_report_export: '统一审核报告导出', famie_annotation_dataset_export: 'FAMIE 标注样本导出', famie_model_register: 'FAMIE 模型登记' }[type] || '系统操作'
}

function formatOperationDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeStyle: 'medium', hour12: false }).format(date)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}
