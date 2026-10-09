<template>
  <section class="famie-stage">
    <header class="famie-hero">
      <div>
        <p class="section-kicker">Active Learning</p>
        <h2>反馈标注优化</h2>
        <p>合同关键要素的本地人工标注与模型版本登记。</p>
      </div>
      <div :class="['service-state', famie.ready ? 'ready' : 'offline']">
        <component :is="famie.ready ? BadgeCheck : CircleSlash" :size="19" />
        <div><span>FAMIE 标注服务</span><strong>{{ serviceStateText }}</strong></div>
      </div>
    </header>

    <section class="famie-dashboard">
      <article class="dataset-card">
        <div class="card-heading">
          <div><p class="section-kicker">Annotation Set</p><h3>合同要素标注集</h3></div>
          <FileStack :size="22" />
        </div>
        <dl>
          <div><dt>当前分析文件</dt><dd :title="sourceFile">{{ sourceFile }}</dd></div>
          <div><dt>可用段落</dt><dd>{{ paragraphCount }} 条</dd></div>
          <div><dt>实体类型</dt><dd>14 类</dd></div>
        </dl>
        <div class="command-cluster">
          <button type="button" :disabled="isExporting" :title="isExporting ? '禁用' : '下载标注样本'" @click="downloadAnnotationSet">
            <component :is="isExporting ? CircleSlash : Download" :size="17" />下载标注样本
          </button>
          <button class="secondary" type="button" :disabled="isDownloadingSchema" :title="isDownloadingSchema ? '禁用' : '下载实体类型'" @click="downloadEntitySchema">
            <component :is="isDownloadingSchema ? CircleSlash : Tags" :size="17" />下载实体类型
          </button>
        </div>
        <p class="privacy-note"><ShieldCheck :size="15" />本次导出仅在本机生成，不会自动上传合同文本。</p>
      </article>

      <article class="service-card">
        <div class="card-heading">
          <div><p class="section-kicker">Local Workspace</p><h3>FAMIE 标注工作台</h3></div>
          <Activity :size="22" />
        </div>
        <p class="service-message">{{ famie.message || '正在读取本地服务状态。' }}</p>
        <div class="service-meta"><span>运行位置</span><strong>{{ famie.ready ? '本机独立服务' : '等待本机启动' }}</strong></div>
        <div class="command-cluster">
          <button type="button" :disabled="!famie.ready" :title="famie.ready ? '打开 FAMIE 工作台' : '禁用'" @click="openFamie">
            <component :is="famie.ready ? ExternalLink : CircleSlash" :size="17" />打开工作台
          </button>
          <button class="secondary icon-command" type="button" :disabled="isLoading" :title="isLoading ? '禁用' : '刷新服务状态'" @click="loadStatus"><component :is="isLoading ? CircleSlash : RefreshCw" :size="17" /></button>
        </div>
      </article>
    </section>

    <section class="model-panel">
      <header>
        <div><p class="section-kicker">Model Registry</p><h3>训练模型版本</h3></div>
        <span>{{ models.length }} 个已登记版本</span>
      </header>
      <form class="model-form" @submit.prevent="registerModel">
        <label><span>模型版本</span><input v-model.trim="modelVersion" maxlength="120" placeholder="例如 contract-elements-v1" /></label>
        <label><span>FAMIE 检查点</span><input ref="modelFileInput" type="file" accept=".ckpt" @change="selectModelFile" /></label>
        <label><span>备注</span><input v-model.trim="modelNotes" maxlength="500" placeholder="标注集范围、评测信息" /></label>
        <button type="submit" :disabled="!selectedModelFile || isRegistering" :title="!selectedModelFile || isRegistering ? '禁用' : '登记模型版本'"><component :is="isRegistering ? CircleSlash : Database" :size="17" />登记版本</button>
      </form>
      <p v-if="feedback" :class="['famie-feedback', feedbackTone]">{{ feedback }}</p>
      <div v-if="models.length" class="model-list">
        <article v-for="model in models" :key="model.id">
          <div><strong>{{ model.versionName }}</strong><span :title="model.originalFileName">{{ model.originalFileName }}</span></div>
          <span class="model-state">{{ modelStatusLabel(model.status) }}</span>
          <time :datetime="model.createdAt">{{ formatDateTime(model.createdAt) }}</time>
          <span>{{ formatBytes(model.byteLength) }}</span>
        </article>
      </div>
      <div v-else class="model-empty"><ArchiveRestore :size="22" />尚未登记 FAMIE 训练检查点。</div>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { Activity, ArchiveRestore, BadgeCheck, CircleSlash, Database, Download, ExternalLink, FileStack, RefreshCw, ShieldCheck, Tags } from 'lucide-vue-next'

const props = defineProps({ contract: { type: Object, required: true } })

const famie = ref({ ready: false, state: 'loading', message: '正在读取本地服务状态。' })
const models = ref([])
const isLoading = ref(false)
const isExporting = ref(false)
const isDownloadingSchema = ref(false)
const isRegistering = ref(false)
const selectedModelFile = ref(null)
const modelFileInput = ref(null)
const modelVersion = ref('')
const modelNotes = ref('')
const feedback = ref('')
const feedbackTone = ref('success')

const sourceFile = computed(() => String(props.contract?.sourceFile || '未命名分析文件'))
const paragraphCount = computed(() => Array.isArray(props.contract?.paragraphStructure) ? props.contract.paragraphStructure.length : 0)
const serviceStateText = computed(() => famie.value.ready ? '已就绪' : famie.value.state === 'disabled' ? '已关闭' : '未启动')

onMounted(loadStatus)

async function loadStatus() {
  isLoading.value = true
  try {
    const [statusResponse, modelResponse] = await Promise.all([fetch('/api/famie/status'), fetch('/api/famie/models')])
    const statusPayload = await statusResponse.json()
    if (!statusResponse.ok) throw new Error(statusPayload.message || `HTTP ${statusResponse.status}`)
    famie.value = statusPayload.famie || famie.value
    if (modelResponse.ok) {
      const modelPayload = await modelResponse.json()
      models.value = Array.isArray(modelPayload.models) ? modelPayload.models : []
    }
  } catch (error) {
    famie.value = { ready: false, state: 'unavailable', message: '无法读取 FAMIE 服务状态。请确认合同解析 API 已启动。' }
  } finally {
    isLoading.value = false
  }
}

async function downloadAnnotationSet() {
  isExporting.value = true
  setFeedback('')
  try {
    const response = await fetch('/api/famie/annotation-dataset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contract: props.contract }) })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.message || `HTTP ${response.status}`)
    }
    downloadResponse(response, `${safeStem(sourceFile.value)}-famie-unlabeled-contract-elements.txt`)
    setFeedback('FAMIE 标注样本下载已开始。', 'success')
  } catch (error) {
    setFeedback(`标注样本导出失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
  } finally {
    isExporting.value = false
  }
}

async function downloadEntitySchema() {
  isDownloadingSchema.value = true
  setFeedback('')
  try {
    const response = await fetch('/api/famie/entity-types')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    downloadResponse(response, 'famie-contract-element-entity-types.txt')
    setFeedback('实体类型文件下载已开始。', 'success')
  } catch (error) {
    setFeedback(`实体类型文件下载失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
  } finally {
    isDownloadingSchema.value = false
  }
}

function openFamie() {
  if (famie.value.ready && famie.value.uiUrl) window.open(famie.value.uiUrl, '_blank', 'noopener')
}

function selectModelFile(event) {
  selectedModelFile.value = event.target.files?.[0] || null
  if (selectedModelFile.value && !modelVersion.value) modelVersion.value = safeStem(selectedModelFile.value.name)
}

async function registerModel() {
  if (!selectedModelFile.value) return
  isRegistering.value = true
  setFeedback('')
  try {
    const formData = new FormData()
    formData.append('model', selectedModelFile.value)
    formData.append('versionName', modelVersion.value || safeStem(selectedModelFile.value.name))
    formData.append('notes', modelNotes.value)
    const response = await fetch('/api/famie/models', { method: 'POST', body: formData })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
    models.value = [payload.model, ...models.value]
    selectedModelFile.value = null
    modelVersion.value = ''
    modelNotes.value = ''
    if (modelFileInput.value) modelFileInput.value.value = ''
    setFeedback('模型检查点已登记，状态为“待验证”，当前不会参与合同解析。', 'success')
  } catch (error) {
    setFeedback(`模型登记失败：${error instanceof Error ? error.message : '未知错误'}`, 'error')
  } finally {
    isRegistering.value = false
  }
}

async function downloadResponse(response, fallbackName) {
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fallbackName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

function setFeedback(message, tone = 'success') {
  feedback.value = message
  feedbackTone.value = tone
}

function safeStem(value) {
  return String(value || 'contract').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'contract'
}

function modelStatusLabel(status) {
  return status === 'registered_unvalidated' ? '待验证' : status || '未记录'
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date)
}
</script>

<style scoped>
.famie-stage{display:grid;gap:18px;align-content:start;padding:26px;min-width:0}.famie-hero,.dataset-card,.service-card,.model-panel{border:1px solid #d8e1ea;border-radius:8px;background:#fff;box-shadow:0 18px 46px rgba(24,44,66,.08)}.famie-hero{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:24px}.section-kicker{margin:0 0 6px;color:#607a91;font-weight:800;font-size:12px;letter-spacing:0}.famie-hero h2,.card-heading h3,.model-panel h3{margin:0;color:#132335}.famie-hero h2{font-size:30px}.famie-hero p:not(.section-kicker){margin:9px 0 0;color:#607082}.service-state{display:flex;align-items:center;gap:10px;min-width:154px;padding:12px 14px;border-radius:8px}.service-state.ready{color:#096e54;background:#e5f7ef}.service-state.offline{color:#7a5260;background:#f7eef0}.service-state span,.service-state strong{display:block}.service-state span{font-size:12px}.service-state strong{margin-top:3px}.famie-dashboard{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:18px}.dataset-card,.service-card,.model-panel{padding:20px}.card-heading,.model-panel>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.card-heading>svg{color:#4e718d}.dataset-card dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:22px 0}.dataset-card dl div,.service-meta{min-width:0;padding:12px;border:1px solid #dbe5ee;border-radius:7px;background:#f8fbfd}.dataset-card dt,.service-meta span{color:#6b7b8b;font-size:12px}.dataset-card dd{overflow:hidden;margin:5px 0 0;color:#1d3449;font-weight:800;white-space:nowrap;text-overflow:ellipsis}.service-message{min-height:50px;margin:22px 0;color:#526577;line-height:1.65}.service-meta{display:flex;align-items:center;justify-content:space-between;gap:12px}.service-meta strong{color:#1e4057;font-size:13px}.command-cluster{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.command-cluster button,.model-form button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 12px;border:0;border-radius:7px;background:#176f68;color:#fff;cursor:pointer;font:inherit;font-size:13px;font-weight:800}.command-cluster .secondary{color:#31526a;background:#eaf0f5}.command-cluster button:disabled,.model-form button:disabled{color:#788995;background:#e7edf2;cursor:not-allowed}.icon-command{width:40px;padding:0!important}.privacy-note{display:flex;align-items:center;gap:6px;margin:16px 0 0;color:#547066;font-size:12px;line-height:1.55}.model-panel>header span{padding:7px 9px;border-radius:999px;background:#edf2f6;color:#50667a;font-size:12px;font-weight:800}.model-form{display:grid;grid-template-columns:1.1fr 1.1fr 1.2fr auto;gap:12px;align-items:end;margin-top:20px}.model-form label{display:grid;gap:6px;min-width:0;color:#647587;font-size:12px;font-weight:800}.model-form input{min-width:0;height:39px;padding:0 10px;border:1px solid #cedbe6;border-radius:7px;outline:0;color:#1e364c;background:#fbfdff;font:inherit;font-size:13px}.model-form input:focus{border-color:#2d837c;box-shadow:0 0 0 3px rgba(45,131,124,.12)}.famie-feedback{margin:16px 0 0;padding:10px 12px;border-radius:7px;font-size:13px}.famie-feedback.success{color:#096e54;background:#e7f7f0}.famie-feedback.error{color:#9f3642;background:#fcebed}.model-list{display:grid;margin-top:18px;border-top:1px solid #e1e9ef}.model-list article{display:grid;grid-template-columns:minmax(0,1fr) 92px 150px 74px;align-items:center;gap:12px;padding:13px 2px;border-bottom:1px solid #e1e9ef}.model-list strong,.model-list span{display:block}.model-list strong{overflow:hidden;color:#1c344a;text-overflow:ellipsis;white-space:nowrap}.model-list div span{overflow:hidden;margin-top:3px;color:#6a7a89;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.model-state{width:max-content;padding:4px 7px;border-radius:999px;background:#fff2d9;color:#8b6519;font-size:12px;font-weight:800}.model-list time,.model-list>span{color:#647587;font-size:12px}.model-empty{display:flex;align-items:center;justify-content:center;gap:8px;min-height:92px;margin-top:18px;border-top:1px solid #e1e9ef;color:#768897;font-size:13px}@media(max-width:900px){.famie-hero,.famie-dashboard{grid-template-columns:1fr;display:grid}.service-state{justify-self:start}.dataset-card dl,.model-form{grid-template-columns:1fr}.model-list article{grid-template-columns:1fr 90px}.model-list time,.model-list article>span:last-child{grid-column:1/-1}}
</style>
