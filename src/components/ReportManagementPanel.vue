<template>
  <section class="report-stage">
    <header class="report-header">
      <div>
        <p class="section-kicker">Report Management</p>
        <h2>审核报告生成</h2>
        <p>统一组织合同解析、风险审核与标准条款匹配结果，形成可复核、可归档、可导出的审核报告。</p>
      </div>
      <div class="report-actions">
        <label :class="['cloud-toggle', { disabled: isPreparing }]" title="仅本次报告生成授权将合同文本送至 DeepSeek 云端复核">
          <input v-model="allowCloudReview" type="checkbox" :disabled="isPreparing || !canAnalyze" />
          <span class="toggle-track"><span></span></span>
          <span><strong>DeepSeek 云端复核</strong><small>默认关闭，仅用于本次报告</small></span>
        </label>
        <button class="primary-report-command" type="button" :disabled="isPreparing || !canAnalyze" :title="!canAnalyze ? '请先成功解析合同' : isPreparing ? '禁用' : '生成统一审核报告'" @click="prepareReport">
          <component :is="isPreparing ? CircleSlash : FileBarChart" :size="18" />
          {{ isPreparing ? '正在生成' : '生成统一审核报告' }}
        </button>
      </div>
    </header>

    <section class="report-target" aria-label="当前报告目标">
      <FileText :size="18" />
      <span>当前审核目标</span>
      <strong :title="sourceFile">{{ sourceFile }}</strong>
      <small>{{ contractType }}</small>
    </section>

    <p class="report-message">{{ !canAnalyze ? '请先上传并成功解析合同后生成新报告；仍可查看历史报告。' : (auditRunId || matchRunId) ? '复用已完成的审核批次，仅补齐尚未执行的分析；云开关仅用于新分析。' : '本次将执行审核并固定报告快照。' }}</p>
    <p v-if="message" :class="['report-message', messageTone]">{{ message }}</p>

    <template v-if="currentReport">
      <section class="report-message" aria-label="报告模型执行记录">
        <p>解析来源：{{ currentReport.snapshot?.contract?.ai?.provider || '历史记录未提供' }}</p>
        <p>风险审核：{{ currentReport.snapshot?.audit?.engine?.notice || '历史记录未提供执行详情' }}</p>
        <p>条款比对：{{ currentReport.snapshot?.match?.engine?.notice || '历史记录未提供执行详情' }}</p>
        <p>报告固定以上分析结果；复用已有批次时不会重复调用模型。需要重新推理时，请先重新执行风险审核和条款比对。</p>
      </section>
      <section class="report-summary" aria-label="审核结果概览">
        <article><span>综合风险等级</span><strong :class="riskClass(auditSummary.overallLevel)">{{ auditSummary.overallLevel || '待评估' }}</strong><small>风险评分 {{ auditSummary.score ?? '待评估' }} / 100</small></article>
        <article><span>条款完整性</span><strong>{{ matchSummary.overall || '待评估' }}</strong><small>完整性 {{ matchSummary.completenessScore ?? '待评估' }} / 100</small></article>
        <article><span>合同版本</span><strong>V{{ currentReport.versionNumber }}</strong><small>{{ currentReport.changeSummary || '当前文本版本' }}</small></article>
        <article><span>人工复核状态</span><strong :class="reviewClass(currentReport.status)">{{ currentReport.status }}</strong><small>{{ currentReport.reviewUpdatedAt ? formatDateTime(currentReport.reviewUpdatedAt) : '等待人工处理' }}</small></article>
      </section>

      <section class="report-grid">
        <section class="visual-panel">
          <div class="panel-heading"><div><p class="section-kicker">Risk Distribution</p><h3>风险统计图表</h3></div><BarChart3 :size="20" /></div>
          <div class="risk-chart">
            <div v-for="item in riskBars" :key="item.label" class="risk-bar-row">
              <span>{{ item.label }}</span><div class="risk-track"><i :class="item.tone" :style="{ width: `${item.width}%` }"></i></div><b>{{ item.count }}</b>
            </div>
          </div>
          <p class="chart-note">统计基于本次报告的风险条款与缺失条款识别结果。</p>
        </section>

        <section class="visual-panel">
          <div class="panel-heading"><div><p class="section-kicker">Manual Review</p><h3>人工确认与复核</h3></div><ClipboardCheck :size="20" /></div>
          <label class="review-field"><span>复核状态</span><select v-model="reviewStatus" :disabled="isUpdatingReview"><option>待人工确认</option><option>已人工确认</option><option>需复核</option></select></label>
          <label class="review-field"><span>复核备注</span><textarea v-model.trim="reviewNote" :disabled="isUpdatingReview" maxlength="1000" placeholder="记录人工确认结论、补充材料或后续复核要求"></textarea></label>
          <button class="secondary-command" type="button" :disabled="isUpdatingReview" :title="isUpdatingReview ? '禁用' : '保存复核状态'" @click="saveReview"><component :is="isUpdatingReview ? CircleSlash : CheckCircle2" :size="17" />保存复核状态</button>
        </section>
      </section>

      <section class="detail-grid">
        <section class="detail-panel">
          <div class="panel-heading"><div><p class="section-kicker">Key Findings</p><h3>重点风险与建议</h3></div><ShieldAlert :size="20" /></div>
          <div v-if="findings.length" class="finding-list">
            <article v-for="(item, index) in findings.slice(0, 6)" :key="`${item.ruleId || item.title}-${index}`">
              <span :class="['finding-level', riskClass(item.level)]">{{ item.level || '待评估' }}</span>
              <div><strong>{{ item.title || '审核事项' }}</strong><p>{{ item.reason || '系统识别到需进一步审阅的事项。' }}</p><small>建议：{{ item.suggestion || '请结合合同实际情况补充或调整。' }}</small></div>
            </article>
          </div>
          <p v-else class="empty-detail">本次未识别出需列示的风险或缺失条款。</p>
        </section>

        <section class="detail-panel">
          <div class="panel-heading"><div><p class="section-kicker">Clause Coverage</p><h3>条款完整性概览</h3></div><Layers3 :size="20" /></div>
          <dl class="coverage-list"><div><dt>完整</dt><dd>{{ matchSummary.complete || 0 }} 项</dd></div><div><dt>部分具备</dt><dd>{{ matchSummary.partial || 0 }} 项</dd></div><div><dt>缺失</dt><dd>{{ matchSummary.missing || 0 }} 项</dd></div></dl>
          <ul v-if="incompleteClauses.length" class="coverage-gaps"><li v-for="item in incompleteClauses.slice(0, 4)" :key="item.code"><strong>{{ item.title }}</strong><span>{{ item.status }}</span><small>{{ item.suggestion }}</small></li></ul>
          <p v-else class="empty-detail">未识别出需要补充的标准条款要素。</p>
        </section>
      </section>

      <section class="export-band" aria-label="报告导出">
        <div><p class="section-kicker">Export Center</p><h3>报告导出</h3><p>导出内容包含审核概览、风险统计、重点发现、条款完整性、版本信息及人工复核状态。</p></div>
        <div class="export-actions"><button v-for="item in exportFormats" :key="item.format" type="button" :disabled="exportingFormat === item.format" :title="exportingFormat === item.format ? '禁用' : `导出 ${item.label}`" @click="exportReport(item.format)"><component :is="exportingFormat === item.format ? CircleSlash : Download" :size="17" />{{ item.label }}</button></div>
      </section>
    </template>

    <section v-else class="report-empty"><FileBarChart :size="30" /><h3>尚未生成统一审核报告</h3><p>生成后将在这里展示可视化审核结果，并保留合同版本、人工确认状态及三种正式导出格式。</p></section>

    <section class="recent-reports">
      <div class="panel-heading"><div><p class="section-kicker">Report Archive</p><h3>最近报告</h3></div><button class="icon-command" type="button" :disabled="isLoading" :title="isLoading ? '禁用' : '刷新报告列表'" @click="loadManagement"><component :is="isLoading ? CircleSlash : RefreshCw" :size="17" /></button></div>
      <div v-if="recentReports.length" class="recent-list"><article v-for="report in recentReports.slice(0, 5)" :key="report.id" :class="{ active: currentReport?.id === report.id }"><div><strong :title="report.sourceFile">{{ report.sourceFile }}</strong><span>V{{ report.versionNumber }} · {{ report.status }} · {{ formatDateTime(report.createdAt) }}</span></div><button type="button" title="查看此报告" @click="selectReport(report)"><History :size="17" /></button></article></div>
      <p v-else class="empty-detail">暂无已归档的统一审核报告。</p>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { BarChart3, CheckCircle2, CircleSlash, ClipboardCheck, Download, FileBarChart, FileText, History, Layers3, RefreshCw, ShieldAlert } from 'lucide-vue-next'

import { isPersistedContract } from '../../shared/contract-content.js'
import { createLatestRequest } from '../utils/latest-request.js'
const props = defineProps({ contract: { type: Object, required: true }, auditRunId: String, matchRunId: String })
const emit = defineEmits(['audit-created', 'match-created'])
const canAnalyze = computed(() => isPersistedContract(props.contract))
const requests = createLatestRequest()
onBeforeUnmount(() => requests.cancel())
const currentReport = ref(null)
const recentReports = ref([])
const reviewStatus = ref('待人工确认')
const reviewNote = ref('')
const allowCloudReview = ref(false)
const isPreparing = ref(false)
const isUpdatingReview = ref(false)
const isLoading = ref(false)
const exportingFormat = ref('')
const message = ref('')
const messageTone = ref('neutral')
const exportFormats = [{ format: 'word', label: '导出 Word' }, { format: 'pdf', label: '导出 PDF' }, { format: 'html', label: '导出 HTML' }]

const sourceFile = computed(() => String(props.contract?.sourceFile || '未命名合同'))
const contractType = computed(() => String(props.contract?.contractType?.predicted || '未识别合同类型'))
const auditSummary = computed(() => currentReport.value?.snapshot?.audit?.summary || {})
const matchSummary = computed(() => currentReport.value?.snapshot?.match?.summary || {})
const findings = computed(() => [...(currentReport.value?.snapshot?.audit?.risks || []), ...(currentReport.value?.snapshot?.audit?.missingClauses || [])])
const incompleteClauses = computed(() => (currentReport.value?.snapshot?.match?.items || []).filter((item) => item.status !== '完整'))
const riskBars = computed(() => {
  const items = [{ label: '高风险', count: Number(auditSummary.value.high || 0), tone: 'high' }, { label: '中风险', count: Number(auditSummary.value.medium || 0), tone: 'medium' }, { label: '低风险', count: Number(auditSummary.value.low || 0), tone: 'low' }, { label: '缺失条款', count: Number(auditSummary.value.missing || 0), tone: 'missing' }]
  const max = Math.max(1, ...items.map((item) => item.count))
  return items.map((item) => ({ ...item, width: Math.max(item.count ? 12 : 0, Math.round(item.count / max * 100)) }))
})

onMounted(loadManagement)
watch(() => props.contract?.parseSnapshotId, () => { requests.cancel(); isPreparing.value = false; allowCloudReview.value = false; message.value = ''; currentReport.value = null })

async function loadManagement() {
  isLoading.value = true
  try {
    const response = await fetch('/api/report-management')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    recentReports.value = payload.reports || []
  } catch (error) { setMessage(`报告记录读取失败：${errorMessage(error)}`, 'error') } finally { isLoading.value = false }
}

async function prepareReport() {
  if (!canAnalyze.value) return
  const request = requests.begin()
  isPreparing.value = true
  setMessage(allowCloudReview.value ? '正在汇总风险审核、标准条款匹配和已授权的 DeepSeek 云端复核。' : '正在汇总风险审核与标准条款匹配，并生成本地统一审核报告。', 'neutral')
  try {
    const response = await fetch('/api/report-management/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contract: props.contract, allowCloudReview: allowCloudReview.value, auditRunId: props.auditRunId, matchRunId: props.matchRunId }), signal: request.signal })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
    if (!request.isCurrent()) return
    currentReport.value = payload.report
    emit('audit-created', payload.report.snapshot.audit); emit('match-created', payload.report.snapshot.match)
    syncReviewFields(payload.report)
    await loadManagement()
    if (!request.isCurrent()) return
    setMessage(`统一审核报告已生成：V${payload.report.versionNumber}${payload.isNewVersion ? '（新合同版本）' : '（复用当前合同版本）'}。`, 'success')
  } catch (error) { if (!request.isCurrent()) return; setMessage(`统一审核报告生成失败：${errorMessage(error)}`, 'error') } finally { if (request.isCurrent()) isPreparing.value = false }
}

async function saveReview() {
  if (!currentReport.value) return
  const selected = currentReport.value.id
  isUpdatingReview.value = true
  try {
    const response = await fetch(`/api/report-management/${encodeURIComponent(currentReport.value.id)}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: reviewStatus.value, reviewerNote: reviewNote.value }) })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
    if (currentReport.value?.id !== selected) return
    currentReport.value = payload.report
    syncReviewFields(payload.report)
    await loadManagement()
    setMessage('人工复核状态已保存，并已写入历史操作记录。', 'success')
  } catch (error) { setMessage(`复核状态保存失败：${errorMessage(error)}`, 'error') } finally { isUpdatingReview.value = false }
}

async function exportReport(format) {
  if (!currentReport.value) return
  const target = currentReport.value
  exportingFormat.value = format
  try {
    const response = await fetch(`/api/report-management/${encodeURIComponent(target.id)}/export?format=${encodeURIComponent(format)}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const extension = format === 'word' ? 'docx' : format
    downloadBlob(`${safeFileStem(target.sourceFile)}-unified-audit-report-v${target.versionNumber}.${extension}`, await response.blob())
    setMessage(`${format === 'word' ? 'Word' : format.toUpperCase()} 报告下载已开始。`, 'success')
  } catch (error) { setMessage(`报告导出失败：${errorMessage(error)}`, 'error') } finally { exportingFormat.value = '' }
}

function selectReport(report) { currentReport.value = report; syncReviewFields(report); setMessage(`已载入 ${report.sourceFile} 的 V${report.versionNumber} 报告快照。`, 'neutral') }
function syncReviewFields(report) { reviewStatus.value = report.status || '待人工确认'; reviewNote.value = report.reviewerNote || '' }
function riskClass(level) { return level === '高' || level === '高风险' ? 'high' : level === '中' || level === '中风险' ? 'medium' : level === '低' || level === '低风险' ? 'low' : '' }
function reviewClass(status) { return status === '已人工确认' ? 'confirmed' : status === '需复核' ? 'review' : '' }
function safeFileStem(value) { return String(value || 'contract').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'contract' }
function downloadBlob(fileName, blob) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1200) }
function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date) }
function setMessage(value, tone) { message.value = value; messageTone.value = tone }
function errorMessage(error) { return error instanceof Error ? error.message : '未知错误' }
</script>

<style scoped>
.report-stage{display:grid;gap:20px;padding:28px;min-width:0}.report-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding-bottom:20px;border-bottom:1px solid #dbe4ec}.report-header h2,.panel-heading h3,.export-band h3{margin:4px 0 8px;color:#183049;font-size:25px}.report-header p:not(.section-kicker),.export-band p:not(.section-kicker){max-width:720px;margin:0;color:#607184;line-height:1.7}.report-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap}.cloud-toggle{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;max-width:270px;color:#41576c;cursor:pointer}.cloud-toggle input{position:absolute;inline-size:1px;block-size:1px;opacity:0;pointer-events:none}.cloud-toggle strong,.cloud-toggle small{display:block}.cloud-toggle strong{font-size:13px;color:#263f57}.cloud-toggle small{margin-top:2px;font-size:11px;line-height:1.4;color:#718092}.cloud-toggle.disabled{opacity:.6;cursor:not-allowed}.toggle-track{display:flex;align-items:center;width:34px;height:20px;padding:2px;border-radius:999px;background:#aebdca}.toggle-track span{display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(25,48,73,.28);transition:transform .18s ease}.cloud-toggle input:checked + .toggle-track{background:#2364d2}.cloud-toggle input:checked + .toggle-track span{transform:translateX(14px)}.primary-report-command,.secondary-command,.export-actions button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;padding:0 14px;border-radius:8px;font-weight:800;cursor:pointer}.primary-report-command{color:#fff;background:#2364d2}.secondary-command,.export-actions button{border:1px solid #cad7e2;color:#29455e;background:#f8fafc}.primary-report-command:disabled,.secondary-command:disabled,.export-actions button:disabled{opacity:.62;cursor:not-allowed}.report-target{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;gap:9px;padding:11px 13px;border:1px solid #dbe5ed;border-radius:8px;color:#5e7182;background:#f9fbfc;font-size:13px}.report-target strong{min-width:0;color:#243e56;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.report-target small{padding:4px 7px;border-radius:5px;background:#e7eff5;color:#486176}.report-message{margin:0;padding:11px 13px;border-left:3px solid #71859a;background:#f4f7f9;color:#42576b;font-size:13px;line-height:1.55}.report-message.success{border-color:#25815c;background:#edf8f2;color:#176147}.report-message.error{border-color:#b43d3d;background:#fff0f0;color:#8e2d2d}.report-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.report-summary article,.visual-panel,.detail-panel,.recent-reports,.export-band{min-width:0;border:1px solid #dce5ed;border-radius:8px;background:#fff}.report-summary article{display:grid;gap:6px;min-height:120px;padding:16px}.report-summary span,.report-summary small{color:#667789;font-size:13px}.report-summary strong{color:#20394f;font-size:24px;overflow-wrap:anywhere}.report-summary strong.high,.finding-level.high{color:#a02f2f}.report-summary strong.medium,.finding-level.medium{color:#9b6410}.report-summary strong.low,.finding-level.low{color:#237256}.report-summary strong.confirmed{color:#207252}.report-summary strong.review{color:#a45a11}.report-grid,.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.visual-panel,.detail-panel,.recent-reports{padding:20px}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px;color:#43617b}.panel-heading h3,.export-band h3{font-size:18px}.risk-chart{display:grid;gap:13px}.risk-bar-row{display:grid;grid-template-columns:66px minmax(0,1fr) 28px;align-items:center;gap:10px;color:#526579;font-size:13px}.risk-track{height:9px;overflow:hidden;border-radius:9px;background:#edf1f4}.risk-track i{display:block;height:100%;border-radius:inherit}.risk-track i.high{background:#c04b4b}.risk-track i.medium{background:#d29a40}.risk-track i.low{background:#47a77f}.risk-track i.missing{background:#78899b}.risk-bar-row b{color:#253e55;text-align:right}.chart-note,.empty-detail{margin:16px 0 0;color:#718092;font-size:12px;line-height:1.6}.review-field{display:grid;gap:6px;margin-bottom:12px;color:#526579;font-size:13px}.review-field select,.review-field textarea{width:100%;border:1px solid #cfdbe6;border-radius:6px;color:#30475d;background:#fff;font:inherit}.review-field select{min-height:38px;padding:0 10px}.review-field textarea{min-height:86px;padding:10px;resize:vertical;line-height:1.55}.finding-list{display:grid;gap:10px}.finding-list article{display:grid;grid-template-columns:62px minmax(0,1fr);gap:12px;padding:12px;border:1px solid #e0e7ed;border-radius:7px;background:#fbfdff}.finding-level{align-self:start;padding:5px;border-radius:5px;background:#edf1f4;color:#53677a;font-size:12px;font-weight:800;text-align:center}.finding-list strong{color:#1d3347}.finding-list p,.finding-list small{display:block;margin:5px 0 0;color:#586d80;font-size:13px;line-height:1.55}.finding-list small{color:#758596}.coverage-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:0}.coverage-list div{padding:11px;border:1px solid #e0e7ed;border-radius:6px;background:#fbfdff}.coverage-list dt{color:#718092;font-size:12px}.coverage-list dd{margin:5px 0 0;color:#29455e;font-weight:800}.coverage-gaps{display:grid;gap:8px;margin:14px 0 0;padding:0;list-style:none}.coverage-gaps li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;padding-top:9px;border-top:1px solid #edf1f4}.coverage-gaps strong{color:#31495e;font-size:13px}.coverage-gaps span{padding:2px 6px;border-radius:4px;color:#9a5a0d;background:#fff3dc;font-size:11px}.coverage-gaps small{grid-column:1/-1;color:#748495;font-size:12px;line-height:1.5}.export-band{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px}.export-band p:not(.section-kicker){font-size:13px}.export-actions{display:flex;gap:9px;flex-wrap:wrap}.report-empty{display:grid;place-items:center;gap:9px;min-height:260px;padding:30px;border:1px dashed #cbd7e1;border-radius:8px;color:#66798b;text-align:center}.report-empty h3{margin:0;color:#314a60}.report-empty p{max-width:430px;margin:0;line-height:1.65}.recent-reports{padding:20px}.icon-command{display:grid;width:36px;height:36px;place-items:center;border:1px solid #cad7e2;border-radius:7px;color:#3c5870;background:#fff;cursor:pointer}.icon-command:disabled{cursor:not-allowed;opacity:.6}.recent-list{display:grid;gap:8px}.recent-list article{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0;border-top:1px solid #edf1f4}.recent-list article:first-child{border-top:0}.recent-list article.active{padding:10px;border-radius:6px;background:#f4f8fb}.recent-list strong,.recent-list span{display:block}.recent-list strong{max-width:620px;overflow:hidden;color:#2b4358;text-overflow:ellipsis;white-space:nowrap}.recent-list span{margin-top:3px;color:#738394;font-size:12px}.recent-list button{display:grid;width:34px;height:34px;place-items:center;border:1px solid #cad7e2;border-radius:6px;color:#456178;background:#fff;cursor:pointer}@media(max-width:1080px){.report-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.report-stage{padding:16px}.report-header,.export-band{flex-direction:column}.report-actions,.primary-report-command,.cloud-toggle,.export-actions,.export-actions button{width:100%}.report-target{grid-template-columns:auto minmax(0,1fr)}.report-target span,.report-target small{grid-column:2}.report-grid,.detail-grid{grid-template-columns:1fr}.report-summary{grid-template-columns:1fr}.export-actions{display:grid;grid-template-columns:1fr}.recent-list strong{max-width:220px}}
</style>
