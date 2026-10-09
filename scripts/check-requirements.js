import fs from 'node:fs'

const requiredFiles = [
  'Agents.md',
  'logs/development-log.md',
  'src/App.vue',
  'src/styles.css',
  'backend/server.js',
  'backend/db.js',
  'backend/schema.sql',
  'backend/services/document-parser.js',
  'backend/services/deepseek-client.js',
  'backend/services/embedded-llm-service.js',
  'backend/services/report-generator.js',
  'backend/services/risk-audit-service.js',
  'backend/services/standard-clause-service.js',
  'backend/services/famie-service.js',
  'backend/services/operation-store.js',
  'backend/services/mysql-operation-store.js',
  'src/components/RiskAuditPanel.vue',
  'src/components/StandardClauseMatchPanel.vue',
  'src/components/FamieTrainingPanel.vue',
  'src/components/OperationHistoryPanel.vue',
  'datasets/README.md',
  'datasets/archive/cuad-main.zip',
  'datasets/archive/LeCaRD-main.zip',
  'scripts/migrate-operation-store-to-mysql.js',
  'scripts/evaluate-risk-rules.js',
  'scripts/setup-embedded-model.ps1',
  'scripts/test-embedded-model.js',
  'scripts/evaluate-standard-clause-fixtures.js',
  'tests/fixtures/external-contracts/SOURCES.md',
  'models/README.md',
  'scripts/dev.js',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'third_party/famie/README.md',
  'third_party/famie/Dockerfile',
  'third_party/famie/source/famie-main/LICENSE',
  'scripts/test-famie-integration.js',
  'src/components/ContractAssistantFloat.vue',
  'backend/services/contract-assistant-service.js',
  'backend/services/semantic-retrieval-service.js',
  'backend/services/legal-web-search-service.js',
  'scripts/test-contract-assistant.js'
]

const requiredTerms = [
  '合同文件上传',
  'PDF、Word、图片合同解析',
  'OCR 文字识别',
  '段落结构保留',
  '合同类型初步判断',
  '合同关键要素抽取',
  '为后续风险审核、问答、报告生成等模块提供统一输入',
  'DeepSeek',
  '文字识别结果预览',
  '导出 JSON',
  '审核报告生成'
]

const missingFiles = requiredFiles.filter((file) => !fs.existsSync(file))

if (missingFiles.length > 0) {
  console.error(`Missing required files: ${missingFiles.join(', ')}`)
  process.exit(1)
}

const app = fs.readFileSync('src/App.vue', 'utf8')
const missingTerms = requiredTerms.filter((term) => !app.includes(term))

if (missingTerms.length > 0) {
  console.error(`Missing module terms: ${missingTerms.join(', ')}`)
  process.exit(1)
}

const schema = fs.readFileSync('backend/schema.sql', 'utf8')
if (!schema.includes('CREATE TABLE IF NOT EXISTS contract_parse_records')) {
  console.error('MySQL schema is missing contract_parse_records table.')
  process.exit(1)
}

const backend = fs.readFileSync('backend/services/deepseek-client.js', 'utf8')
if (!backend.includes('14ef73d6-457f-4e07-af5c-02aa83ba6f75')) {
  console.error('DeepSeek tracking ID is missing from backend configuration.')
  process.exit(1)
}

const frontend = fs.readFileSync('src/App.vue', 'utf8')
const requiredFrontendHandlers = ['showOcrPreview', 'exportJson', "activeModule = 'report'", 'ReportManagementPanel']
const missingFrontendHandlers = requiredFrontendHandlers.filter((term) => !frontend.includes(term))
if (missingFrontendHandlers.length > 0) {
  console.error(`Missing frontend interaction handlers: ${missingFrontendHandlers.join(', ')}`)
  process.exit(1)
}

const devScript = fs.readFileSync('scripts/dev.js', 'utf8')
const packageJson = fs.readFileSync('package.json', 'utf8')
if (!devScript.includes("backend/server.js") || !devScript.includes('node_modules/vite/bin/vite.js') || !packageJson.includes('"dev": "node scripts/dev.js"')) {
  console.error('Development startup must launch both the API and Vite frontend.')
  process.exit(1)
}

if (!frontend.includes('parseError') || !frontend.includes('无法连接合同解析服务')) {
  console.error('Frontend API-unavailable feedback is missing.')
  process.exit(1)
}

const reportGenerator = fs.readFileSync('backend/services/report-generator.js', 'utf8')
const serverSource = fs.readFileSync('backend/server.js', 'utf8')
if (!serverSource.includes("/api/contracts/report") || !serverSource.includes("/api/contracts/preview-segments") || !serverSource.includes('organizeReportParagraphsWithDeepSeek') || !reportGenerator.includes('Packer.toBuffer')) {
  console.error('Word audit report generation with DeepSeek paragraph organization is missing.')
  process.exit(1)
}

const riskService = fs.readFileSync('backend/services/risk-audit-service.js', 'utf8')
const riskPanel = fs.readFileSync('src/components/RiskAuditPanel.vue', 'utf8')
const requiredRiskTerms = ['riskRuleLibrary', 'auditContractRisk', 'reviewContractRisksWithDeepSeek', 'missingClauses', '风险规则库', '风险依据与修改建议']
const missingRiskTerms = requiredRiskTerms.filter((term) => !`${riskService}\n${backend}\n${riskPanel}\n${serverSource}`.includes(term))
if (missingRiskTerms.length > 0 || !serverSource.includes('/api/contracts/risk-audit') || !serverSource.includes('/api/risk-rules')) {
  console.error(`Contract risk audit module is incomplete: ${missingRiskTerms.join(', ')}`)
  process.exit(1)
}

const requiredRiskUiStatusTerms = ['engineReviewText', 'engine?.notice', 'engine.provider', 'allowCloudReview', 'DeepSeek 云端复核']
const missingRiskUiStatusTerms = requiredRiskUiStatusTerms.filter((term) => !riskPanel.includes(term))
if (missingRiskUiStatusTerms.length > 0) {
  console.error(`Risk-audit execution status transparency is incomplete: ${missingRiskUiStatusTerms.join(', ')}`)
  process.exit(1)
}

const riskChecklistTerms = ['buildRiskAuditChecklistDocx', '/api/contracts/risk-audit/export', '风险审核清单', 'risk_audit_checklist_export', "color: '1F1F1F'"]
const missingRiskChecklistTerms = riskChecklistTerms.filter((term) => !`${serverSource}\n${reportGenerator}\n${riskPanel}`.includes(term))
if (missingRiskChecklistTerms.length > 0 || !riskPanel.includes('exportRiskChecklist')) {
  console.error(`Risk-audit checklist export is incomplete: ${missingRiskChecklistTerms.join(', ')}`)
  process.exit(1)
}

const standardClauseService = fs.readFileSync('backend/services/standard-clause-service.js', 'utf8')
const standardClausePanel = fs.readFileSync('src/components/StandardClauseMatchPanel.vue', 'utf8')
const standardClauseTerms = ['standard_clause_library', 'matchStandardClauses', 'reviewStandardClauseMatchWithEmbeddedModel', 'reviewStandardClauseMatchWithDeepSeek', 'rebuildStandardClauseLibrary', 'buildStandardClauseMatchDocx', '/api/contracts/standard-clause-match', 'standard_clause_match_export']
const missingStandardClauseTerms = standardClauseTerms.filter((term) => !`${standardClauseService}\n${fs.readFileSync('backend/services/embedded-llm-service.js', 'utf8')}\n${backend}\n${reportGenerator}\n${serverSource}\n${standardClausePanel}\n${fs.readFileSync('backend/db.js', 'utf8')}`.includes(term))
if (missingStandardClauseTerms.length > 0 || !packageJson.includes('standard-library:build:deepseek') || !packageJson.includes('test:standard-match') || !fs.readFileSync('backend/db.js', 'utf8').includes('standard_contract_sources')) {
  console.error(`Standard clause match module is incomplete: ${missingStandardClauseTerms.join(', ')}`)
  process.exit(1)
}

if (!riskService.includes('allowCloudReview = false') || !serverSource.includes('cloudReviewRequested') || !riskPanel.includes('type="checkbox"') || !riskPanel.includes('allowCloudReview: allowCloudReview.value')) {
  console.error('Per-audit DeepSeek cloud-review consent toggle is incomplete.')
  process.exit(1)
}

const requiredEnhancedRiskTerms = ['syncRiskRuleLibrary', 'clauseDetailRequirements', 'isNegated', 'confidence', 'candidateFindings']
const missingEnhancedRiskTerms = requiredEnhancedRiskTerms.filter((term) => !`${riskService}\n${backend}\n${serverSource}`.includes(term))
const databaseSource = fs.readFileSync('backend/db.js', 'utf8')
if (missingEnhancedRiskTerms.length > 0 || !databaseSource.includes('risk_rule_library')) {
  console.error(`Enhanced offline risk matching is incomplete: ${missingEnhancedRiskTerms.join(', ')}`)
  process.exit(1)
}

const localModelService = fs.readFileSync('backend/services/embedded-llm-service.js', 'utf8') + fs.readFileSync('backend/services/local-model-config.js', 'utf8')
const localModelTerms = ['Qwen3-8B', 'llama-server.exe', '127.0.0.1', 'reviewContractRisksWithEmbeddedModel', 'LOCAL_LLM_MODE']
const missingLocalModelTerms = localModelTerms.filter((term) => !`${localModelService}\n${riskService}\n${serverSource}\n${packageJson}`.includes(term))
if (missingLocalModelTerms.length > 0 || !serverSource.includes('localModel: getEmbeddedModelStatus') || !packageJson.includes('local-model:setup') || !packageJson.includes('local-model:test')) {
  console.error(`Embedded local-model integration is incomplete: ${missingLocalModelTerms.join(', ')}`)
  process.exit(1)
}

const mysqlOperationStore = fs.readFileSync('backend/services/mysql-operation-store.js', 'utf8')
if (!mysqlOperationStore.includes('recordOperation') || !mysqlOperationStore.includes('listOperations') || !mysqlOperationStore.includes('archiveOperations') || !mysqlOperationStore.includes('deleteOperations') || !mysqlOperationStore.includes('createOperationBackup') || !databaseSource.includes('initializeDatabase') || !serverSource.includes("'contract_parse'") || !serverSource.includes("'contract_risk_audit'") || !serverSource.includes("'ocr_preview_segment'") || !serverSource.includes("'audit_report_generate'") || !serverSource.includes('/api/operations')) {
  console.error('MySQL operation persistence is incomplete.')
  process.exit(1)
}

const historyPanel = fs.readFileSync('src/components/OperationHistoryPanel.vue', 'utf8')
const requiredHistoryTerms = ['历史操作记录', '分析文件名', '多选删除', '记录备份', 'archiveOperations', 'deleteOperations', 'downloadBackup']
const missingHistoryTerms = requiredHistoryTerms.filter((term) => !`${historyPanel}\n${frontend}\n${serverSource}`.includes(term))
if (missingHistoryTerms.length > 0 || !historyPanel.includes('contract-audit-operations-backup.sql') || !serverSource.includes('/api/operations/archive') || !serverSource.includes('/api/operations/backup') || !serverSource.includes('application/sql')) {
  console.error(`Operation history management is incomplete: ${missingHistoryTerms.join(', ')}`)
  process.exit(1)
}

const historyVisualTerms = ['detailItems', 'downloadOperation', 'archive-explanation', '/api/operations/:id/download', 'buildOperationRecordHtml']
const missingHistoryVisualTerms = historyVisualTerms.filter((term) => !`${historyPanel}\n${serverSource}`.includes(term))
if (missingHistoryVisualTerms.length > 0 || historyPanel.includes('<pre>{{ JSON.stringify(operation.payload')) {
  console.error(`Visual history-detail or single-record download is incomplete: ${missingHistoryVisualTerms.join(', ')}`)
  process.exit(1)
}

const requiredOcrSegmentationTerms = ['openOcrPreview', 'preview-segments', 'ocrPreviewSections', 'DeepSeek 语义分段']
const missingOcrSegmentationTerms = requiredOcrSegmentationTerms.filter((term) => !frontend.includes(term))
if (missingOcrSegmentationTerms.length > 0) {
  console.error(`DeepSeek OCR preview segmentation is missing: ${missingOcrSegmentationTerms.join(', ')}`)
  process.exit(1)
}

const requiredFormalReportTerms = ['SimSun', "color: '1F1F1F'", 'formalSummary', '合同智能审核说明报告']
const missingFormalReportTerms = requiredFormalReportTerms.filter((term) => !reportGenerator.includes(term) && !backend.includes(term))
if (missingFormalReportTerms.length > 0) {
  console.error(`Formal black-and-gray Word report styling is missing: ${missingFormalReportTerms.join(', ')}`)
  process.exit(1)
}

const reportManagementPanel = fs.readFileSync('src/components/ReportManagementPanel.vue', 'utf8')
const reportManagementService = fs.readFileSync('backend/services/report-management-service.js', 'utf8')
const reportManagementTerms = ['审核报告生成', '风险统计图表', '导出 Word', '导出 PDF', '导出 HTML', '人工复核状态', '合同版本']
const missingReportManagementTerms = reportManagementTerms.filter((term) => !`${reportManagementPanel}\n${reportManagementService}\n${serverSource}`.includes(term))
if (missingReportManagementTerms.length > 0 || !databaseSource.includes('contract_versions') || !databaseSource.includes('managed_reports') || !serverSource.includes('/api/report-management/prepare') || !reportManagementService.includes('buildManagedReportPdf')) {
  console.error(`Report management module is incomplete: ${missingReportManagementTerms.join(', ')}`)
  process.exit(1)
}

if (!historyPanel.includes('合同版本管理') || !historyPanel.includes('/api/contract-versions') || !historyPanel.includes('managed_report_review')) {
  console.error('History-side contract version or report review management is incomplete.')
  process.exit(1)
}

const requiredPreviewScrollTerms = ['grid-template-rows: auto auto minmax(0, 1fr)', 'overscroll-behavior: contain', 'min-height: 0']
const styles = fs.readFileSync('src/styles.css', 'utf8')
const missingPreviewScrollTerms = requiredPreviewScrollTerms.filter((term) => !styles.includes(term))
if (missingPreviewScrollTerms.length > 0) {
  console.error(`OCR preview scroll protection is missing: ${missingPreviewScrollTerms.join(', ')}`)
  process.exit(1)
}

const requiredConfidenceTerms = ['temperatureScale', 'evaluateContractTypeConfidence', 'confidenceFactors']
const missingConfidenceTerms = requiredConfidenceTerms.filter((term) => !backend.includes(term))
if (missingConfidenceTerms.length > 0) {
  console.error(`Missing calibrated confidence implementation: ${missingConfidenceTerms.join(', ')}`)
  process.exit(1)
}

const requiredEncodingTerms = ['normalizeTextEncoding', "'\\uFEFF'", 'overflow-wrap: anywhere']
const encodingSource = `${frontend}\n${fs.readFileSync('src/styles.css', 'utf8')}`
const missingEncodingTerms = requiredEncodingTerms.filter((term) => !encodingSource.includes(term))
if (missingEncodingTerms.length > 0) {
  console.error(`Missing encoding or overflow protections: ${missingEncodingTerms.join(', ')}`)
  process.exit(1)
}

const documentParser = fs.readFileSync('backend/services/document-parser.js', 'utf8')
if (!documentParser.includes('normalizeUploadedFileName') || !documentParser.includes("Buffer.from(name, 'latin1').toString('utf8')")) {
  console.error('Backend upload filename normalization is missing.')
  process.exit(1)
}

const wordUploadTerms = ["new Set(['doc', 'docx'])", 'WordExtractor', 'parseDoc(buffer, result)', 'supportedContractFileTypes']
const missingWordUploadTerms = wordUploadTerms.filter((term) => !documentParser.includes(term))
if (missingWordUploadTerms.length > 0 || !frontend.includes('isSupportedContractFile') || !frontend.includes('.doc / .docx') || !serverSource.includes('未能完整识别有效合同正文')) {
  console.error(`Word upload and empty-text handling is incomplete: ${missingWordUploadTerms.join(', ')}`)
  process.exit(1)
}

const compose = fs.readFileSync('docker-compose.yml', 'utf8')
if (!compose.includes('mysql:8.4') || !compose.includes('deepseek-api-key.txt')) {
  console.error('Docker Compose must include MySQL and runtime DeepSeek key mounting.')
  process.exit(1)
}

const famieService = fs.readFileSync('backend/services/famie-service.js', 'utf8')
const famiePanel = fs.readFileSync('src/components/FamieTrainingPanel.vue', 'utf8')
const famieTerms = ['buildFamieAnnotationDataset', 'buildFamieEntityTypeFile', 'getFamieStatus', '/api/famie/status', '/api/famie/annotation-dataset', 'FAMIE 标注服务', '反馈标注优化']
const missingFamieTerms = famieTerms.filter((term) => !`${famieService}\n${serverSource}\n${famiePanel}\n${frontend}`.includes(term))
if (missingFamieTerms.length > 0 || !compose.includes('profiles: ["famie"]') || !compose.includes('127.0.0.1:9000:9000') || !databaseSource.includes('famie_model_versions')) {
  console.error(`FAMIE local annotation integration is incomplete: ${missingFamieTerms.join(', ')}`)
  process.exit(1)
}

const assistantService = fs.readFileSync('backend/services/contract-assistant-service.js', 'utf8')
const assistantPanel = fs.readFileSync('src/components/ContractAssistantFloat.vue', 'utf8')
const semanticRetrieval = fs.readFileSync('backend/services/semantic-retrieval-service.js', 'utf8')
const legalWebSearch = fs.readFileSync('backend/services/legal-web-search-service.js', 'utf8')
const assistantTerms = ['answerContractQuestion', 'askContractAssistantWithDeepSeek', 'askContractAssistantWithEmbeddedModel', 'official-contract-interpretation', '/api/assistant/chat', 'ContractAssistantFloat', 'cloud_polished', 'local_fallback', 'deterministic_fallback', 'pointerdown', 'panelStyle', 'rankSourcesBySemanticSimilarity', 'semantic_vector_index', 'searchTrustedLegalWeb', 'allowWebSearch', '开放全网搜索']
const missingAssistantTerms = assistantTerms.filter((term) => !`${assistantService}\n${backend}\n${localModelService}\n${serverSource}\n${frontend}\n${assistantPanel}\n${semanticRetrieval}\n${legalWebSearch}\n${databaseSource}\n${schema}`.includes(term))
if (missingAssistantTerms.length > 0 || !packageJson.includes('test:assistant') || !fs.readFileSync('backend/services/embedded-embedding-service.js', 'utf8').includes("'--embedding'")) {
  console.error(`Contract optimization Q&A module is incomplete: ${missingAssistantTerms.join(', ')}`)
  process.exit(1)
}

console.log('Self-check passed: required module content, project files, and MySQL schema are present.')
