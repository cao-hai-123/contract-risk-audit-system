<template>
  <main class="audit-console">
    <aside class="side-rail">
      <div class="product-lockup">
        <div class="logo-mark">A24</div>
        <div>
          <p>合同智能解析与审核</p>
          <h1>企业合同智能审核与风险预警系统</h1>
        </div>
      </div>

      <nav class="module-list" aria-label="系统模块与记录管理">
        <button v-for="item in modules" :key="item.name" :class="['module-item', { active: item.key === activeModule }]" type="button" @click="activeModule = item.key">
          <component :is="item.icon" :size="18" />
          <span>{{ item.name }}</span>
          <ChevronRight v-if="item.key === activeModule" :size="16" />
        </button>
      </nav>

      <section v-if="activeModule !== 'seal'" class="model-strip">
        <div>
          <span class="live-dot"></span>
          <strong>{{ parsedContract.analysisState === 'demo' ? '示例数据' : parsedContract.ai.provider }}</strong>
        </div>
        <p>{{ parsedContract.analysisState === 'demo' ? '上传合同后显示实际执行状态' : parsedContract.ai.message || parsedContract.ai.notice || parsedContract.ai.model || '请先上传合同' }}</p>
      </section>
    </aside>

    <section v-if="activeModule === 'parser'" class="main-stage">
      <header class="hero-bar">
        <div>
          <p class="section-kicker">合同智能解析模块</p>
          <h2>从合同上传到结构化数据，一屏完成解析闭环</h2>
          <p class="hero-copy">
            支持 PDF、Word、图片合同解析，保留段落结构，并调用 DeepSeek 完成合同类型初步判断与关键要素抽取。
          </p>
        </div>
        <div class="hero-stats" aria-label="解析能力指标">
          <div>
            <strong>3</strong>
            <span>文件格式</span>
          </div>
          <div>
            <strong>6</strong>
            <span>模块一能力</span>
          </div>
          <div>
            <strong>{{ parsedContract.paragraphStructure.length }}</strong>
            <span>段落结构</span>
          </div>
        </div>
      </header>

      <section class="work-grid">
        <section class="upload-workbench">
          <div class="drop-surface" :class="{ parsing: isParsing }">
            <input id="contract-file" type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff" @change="handleFileChange" />
            <label for="contract-file">
              <span class="upload-icon"><UploadCloud :size="36" /></span>
              <strong>{{ selectedFileName || '选择或拖入合同文件' }}</strong>
              <small>支持 PDF、Word（.doc / .docx）与图片合同解析</small>
            </label>
          </div>

          <div class="action-matrix" aria-label="合同智能解析操作">
            <button v-for="action in parseActions" :key="action.label" type="button" :disabled="isParsing" :title="isParsing ? '禁用' : action.label" @click="handleAction(action.key)">
              <component :is="isParsing ? CircleSlash : action.icon" :size="18" />
              <span>{{ action.label }}</span>
            </button>
          </div>

          <div class="command-row">
            <button class="primary-command" type="button" :disabled="isParsing" :title="isParsing ? '禁用' : '开始智能解析'" @click="runParse">
              <component :is="isParsing ? CircleSlash : Sparkles" :size="19" />
              {{ isParsing ? '操作进行中' : '开始智能解析' }}
            </button>
            <button class="quiet-command" type="button" @click="resetDemo">
              <RotateCcw :size="18" />
              重置样例
            </button>
            <button class="quiet-command" type="button" :disabled="!canAnalyze" @click="exportJson">
              <Download :size="18" />
              导出 JSON
            </button>
          </div>
          <p v-if="downloadStatus" class="download-status">{{ downloadStatus }}</p>
          <p v-if="parseError" class="parse-feedback" role="alert">{{ parseError }}</p>
          <p v-if="parsedContract.analysisState === 'demo'" class="parse-feedback">当前为脱敏示例预览。请上传合同后使用审核、问答与报告功能。</p>
        </section>

        <section class="pipeline-panel">
          <div class="panel-title">
            <div>
              <p class="section-kicker">Pipeline</p>
              <h3>解析流水线</h3>
            </div>
            <span :class="['status-badge', statusTone]">{{ statusText }}</span>
          </div>

          <ol class="pipeline-list">
            <li v-for="step in pipeline" :key="step.name" :class="step.state">
              <span class="step-index">{{ step.index }}</span>
              <div>
                <strong>{{ step.name }}</strong>
                <p>{{ step.desc }}</p>
              </div>
            </li>
          </ol>
        </section>
      </section>

      <section class="insight-grid">
        <article class="summary-panel">
          <div class="panel-title">
            <div>
              <p class="section-kicker">Structured Output</p>
              <h3>结构化合同数据</h3>
            </div>
            <span class="status-badge neutral">统一输入</span>
          </div>
          <pre>{{ JSON.stringify(parsedContract, null, 2) }}</pre>
        </article>

        <article class="facts-panel">
          <div class="panel-title">
            <div>
              <p class="section-kicker">Key Elements</p>
              <h3>合同关键要素</h3>
            </div>
            <button class="confidence" type="button" @click="showConfidenceDetail = !showConfidenceDetail">{{ confidenceText }}</button>
          </div>

          <dl>
            <template v-for="field in keyFields" :key="field.label">
              <dt>{{ field.label }}</dt>
              <dd>{{ field.value }}</dd>
            </template>
          </dl>
          <div v-if="showConfidenceDetail" class="confidence-detail">
            <strong>置信度评价依据</strong>
            <p>{{ confidenceMethodText }}</p>
            <ul>
              <li v-for="factor in confidenceFactors" :key="factor.label">
                <span>{{ factor.label }}</span>
                <b>{{ factor.value }}</b>
              </li>
            </ul>
          </div>
        </article>
      </section>

      <section class="next-band">
        <button type="button" @click="activeModule = 'risk'">
          <ShieldCheck :size="18" />
          进入风险审核
        </button>
        <button type="button" @click="activeModule = 'comparison'">
          <GitCompare :size="18" />
          标准条款比对
        </button>
        <button type="button" title="进入报告管理" @click="activeModule = 'report'">
          <FileBarChart :size="18" />
          进入报告管理
        </button>
        <button type="button" @click="activeModule = 'feedback'">
          <MessageSquareText :size="18" />
          反馈标注优化
        </button>
      </section>
    </section>

    <RiskAuditPanel v-else-if="activeModule === 'risk'" :key="parsedContract.parseSnapshotId || parsedContract.analysisState" :contract="parsedContract" :initial-audit="auditResult" @audit-created="rememberAudit" />
    <StandardClauseMatchPanel v-else-if="activeModule === 'comparison'" :key="parsedContract.parseSnapshotId || parsedContract.analysisState" :contract="parsedContract" :initial-match="matchResult" @match-created="rememberMatch" />
    <ReportManagementPanel v-else-if="activeModule === 'report'" :contract="parsedContract" :audit-run-id="auditResult?.analysisRunId" :match-run-id="matchResult?.analysisRunId" @audit-created="rememberAudit" @match-created="rememberMatch" />
    <FamieTrainingPanel v-else-if="activeModule === 'feedback'" :contract="parsedContract" />
    <OperationHistoryPanel v-else-if="activeModule === 'history'" @contract-deleted="handleContractDeleted" />
    <SealRecognitionPanel v-else-if="activeModule === 'seal'" />
    <section v-else class="module-placeholder"><FileText :size="34" /><h2>{{ activeModuleName }}</h2><p>该模块的工作区预留已建立，当前请先使用合同智能解析与合同风险审核模块。</p></section>

    <section v-if="showOcrPreview" class="preview-backdrop" aria-label="OCR 文字识别预览">
      <article class="ocr-preview">
        <header>
          <div>
            <p class="section-kicker">OCR Preview</p>
            <h3>文字识别结果预览</h3>
          </div>
          <button class="close-button" type="button" aria-label="关闭 OCR 预览" @click="showOcrPreview = false">
            <X :size="18" />
          </button>
        </header>
        <div class="ocr-meta">
          <span>{{ displaySourceFile }}</span>
          <span>{{ parsedContract.ocr.required ? 'OCR 通道' : '文本解析通道' }}</span>
          <span>{{ ocrPreviewParagraphCount }} 个智能段落</span>
          <span class="ocr-status">{{ ocrPreviewStatus }}</span>
        </div>
        <div class="ocr-paragraphs" :aria-busy="isOrganizingOcr">
          <p v-if="isOrganizingOcr" class="ocr-loading">正在调用 DeepSeek 按语义整理识别文本...</p>
          <section v-for="(section, sectionIndex) in ocrPreviewSections" :key="`${section.title}-${sectionIndex}`" class="ocr-section">
            <h4>{{ section.title }}</h4>
            <ol>
              <li v-for="(paragraph, paragraphIndex) in section.paragraphs" :key="`${sectionIndex}-${paragraphIndex}`">
                <span>{{ ocrParagraphNumber(sectionIndex, paragraphIndex) }}</span>
                <p>{{ paragraph.text || paragraph }}</p>
              </li>
            </ol>
          </section>
        </div>
      </article>
    </section>
    <ContractAssistantFloat v-if="activeModule !== 'seal'" :contract="parsedContract" />
  </main>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { emptyContract, isPersistedContract } from '../shared/contract-content.js'
import { createLatestRequest } from './utils/latest-request.js'
import OperationHistoryPanel from './components/OperationHistoryPanel.vue'
import FamieTrainingPanel from './components/FamieTrainingPanel.vue'
import RiskAuditPanel from './components/RiskAuditPanel.vue'
import StandardClauseMatchPanel from './components/StandardClauseMatchPanel.vue'
import ReportManagementPanel from './components/ReportManagementPanel.vue'
import ContractAssistantFloat from './components/ContractAssistantFloat.vue'
import SealRecognitionPanel from './components/SealRecognitionPanel.vue'
import {
  Braces,
  CircleSlash,
  ChevronRight,
  Download,
  FileBarChart,
  FileCog,
  FileSearch,
  FileText,
  FileUp,
  GitCompare,
  Layers3,
  MessageSquareText,
  RotateCcw,
  ScanText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tags,
  UploadCloud,
  X
} from 'lucide-vue-next'

const parseRequests = createLatestRequest(), ocrRequests = createLatestRequest()
const auditResult = ref(null), matchResult = ref(null)
const selectedFileName = ref('')
const selectedFile = ref(null)
const isParsing = ref(false)
const statusText = ref('待上传')
const statusTone = ref('idle')
const downloadStatus = ref('')
const parseError = ref('')
const isOrganizingOcr = ref(false)
const showOcrPreview = ref(false)
const showConfidenceDetail = ref(false)
const ocrPreviewSections = ref([])
const ocrPreviewStatus = ref('待整理')
const activeModule = ref('parser')

const modules = [
  { key: 'seal', name: '印章识别', icon: ScanText },
  { key: 'parser', name: '合同智能解析', icon: FileSearch },
  { key: 'risk', name: '风险审核预警', icon: ShieldAlert },
  { key: 'comparison', name: '标准条款比对', icon: GitCompare },
  { key: 'report', name: '审核报告生成', icon: FileText },
  { key: 'feedback', name: '反馈标注优化', icon: MessageSquareText },
  { key: 'history', name: '历史操作记录', icon: FileText }
]

const parseActions = [
  { key: 'upload', label: '合同文件上传', icon: FileUp },
  { key: 'parse', label: 'PDF、Word、图片合同解析', icon: FileCog },
  { key: 'ocr', label: 'OCR 文字识别', icon: ScanText },
  { key: 'paragraphs', label: '段落结构保留', icon: Layers3 },
  { key: 'type', label: '合同类型初步判断', icon: Tags },
  { key: 'elements', label: '合同关键要素抽取', icon: Braces }
]

const pipeline = reactive([
  { index: '01', name: '合同文件上传', desc: '接收 PDF、Word、图片等多格式合同文件。', state: 'ready' },
  { index: '02', name: 'PDF、Word、图片合同解析', desc: '按文件类型进入文本抽取或 OCR 通道。', state: 'ready' },
  { index: '03', name: 'OCR 文字识别', desc: '图片与扫描件合同预留 OCR 识别流程。', state: 'ready' },
  { index: '04', name: '段落结构保留', desc: '保留标题、条款、自然段等基础结构。', state: 'ready' },
  { index: '05', name: '合同类型初步判断', desc: '结合 DeepSeek 判断采购、销售、保密、外包、劳动等类型。', state: 'ready' },
  { index: '06', name: '合同关键要素抽取', desc: '抽取主体、日期、金额、履行期限、争议解决方式。', state: 'ready' }
])

const demoContract = {
  analysisState: 'demo',
  sourceFile: '示例-服务外包合同.pdf',
  parserModule: '合同智能解析模块',
  supportedFormats: ['PDF', 'Word', '图片'],
  documentParsing: {
    parser: 'demo-parser',
    textLength: 1680,
    warnings: []
  },
  ocr: {
    required: false,
    enabled: false,
    status: 'not_required',
    confidence: 0
  },
  paragraphStructure: [
    { index: 1, type: 'section', title: '合同主体', content: '甲方与乙方均为脱敏模拟主体。' },
    { index: 2, type: 'clause', title: '服务内容与交付', content: '乙方按约定提供软件开发与运维服务。' },
    { index: 3, type: 'clause', title: '金额、付款与验收', content: '合同金额及付款节点由双方确认。' }
  ],
  contractType: {
    predicted: '服务外包合同',
    confidence: 0.88,
    reason: '文本包含服务交付、验收和外包服务表述。',
    confidenceMethod: 'temperature_scaled_self_score_plus_evidence_weighting',
    confidenceFactors: {
      calibratedTop: 0.86,
      classMargin: 0.42,
      keywordSupport: 0.83,
      extractionCompleteness: 1,
      parserQuality: 0.95,
      temperature: 1.35
    }
  },
  keyElements: {
    parties: '甲方：示例科技有限公司；乙方：示例服务有限公司',
    signedDate: '2026-08-18',
    amount: '人民币 480,000 元',
    performancePeriod: '2026-09-01 至 2027-02-28',
    disputeResolution: '提交甲方所在地人民法院管辖'
  },
  elementEvidence: [],
  summary: '该示例合同为服务外包合同，已抽取主体、日期、金额、期限和争议解决方式。',
  ai: {
    provider: 'DeepSeek',
    model: 'deepseek-chat',
    used: false,
    trackingId: '14ef73d6-457f-4e07-af5c-02aa83ba6f75',
    status: 'demo'
  },
  outputTarget: '为后续风险审核、问答、报告生成等模块提供统一输入'
}

const parsedContract = ref(structuredClone(demoContract))
const canAnalyze = computed(() => isPersistedContract(parsedContract.value))
watch(() => parsedContract.value.parseSnapshotId, () => { auditResult.value = null; matchResult.value = null })
function rememberAudit(result) { if (result?.parseSnapshotId === parsedContract.value.parseSnapshotId) auditResult.value = result.analysisRunId ? result : null }
function rememberMatch(result) { if (result?.parseSnapshotId === parsedContract.value.parseSnapshotId) matchResult.value = result.analysisRunId ? result : null }

const displaySourceFile = computed(() => normalizeTextEncoding(parsedContract.value.sourceFile || '未命名合同'))
const activeModuleName = computed(() => modules.find((item) => item.key === activeModule.value)?.name || '模块工作区')
const ocrPreviewParagraphCount = computed(() => ocrPreviewSections.value.reduce((total, section) => total + (section.paragraphs?.length || 0), 0))

const confidenceText = computed(() => {
  const confidence = parsedContract.value.contractType?.confidence
  if (typeof confidence !== 'number') return '置信度待评估'
  return `类型置信度 ${(confidence * 100).toFixed(0)}%`
})

const confidenceMethodText = computed(() => {
  const method = parsedContract.value.contractType?.confidenceMethod
  if (method === 'temperature_scaled_self_score_plus_evidence_weighting') {
    return '综合模型分布变换、关键词支持度、字段完整度与解析质量的启发式评分；尚未通过独立标注集校准，不代表分类正确概率。'
  }
  return '当前展示基础置信度，后端可用时会返回校准后的综合评分。'
})

const confidenceFactors = computed(() => {
  const factors = parsedContract.value.contractType?.confidenceFactors || {}
  return [
    { label: '校准后最高类概率', value: formatPercent(factors.calibratedTop) },
    { label: '分类边际', value: formatPercent(factors.classMargin) },
    { label: '类型关键词支持', value: formatPercent(factors.keywordSupport) },
    { label: '关键字段完整度', value: formatPercent(factors.extractionCompleteness) },
    { label: '文档解析质量', value: formatPercent(factors.parserQuality) },
    { label: '温度系数', value: factors.temperature ? String(factors.temperature) : '待评估' }
  ]
})

const keyFields = computed(() => [
  { label: '合同双方', value: parsedContract.value.keyElements?.parties || '未识别' },
  { label: '签署日期', value: parsedContract.value.keyElements?.signedDate || '未识别' },
  { label: '合同金额', value: parsedContract.value.keyElements?.amount || '未识别' },
  { label: '履行期限', value: parsedContract.value.keyElements?.performancePeriod || '未识别' },
  { label: '争议解决方式', value: parsedContract.value.keyElements?.disputeResolution || '未识别' },
  { label: '初判类型', value: parsedContract.value.contractType?.predicted || '未识别' }
])

async function handleFileChange(event) {
  const [file] = event.target.files
  if (!file) return

  if (!isSupportedContractFile(file.name)) {
    parseRequests.cancel(); ocrRequests.cancel(); isParsing.value = false
    selectedFile.value = null; selectedFileName.value = normalizeTextEncoding(file.name)
    parsedContract.value = emptyContract(selectedFileName.value, 'failed')
    showOcrPreview.value = false
    parseError.value = '暂不支持该文件格式。请上传 PDF、Word（.doc/.docx）或图片合同。'
    statusText.value = '文件格式不支持'
    statusTone.value = 'idle'
    event.target.value = ''
    return
  }

  selectedFile.value = file
  selectedFileName.value = normalizeTextEncoding(file.name)
  await runBackendParse(file)
}

async function handleAction(key) {
  if (key === 'upload') { document.getElementById('contract-file')?.click(); return }
  if (key === 'ocr') { if (canAnalyze.value) await openOcrPreview(); else parseError.value = '请先上传并成功解析合同。'; return }
  await runParse()
}

async function runParse() {
  if (isParsing.value) return
  if (selectedFile.value) {
    return runBackendParse(selectedFile.value)
  }

  markPipeline('done')
  statusText.value = '样例解析完成'
  statusTone.value = 'success'
}

function resetDemo() {
  parseRequests.cancel(); ocrRequests.cancel(); isParsing.value = false
  const fileInput = document.getElementById('contract-file'); if (fileInput) fileInput.value = ''
  selectedFile.value = null
  selectedFileName.value = ''
  parsedContract.value = structuredClone(demoContract)
  markPipeline('ready')
  statusText.value = '待上传'
  statusTone.value = 'idle'
  showOcrPreview.value = false
  showConfidenceDetail.value = false
  ocrPreviewSections.value = []
  ocrPreviewStatus.value = '待整理'
  isOrganizingOcr.value = false
  downloadStatus.value = ''
  parseError.value = ''
}

function handleContractDeleted(sourceFile) {
  if(parsedContract.value.sourceFile!==sourceFile)return
  resetDemo()
  parsedContract.value=emptyContract()
  statusText.value='当前合同业务数据已删除，请重新上传后分析。'
}

async function runBackendParse(file) {
  const request = parseRequests.begin()
  ocrRequests.cancel()
  showOcrPreview.value = false
  ocrPreviewSections.value = []
  parsedContract.value = emptyContract(normalizeTextEncoding(file.name), 'parsing')
  isParsing.value = true
  statusText.value = '解析中'
  statusTone.value = 'idle'
  parseError.value = ''
  markPipeline('active')
  const formData = new FormData()
  formData.append('contract', file)
  try {
    const response = await fetch('/api/contracts/parse', { method: 'POST', body: formData, signal: request.signal })
    const payload = await response.json().catch(() => { throw new Error('解析服务未返回有效响应，请确认 npm run dev 已同时启动前端和 API。') })
    if (!request.isCurrent()) return false
    if (!response.ok) throw new Error(payload.message || ('HTTP ' + response.status))
    if (!isPersistedContract(payload.parsed)) throw new Error('解析结果无有效正文或缺少保存凭证，请重新上传。')
    parsedContract.value = payload.parsed
    markPipeline('done')
    statusText.value = payload.parsed.ai?.used ? `${payload.parsed.ai.provider} 解析完成` : '基础解析完成（模型未完成分析）'
    parseError.value = payload.parsed.ai?.used ? '' : (payload.parsed.ai?.message || '当前为本地基础解析，请核对关键要素。')
    statusTone.value = 'success'
    return true
  } catch (error) {
    if (!request.isCurrent()) return false
    parsedContract.value = emptyContract(normalizeTextEncoding(file.name), 'failed')
    const message = error?.message || '未知错误'
    parseError.value = /Failed to fetch|NetworkError|ECONNREFUSED|ECONNABORTED|ECONNRESET|Load failed/i.test(message)
      ? '无法连接合同解析服务或上传连接已中断。请检查 npm run dev 终端与 MySQL 服务，确认历史记录中未完成本次解析后重新上传。'
      : '合同解析失败：' + message
    statusText.value = '解析失败'
    statusTone.value = 'idle'
    markPipeline('ready')
    return false
  } finally {
    if (request.isCurrent()) isParsing.value = false
  }
}

function isSupportedContractFile(fileName) {
  const extension = String(fileName || '').split('.').pop()?.toLowerCase()
  return ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'].includes(extension)
}

function markPipeline(state) {
  pipeline.forEach((step) => {
    step.state = state
  })
}

function exportJson() {
  if (!canAnalyze.value) return
  const name = sanitizeFileName(displaySourceFile.value || 'contract')
  downloadBlob(`${name}-structured-data.json`, JSON.stringify(parsedContract.value, null, 2), 'application/json;charset=utf-8', true)
  downloadStatus.value = 'JSON 文件下载已开始'
}

async function openOcrPreview() {
  if (!canAnalyze.value) return
  const request = ocrRequests.begin()
  const contract = parsedContract.value
  showOcrPreview.value = true
  isOrganizingOcr.value = true
  ocrPreviewStatus.value = 'DeepSeek 智能整理中'
  ocrPreviewSections.value = buildLocalPreviewSections(parsedContract.value.paragraphStructure)

  try {
    const response = await fetch('/api/contracts/preview-segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract }), signal: request.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const payload = await response.json()
    if (!request.isCurrent() || contract.parseSnapshotId !== parsedContract.value.parseSnapshotId) return
    ocrPreviewSections.value = normalizePreviewSections(payload.sections)
    ocrPreviewStatus.value = payload.provider === 'DeepSeek' ? 'DeepSeek 语义分段' : '本地结构化分段'
  } catch {
    if (!request.isCurrent()) return
    ocrPreviewSections.value = buildLocalPreviewSections(parsedContract.value.paragraphStructure)
    ocrPreviewStatus.value = '本地结构化分段'
  } finally {
    if (request.isCurrent()) isOrganizingOcr.value = false
  }
}

function normalizePreviewSections(sections) {
  const normalized = Array.isArray(sections)
    ? sections
        .map((section) => ({
          title: normalizeTextEncoding(section?.title || '合同正文'),
          paragraphs: Array.isArray(section?.paragraphs)
            ? section.paragraphs
                .map((paragraph) => ({ text: normalizeTextEncoding(paragraph?.text || paragraph || '') }))
                .filter((paragraph) => paragraph.text)
            : []
        }))
        .filter((section) => section.paragraphs.length)
    : []
  return normalized.length ? normalized : buildLocalPreviewSections(parsedContract.value.paragraphStructure)
}

function buildLocalPreviewSections(paragraphs) {
  return [{
    title: '合同正文',
    paragraphs: (paragraphs || []).map((paragraph) => ({ text: normalizeTextEncoding(paragraph.content || paragraph.title || '') })).filter((paragraph) => paragraph.text)
  }]
}

function ocrParagraphNumber(sectionIndex, paragraphIndex) {
  return ocrPreviewSections.value
    .slice(0, sectionIndex)
    .reduce((total, section) => total + (section.paragraphs?.length || 0), 0) + paragraphIndex + 1
}

function downloadBlob(fileName, content, type, withBom = false) {
  const blob = content instanceof Blob ? content : new Blob(withBom ? ['\uFEFF', content] : [content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

function sanitizeFileName(name) {
  const cleaned = normalizeTextEncoding(name).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim()
  return looksMojibake(cleaned) || !cleaned ? 'contract' : cleaned
}

function formatPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '待评估'
  return `${(numeric * 100).toFixed(0)}%`
}

function normalizeTextEncoding(value) {
  const text = String(value || '')
  try {
    const percentEncoded = Array.from(text, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')
    const repaired = decodeURIComponent(percentEncoded)
    if (countCjk(repaired) > countCjk(text) || (looksMojibake(text) && !looksMojibake(repaired))) {
      return repaired
    }
  } catch {
    return text
  }
  return text
}

function countCjk(value) {
  return (String(value).match(/[\u4e00-\u9fff]/g) || []).length
}

function looksMojibake(value) {
  return /[ÃÂÅåäæçèéê]/.test(String(value))
}
</script>
