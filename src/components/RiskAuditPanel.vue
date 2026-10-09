<template>
  <section class="risk-stage">
    <header class="risk-header">
      <div>
        <p class="section-kicker">Module 02</p>
        <h2>合同风险审核模块</h2>
        <p>基于结构化合同数据，使用增强规则库与本地 Qwen 复核风险条款、缺失条款并输出修改建议；DeepSeek 云端复核按隐私设置启用。</p>
      </div>
      <div class="risk-actions">
        <label class="cloud-review-toggle" :class="{ disabled: isAuditing }">
          <input v-model="allowCloudReview" type="checkbox" :disabled="isAuditing || !canAnalyze" aria-describedby="cloud-review-notice" />
          <span class="toggle-track" aria-hidden="true"><span></span></span>
          <span><strong>DeepSeek 云端复核</strong><small>勾选后，本次合同文本将发送至 DeepSeek。</small></span>
        </label>
        <button class="risk-start" type="button" :disabled="isAuditing || !canAnalyze" :title="!canAnalyze ? '请先成功解析合同' : isAuditing ? '禁用' : '开始风险审核'" @click="runAudit">
          <component :is="isAuditing ? CircleSlash : Play" :size="18" />
          {{ isAuditing ? '审核进行中' : '开始风险审核' }}
        </button>
        <button class="risk-export" type="button" :disabled="!audit || isExportingChecklist" :title="!audit || isExportingChecklist ? '禁用' : '导出风险审核清单'" @click="exportRiskChecklist">
          <component :is="!audit || isExportingChecklist ? CircleSlash : Download" :size="18" />
          导出风险审核清单
        </button>
      </div>
    </header>
    <p class="risk-target-file"><FileText :size="17" /><span>当前审核文件</span><strong :title="contract.sourceFile || '未命名合同'">{{ contract.sourceFile || '未命名合同' }}</strong></p>

    <section class="risk-summary" aria-label="风险审核概览">
      <article><span>综合风险</span><strong>{{ audit?.summary?.overallLevel || '待审核' }}</strong><small>{{ audit ? `${audit.summary.score} / 100` : '规则库与模型协同评估' }}</small></article>
      <article class="high"><span>高风险</span><strong>{{ audit?.summary?.high || 0 }}</strong><small>优先处理</small></article>
      <article class="medium"><span>中风险</span><strong>{{ audit?.summary?.medium || 0 }}</strong><small>建议复核</small></article>
      <article class="low"><span>低风险</span><strong>{{ audit?.summary?.low || 0 }}</strong><small>持续关注</small></article>
      <article><span>缺失条款</span><strong>{{ audit?.summary?.missing || 0 }}</strong><small>{{ audit?.engine?.provider || '待启动审核' }}</small></article>
    </section>

    <section class="risk-workspace">
      <article class="risk-findings">
        <div class="risk-toolbar">
          <div>
            <p class="section-kicker">Risk Findings</p>
            <h3>风险依据与修改建议</h3>
          </div>
          <div class="risk-filters">
            <select v-model="levelFilter" aria-label="按风险等级筛选">
              <option value="全部">全部等级</option><option value="高">高风险</option><option value="中">中风险</option><option value="低">低风险</option>
            </select>
            <input v-model.trim="keyword" type="search" placeholder="筛选风险或条款" aria-label="筛选风险或条款" />
          </div>
        </div>

        <p id="cloud-review-notice" class="cloud-review-notice">默认仅在本机使用增强规则库和 Qwen；开启云端复核即表示授权本次审核向 DeepSeek 发送合同文本。</p>
        <p v-if="message" class="risk-message" role="status">{{ message }}</p>
        <p v-if="audit" class="risk-engine" role="status"><span>执行引擎</span><strong>{{ audit.engine.provider }}</strong><small>{{ engineReviewText }}</small></p>
        <div v-if="!audit && !isAuditing" class="risk-empty"><ShieldCheck :size="28" /><p>请选择“开始风险审核”，系统将以当前合同结构化数据进行审阅。</p></div>
        <ol v-else class="finding-list">
          <li v-for="finding in filteredFindings" :key="`${finding.kind}-${finding.ruleId}`">
            <span :class="['risk-level', levelClass(finding.level)]">{{ finding.level }}风险</span>
            <div class="finding-main"><strong>{{ finding.title }}</strong><p>{{ finding.reason }}</p><small>{{ finding.kind === 'missing' ? '条款缺失判断' : `原文依据：${finding.evidence}` }}</small></div>
            <div class="finding-suggestion"><b>修改建议</b><p>{{ finding.suggestion }}</p></div>
          </li>
        </ol>
        <p v-if="audit" class="risk-boundary">{{ audit.reviewBoundary }}</p>
      </article>

      <aside class="rule-library">
        <div><p class="section-kicker">Rule Library</p><h3>风险规则库</h3></div>
        <p>当前内置 {{ rules.length }} 类常见合同风险规则。</p>
        <ul>
          <li v-for="rule in rules" :key="rule.id"><span>{{ rule.level }}</span><div><strong>{{ rule.title }}</strong><small>{{ rule.category }}</small></div></li>
        </ul>
      </aside>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { CircleSlash, Download, FileText, Play, ShieldCheck } from 'lucide-vue-next'

import { isPersistedContract } from '../../shared/contract-content.js'
import { createLatestRequest } from '../utils/latest-request.js'
const props = defineProps({ contract: { type: Object, required: true }, initialAudit: { type: Object, default: null } })
const emit = defineEmits(['audit-created'])
const canAnalyze = computed(() => isPersistedContract(props.contract))
const requests = createLatestRequest()
onBeforeUnmount(() => requests.cancel())
const audit = ref(props.initialAudit)
const rules = ref([])
const isAuditing = ref(false)
const message = ref('')
const levelFilter = ref('全部')
const keyword = ref('')
const allowCloudReview = ref(false)
const isExportingChecklist = ref(false)

const filteredFindings = computed(() => {
  const findings = [
    ...(audit.value?.risks || []).map((item) => ({ ...item, kind: 'risk' })),
    ...(audit.value?.missingClauses || []).map((item) => ({ ...item, kind: 'missing' }))
  ]
  return findings.filter((item) => {
    const matchesLevel = levelFilter.value === '全部' || item.level === levelFilter.value
    const searchText = `${item.title} ${item.category} ${item.reason} ${item.evidence}`.toLowerCase()
    return matchesLevel && (!keyword.value || searchText.includes(keyword.value.toLowerCase()))
  })
})

const engineReviewText = computed(() => audit.value?.engine?.notice || '执行来源及覆盖情况由后端返回。')

onMounted(loadRules)

async function loadRules() {
  try {
    const response = await fetch('/api/risk-rules')
    const payload = await response.json()
    rules.value = payload.rules || []
  } catch {
    rules.value = []
  }
}

async function runAudit() {
  if (!canAnalyze.value) { message.value = '请先上传并成功解析合同。'; return }
  const request = requests.begin()
  audit.value = null; emit('audit-created', { parseSnapshotId: props.contract.parseSnapshotId })
  isAuditing.value = true
  message.value = allowCloudReview.value
    ? '正在执行增强规则库筛查和本地 Qwen 复核，随后将进行已授权的 DeepSeek 云端二次复核。'
    : '正在执行增强规则库筛查，并请求本地 Qwen 复核候选风险。'
  try {
    const response = await fetch('/api/contracts/risk-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: props.contract, allowCloudReview: allowCloudReview.value }), signal: request.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (!request.isCurrent()) return
    audit.value = payload.audit
    emit('audit-created', payload.audit)
    message.value = engineResultMessage(payload.audit.engine)
  } catch (error) {
    if (!request.isCurrent()) return
    message.value = `风险审核失败：${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    if (request.isCurrent()) isAuditing.value = false
  }
}

async function exportRiskChecklist() {
  if (!audit.value) return
  isExportingChecklist.value = true
  try {
    const response = await fetch('/api/contracts/risk-audit/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: props.contract, audit: audit.value })
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    downloadBlob(`${safeFileStem(props.contract?.sourceFile)}-risk-audit-checklist.docx`, blob)
    message.value = '风险审核清单 Word 文件下载已开始。'
  } catch (error) {
    message.value = `风险审核清单导出失败：${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    isExportingChecklist.value = false
  }
}

function engineResultMessage(engine = {}) { return engine.notice || ('审核完成：' + (engine.provider || '规则库') + ' / ' + (engine.status || '未记录')) }

function levelClass(level) {
  return level === '高' ? 'high' : level === '中' ? 'medium' : 'low'
}

function downloadBlob(fileName, blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

function safeFileStem(value) {
  return String(value || 'contract').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'contract'
}
</script>

<style scoped>
.risk-stage { display:grid; gap:20px; padding:28px; }
.risk-header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; padding-bottom:20px; border-bottom:1px solid #dbe4ec; }
.risk-header h2,.risk-toolbar h3,.rule-library h3 { margin:4px 0 8px; color:#183049; font-size:25px; }
.risk-header p:not(.section-kicker) { max-width:720px; margin:0; color:#607184; line-height:1.7; }
.risk-actions { display:flex; align-items:center; justify-content:flex-end; gap:12px; flex-wrap:wrap; }.cloud-review-toggle { display:grid; grid-template-columns:auto auto minmax(0,1fr); align-items:center; gap:8px; max-width:286px; color:#41576c; cursor:pointer; }.cloud-review-toggle input{position:absolute;inline-size:1px;block-size:1px;opacity:0;pointer-events:none}.cloud-review-toggle strong,.cloud-review-toggle small{display:block}.cloud-review-toggle strong{font-size:13px;color:#263f57}.cloud-review-toggle small{margin-top:2px;font-size:11px;line-height:1.4;color:#718092}.cloud-review-toggle.disabled{opacity:.6;cursor:wait}.toggle-track{display:flex;align-items:center;width:34px;height:20px;padding:2px;border-radius:999px;background:#aebdca;transition:background .18s ease}.toggle-track span{display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(25,48,73,.28);transition:transform .18s ease}.cloud-review-toggle input:checked + .toggle-track{background:#2364d2}.cloud-review-toggle input:checked + .toggle-track span{transform:translateX(14px)}.cloud-review-toggle input:focus-visible + .toggle-track{outline:2px solid #183049;outline-offset:2px}
.risk-start { display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; gap:8px; min-height:44px; padding:0 16px; border-radius:8px; color:#fff; background:#2364d2; font-weight:800; cursor:pointer; }
.risk-export { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:44px; padding:0 14px; border:1px solid #cad7e2; border-radius:8px; color:#29455e; background:#f7fafc; font-weight:800; cursor:pointer; }.risk-start:disabled,.risk-export:disabled { cursor:not-allowed; opacity:.62; }
.risk-target-file { display:flex; align-items:center; gap:8px; min-width:0; margin:0; padding:10px 12px; border:1px solid #dbe5ed; border-radius:6px; color:#5e7182; background:#f9fbfc; font-size:13px; }.risk-target-file span{flex:0 0 auto;color:#718292}.risk-target-file strong{min-width:0;overflow:hidden;color:#243e56;text-overflow:ellipsis;white-space:nowrap}
.risk-summary { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; }
.risk-summary article { display:grid; gap:6px; min-height:112px; padding:16px; border:1px solid #dce5ed; border-radius:8px; background:#fff; }
.risk-summary span,.risk-summary small { color:#667789; font-size:13px; }.risk-summary strong { color:#20394f; font-size:28px; }.risk-summary .high strong{color:#b63a3a}.risk-summary .medium strong{color:#a66712}.risk-summary .low strong{color:#287355}
.risk-workspace { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:18px; align-items:start; }
.risk-findings,.rule-library { min-width:0; padding:20px; border:1px solid #dce5ed; border-radius:8px; background:#fff; }
.risk-toolbar { display:flex; justify-content:space-between; gap:16px; align-items:flex-end; margin-bottom:16px; }.risk-toolbar h3,.rule-library h3{font-size:18px}
.risk-filters { display:flex; gap:8px; }.risk-filters select,.risk-filters input { min-height:36px; padding:0 10px; border:1px solid #cfdbe6; border-radius:6px; color:#30475d; background:#fff; }.risk-filters input{width:156px}
.risk-message { margin:0 0 14px; padding:10px 12px; border-left:3px solid #7a91a5; color:#42576b; background:#f4f7f9; font-size:13px; line-height:1.55; }
.cloud-review-notice { margin:0 0 14px; color:#67798a; font-size:12px; line-height:1.55; }
.risk-engine { display:grid; grid-template-columns:72px minmax(0,1fr); gap:4px 12px; margin:0 0 14px; padding:11px 12px; border:1px solid #dce5ed; border-radius:6px; color:#485c70; background:#fbfdff; font-size:13px; line-height:1.5; }.risk-engine span{color:#718092;font-size:12px}.risk-engine strong{min-width:0;color:#223d56;overflow-wrap:anywhere}.risk-engine small{grid-column:2;color:#667789;font-size:12px}
.risk-empty { display:grid; place-items:center; gap:10px; min-height:260px; color:#6a7b8b; text-align:center; }.risk-empty p{margin:0;max-width:380px;line-height:1.6}
.finding-list { display:grid; gap:10px; margin:0; padding:0; list-style:none; }.finding-list li { display:grid; grid-template-columns:78px minmax(0,1fr) minmax(190px,.55fr); gap:14px; padding:14px; border:1px solid #e0e7ed; border-radius:8px; background:#fbfdff; }
.risk-level { align-self:start; padding:5px 7px; border-radius:6px; font-size:12px; font-weight:800; text-align:center; }.risk-level.high{color:#9d2222;background:#fde8e8}.risk-level.medium{color:#8b590e;background:#fff3dc}.risk-level.low{color:#17664b;background:#e2f5ec}
.finding-main strong { color:#1d3347; }.finding-main p,.finding-suggestion p { margin:6px 0; color:#53677a; font-size:13px; line-height:1.6; }.finding-main small{display:block;color:#758596;font-size:12px;line-height:1.55;overflow-wrap:anywhere}.finding-suggestion{padding-left:14px;border-left:1px solid #d9e3eb}.finding-suggestion b{color:#294b68;font-size:12px}
.risk-boundary { margin:16px 0 0; color:#718092; font-size:12px; line-height:1.6; }.rule-library>p{margin:8px 0 14px;color:#667789;font-size:13px;line-height:1.6}.rule-library ul{display:grid;gap:8px;margin:0;padding:0;list-style:none;max-height:560px;overflow:auto}.rule-library li{display:flex;gap:9px;padding:9px 0;border-top:1px solid #edf1f4}.rule-library li span{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;color:#5d6e7f;background:#edf1f4;font-size:11px;font-weight:800}.rule-library li strong,.rule-library li small{display:block}.rule-library li strong{color:#30475d;font-size:13px}.rule-library li small{margin-top:3px;color:#788694;font-size:12px}
@media (max-width:1000px){.risk-summary{grid-template-columns:repeat(3,minmax(0,1fr))}.risk-workspace{grid-template-columns:1fr}.rule-library ul{max-height:260px}}@media (max-width:640px){.risk-stage{padding:16px}.risk-header,.risk-toolbar{flex-direction:column}.risk-actions{justify-content:stretch;width:100%}.cloud-review-toggle{max-width:none}.risk-start,.risk-export{width:100%}.risk-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.risk-filters{width:100%;flex-wrap:wrap}.risk-filters input{flex:1}.finding-list li{grid-template-columns:1fr}.finding-suggestion{padding:10px 0 0;border-top:1px solid #d9e3eb;border-left:0}}
</style>
