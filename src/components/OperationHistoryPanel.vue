<template>
  <section class="history-stage">
    <header class="history-hero">
      <div>
        <p class="section-kicker">Operation Archive</p>
        <h2>历史操作记录</h2>
        <p>集中管理合同解析、审核报告、人工复核和版本变更的本地留痕。</p>
        <p class="archive-explanation"><Archive :size="15" />归档保留数据；“删除记录”仅移除日志；“删除合同业务数据”需单独预览确认，且不删除原件或OCR语料。</p>
      </div>
      <div class="history-hero-actions">
        <button class="icon-command" type="button" :title="isLoading ? '禁用' : '刷新记录'" :disabled="isLoading" @click="loadOperations">
          <component :is="isLoading ? CircleSlash : RefreshCw" :size="18" />
        </button>
        <button class="backup-command" type="button" :title="isBackingUp ? '禁用' : '记录备份'" :disabled="isBackingUp" @click="downloadBackup">
          <component :is="isBackingUp ? CircleSlash : Download" :size="18" />
          记录备份
        </button>
      </div>
    </header>

    <section class="history-controls" aria-label="操作记录筛选与批量管理">
      <label class="history-search">
        <Search :size="18" />
        <input v-model.trim="searchTerm" type="search" placeholder="检索全部记录的文件名或内容" />
      </label>
      <label class="history-filter">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="all">全部记录</option>
          <option value="active">未归档</option>
          <option value="archived">已归档</option>
        </select>
      </label>
      <label class="history-filter">
        <span>类型</span>
        <select v-model="typeFilter">
          <option value="all">全部操作</option>
          <option v-for="type in availableTypes" :key="type" :value="type">{{ operationLabel(type) }}</option>
        </select>
      </label>
    </section>

    <section class="history-toolbar" aria-live="polite">
      <label class="selection-toggle">
        <input type="checkbox" :checked="allVisibleSelected" :indeterminate.prop="someVisibleSelected" @change="toggleVisibleSelection" />
        <span>已选择本页 {{ selectedIds.size }} 条</span>
      </label>
      <div class="toolbar-actions">
        <button type="button" :disabled="!selectedIds.size || isMutating" :title="!selectedIds.size || isMutating ? '禁用' : '归档所选'" @click="archiveSelected">
          <component :is="!selectedIds.size || isMutating ? CircleSlash : Archive" :size="17" />
          归档所选
        </button>
        <button class="danger-command" type="button" :disabled="!selectedIds.size || isMutating" :title="!selectedIds.size || isMutating ? '禁用' : '多选删除'" @click="deleteSelected">
          <component :is="!selectedIds.size || isMutating ? CircleSlash : Trash2" :size="17" />
          多选删除
        </button>
      </div>
    </section>

    <p v-if="feedback" class="history-feedback" :class="feedbackTone">{{ feedback }}</p>

    <section class="version-panel" aria-label="合同版本管理">
      <div class="version-heading"><div><p class="section-kicker">Contract Versions</p><h3>合同版本管理</h3><p>同名合同内容发生变化时，系统会建立新版本；每个版本保留生成报告数量、最新复核状态和变更摘要。</p></div><GitBranch :size="21" /></div>
      <div v-if="contractVersions.length" class="version-list"><article v-for="version in contractVersions.slice(0, 12)" :key="version.id"><div class="version-number">V{{ version.versionNumber }}</div><div class="version-file"><strong :title="version.sourceFile">{{ version.sourceFile }}</strong><span>{{ version.changeSummary }}</span></div><div class="version-meta"><span>{{ version.summary?.paragraphCount || 0 }} 段 · {{ version.summary?.keyElements || 0 }} 项要素</span><small>{{ formatDateTime(version.createdAt) }}</small></div><span :class="['version-status', versionStatusClass(version.latestReportStatus)]">{{ version.latestReportStatus }}</span><b>{{ version.reportCount }} 份报告</b></article></div>
      <p v-else class="version-empty">尚未生成统一审核报告，因此暂未建立可管理的合同版本。</p>
    </section>

    <nav class="history-toolbar" aria-label="历史记录分页">
      <span>共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页</span>
      <div class="toolbar-actions">
        <label>每页 <select v-model.number="pageSize" :disabled="isMutating"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option></select> 条</label>
        <button :disabled="page <= 1 || isLoading || isMutating" @click="changePage(page-1)">上一页</button>
        <button :disabled="page >= totalPages || isLoading || isMutating" @click="changePage(page+1)">下一页</button>
      </div>
    </nav>
    <section class="history-list" aria-busy="isLoading">
      <div v-if="isLoading" class="history-empty"><LoaderCircle :size="22" class="spinning" />正在读取本地操作记录...</div>
      <div v-else-if="!filteredOperations.length" class="history-empty"><FolderSearch :size="26" />没有符合当前条件的操作记录。</div>
      <article v-for="operation in filteredOperations" :key="operation.id" :class="['operation-row', { archived: operation.archived }]">
        <label class="row-check" :title="`选择 ${sourceFile(operation)}`">
          <input type="checkbox" :checked="selectedIds.has(operation.id)" @change="toggleSelection(operation.id)" />
        </label>
        <div class="operation-type">
          <component :is="operationIcon(operation.type)" :size="19" />
          <span>{{ operationLabel(operation.type) }}</span>
        </div>
        <div class="operation-file">
          <strong :title="sourceFile(operation)">{{ sourceFile(operation) }}</strong>
          <span>{{ operationSummary(operation) }}</span>
        </div>
        <time :datetime="operation.createdAt">{{ formatDateTime(operation.createdAt) }}</time>
        <span :class="['archive-state', { archived: operation.archived }]">{{ operation.archived ? '已归档' : '在用' }}</span>
        <div class="row-actions">
          <button type="button" :title="expandedIds.has(operation.id) ? '收起详情' : '展开详情'" @click="toggleExpanded(operation.id)">
            <ChevronUp v-if="expandedIds.has(operation.id)" :size="18" />
            <ChevronDown v-else :size="18" />
          </button>
          <button type="button" :disabled="downloadingIds.has(operation.id)" :title="downloadingIds.has(operation.id) ? '禁用' : '下载记录'" @click="downloadOperation(operation)"><component :is="downloadingIds.has(operation.id) ? CircleSlash : Download" :size="18" /></button>
          <button v-if="!operation.archived" type="button" :title="isMutating ? '禁用' : '归档记录'" :disabled="isMutating" @click="archiveOperations([operation.id])"><component :is="isMutating ? CircleSlash : Archive" :size="18" /></button>
          <button class="delete-button" type="button" :title="isMutating ? '禁用' : '删除记录'" :disabled="isMutating" @click="deleteOperations([operation.id])"><component :is="isMutating ? CircleSlash : Trash2" :size="18" /></button>
        </div>
        <section v-if="expandedIds.has(operation.id)" class="operation-detail">
          <div>
            <span>分析文件名</span>
            <strong>{{ sourceFile(operation) }}</strong>
          </div>
          <div><span>记录标识</span><strong>{{ shortOperationId(operation.id) }}</strong></div>
          <div v-if="operation.archivedAt">
            <span>归档时间</span>
            <strong>{{ formatDateTime(operation.archivedAt) }}</strong>
          </div>
          <button v-if="operation.payload?.sourceFile || operation.payload?.parsed?.sourceFile || operation.payload?.fileName" class="danger-command" type="button" :disabled="isMutating" @click="deleteContract(operation)">预览删除该合同业务数据</button>
          <div v-for="item in detailItems(operation)" :key="`${operation.id}-${item.label}`" class="detail-item"><span>{{ item.label }}</span><strong>{{ item.value }}</strong></div>
        </section>
      </article>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, watch, ref } from 'vue'
import {
  Archive,
  CircleSlash,
  ChevronDown,
  ChevronUp,
  Download,
  FileSearch,
  FileText,
  FolderSearch,
  GitBranch,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  ScanText,
  Search,
  ShieldAlert,
  Trash2
} from 'lucide-vue-next'

const operations = ref([])
const emit = defineEmits(['contract-deleted'])
const contractVersions = ref([])
const selectedIds = ref(new Set())
const expandedIds = ref(new Set())
const searchTerm = ref('')
const statusFilter = ref('all')
const typeFilter = ref('all')
const isLoading = ref(false)
const isMutating = ref(false)
const isBackingUp = ref(false)
const downloadingIds = ref(new Set())
const feedback = ref('')
const feedbackTone = ref('')

const availableTypes = ref([])
const page = ref(1), pageSize = ref(20), total = ref(0), totalPages = ref(1)
const filteredOperations = computed(() => operations.value)
let loadController, loadSequence = 0, searchTimer
watch([searchTerm,statusFilter,typeFilter,pageSize],()=>{
  clearTimeout(searchTimer)
  loadController?.abort(); loadSequence++
  page.value=1;selectedIds.value=new Set();expandedIds.value=new Set()
  searchTimer=setTimeout(loadOperations,250)
})
onBeforeUnmount(()=>{clearTimeout(searchTimer);loadController?.abort();loadSequence++})
function changePage(value){page.value=value;selectedIds.value=new Set();expandedIds.value=new Set();loadOperations()}
const allVisibleSelected = computed(() => filteredOperations.value.length > 0 && filteredOperations.value.every((operation) => selectedIds.value.has(operation.id)))
const someVisibleSelected = computed(() => filteredOperations.value.some((operation) => selectedIds.value.has(operation.id)) && !allVisibleSelected.value)

onMounted(loadOperations)

async function loadOperations() {
  clearTimeout(searchTimer)
  loadController?.abort()
  const controller=new AbortController();loadController=controller
  const sequence=++loadSequence
  isLoading.value=true;selectedIds.value=new Set();expandedIds.value=new Set()
  try {
    const query=new URLSearchParams({page:String(page.value),pageSize:String(pageSize.value),search:searchTerm.value,status:statusFilter.value,type:typeFilter.value})
    const [operationResponse, versionResponse]=await Promise.all([fetch('/api/operations?'+query,{signal:controller.signal}),fetch('/api/contract-versions',{signal:controller.signal})])
    if(!operationResponse.ok||!versionResponse.ok)throw new Error(`HTTP ${!operationResponse.ok?operationResponse.status:versionResponse.status}`)
    const [payload,versionPayload]=await Promise.all([operationResponse.json(),versionResponse.json()])
    if(sequence!==loadSequence)return
    operations.value=payload.operations||[];contractVersions.value=versionPayload.versions||[]
    total.value=payload.total??operations.value.length;totalPages.value=payload.totalPages||1;page.value=payload.page||1;availableTypes.value=payload.types||[]
    setFeedback(`共 ${total.value} 条，当前加载 ${operations.value.length} 条。选择仅限当前页。`,'success')
  }catch(error){if(sequence!==loadSequence)return;operations.value=[];setFeedback(`操作记录读取失败：${errorMessage(error)}`,'error')}
  finally{if(sequence===loadSequence)isLoading.value=false}
}

function toggleSelection(id) {
  const next = new Set(selectedIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selectedIds.value = next
}

function toggleVisibleSelection() {
  const next = new Set(selectedIds.value)
  if (allVisibleSelected.value) filteredOperations.value.forEach((operation) => next.delete(operation.id))
  else filteredOperations.value.forEach((operation) => next.add(operation.id))
  selectedIds.value = next
}

function toggleExpanded(id) {
  const next = new Set(expandedIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expandedIds.value = next
}

async function archiveSelected() {
  await archiveOperations([...selectedIds.value])
}

async function archiveOperations(ids) {
  const activeIds = ids.filter((id) => !operations.value.find((operation) => operation.id === id)?.archived)
  if (!activeIds.length) {
    setFeedback('所选记录均已归档。', 'neutral')
    return
  }
  await mutate('/api/operations/archive', 'PATCH', { ids: activeIds }, (result) => `已归档 ${result.archived || 0} 条操作记录。`)
}

async function deleteSelected() {
  await deleteOperations([...selectedIds.value])
}

async function deleteOperations(ids) {
  if(ids.length)await confirmDeletion({scope:'history',ids})
}
async function deleteContract(operation) {
  await confirmDeletion({scope:'contract',sourceFile:sourceFile(operation)})
}
const deletionLabels={operation_records:'历史日志',contract_parse_records:'解析记录',contract_risk_audit_records:'风险记录',contract_parse_snapshots:'解析快照',contract_analysis_runs:'审核/比对批次',managed_reports:'报告',contract_versions:'合同版本',semantic_vector_index:'合同向量缓存'}
async function confirmDeletion(input) {
  if(isMutating.value)return
  isMutating.value=true
  try{
    const response=await fetch('/api/operations/deletion-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})
    const preview=await response.json()
    if(!response.ok)throw Error(preview.message||`HTTP ${response.status}`)
    const details=Object.entries(preview.counts).map(([k,v])=>`${deletionLabels[k]||k}：${v} 条`).join('\n')
    if(!preview.total){setFeedback('没有可删除的数据。','neutral');return}
    if(!window.confirm(`${input.scope==='contract'?'合同：'+input.sourceFile:'删除所选历史记录'}\n${details}\n\n${preview.preserved}\n删除无法撤销，是否继续？`))return
    const confirmFileName=input.scope==='contract'?window.prompt('请输入完整合同文件名以确认删除全部同名业务记录：'+input.sourceFile):undefined
    if(input.scope==='contract'&&confirmFileName!==input.sourceFile){setFeedback('文件名未匹配，已取消删除。','neutral');return}
    const result=await fetch('/api/operations',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,token:preview.token,confirmed:true,confirmFileName})})
    const payload=await result.json();if(!result.ok)throw Error(payload.message||`HTTP ${result.status}`)
    if(input.scope==='contract')emit('contract-deleted',input.sourceFile)
    await loadOperations();setFeedback(`已删除 ${payload.deleted} 条${input.scope==='contract'?'合同业务数据':'历史记录'}；OCR语料和原件保留。`,'success')
  }catch(error){setFeedback(`删除失败：${errorMessage(error)}`,'error')}
  finally{isMutating.value=false}
}

async function mutate(url, method, body, messageFactory) {
  isMutating.value = true
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const result = await response.json()
    await loadOperations()
    setFeedback(messageFactory(result), 'success')
  } catch (error) {
    setFeedback(`操作执行失败：${errorMessage(error)}`, 'error')
  } finally {
    isMutating.value = false
  }
}

async function downloadBackup() {
  isBackingUp.value = true
  try {
    const response = await fetch('/api/operations/backup')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'contract-audit-operations-backup.sql'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1200)
    setFeedback('MySQL 数据库备份下载已开始（含语料与印章表）。外部文件请另行运行 npm run backup:full；SQL 下载不包含原件及模型。', 'success')
  } catch (error) {
    setFeedback(`记录备份失败：${errorMessage(error)}`, 'error')
  } finally {
    isBackingUp.value = false
  }
}

async function downloadOperation(operation) {
  const next = new Set(downloadingIds.value)
  next.add(operation.id)
  downloadingIds.value = next
  try {
    const response = await fetch(`/api/operations/${encodeURIComponent(operation.id)}/download`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${safeFileStem(sourceFile(operation))}-${operation.type}-record.html`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1200)
    setFeedback('单条历史记录下载已开始。', 'success')
  } catch (error) {
    setFeedback(`单条历史记录下载失败：${errorMessage(error)}`, 'error')
  } finally {
    const finished = new Set(downloadingIds.value)
    finished.delete(operation.id)
    downloadingIds.value = finished
  }
}

function syncSelection() {
  const available = new Set(operations.value.map((operation) => operation.id))
  selectedIds.value = new Set([...selectedIds.value].filter((id) => available.has(id)))
  expandedIds.value = new Set([...expandedIds.value].filter((id) => available.has(id)))
}

function operationLabel(type) {
  return {
    contract_parse: '合同智能解析',
    ocr_preview_segment: 'OCR 预览整理',
    contract_risk_audit: '合同风险审核',
    standard_clause_match: '标准条款匹配',
    contract_assistant_chat: '合同优化问答',
    audit_report_generate: '审核报告生成',
    risk_audit_checklist_export: '风险审核清单导出',
    standard_clause_match_export: '标准条款匹配报告导出',
    managed_report_generate: '统一审核报告生成',
    managed_report_review: '统一审核报告人工复核',
    managed_report_export: '统一审核报告导出',
    famie_annotation_dataset_export: 'FAMIE 标注样本导出',
    famie_model_register: 'FAMIE 模型登记'
  }[type] || '系统操作'
}

function operationIcon(type) {
  return { contract_parse: FileSearch, ocr_preview_segment: ScanText, contract_risk_audit: ShieldAlert, standard_clause_match: FileSearch, contract_assistant_chat: MessageSquareText, audit_report_generate: FileText, risk_audit_checklist_export: FileText, standard_clause_match_export: FileText, managed_report_generate: FileText, managed_report_review: GitBranch, managed_report_export: Download, famie_annotation_dataset_export: FileSearch, famie_model_register: FileText }[type] || FileText
}

function sourceFile(operation) {
  return String(operation.payload?.sourceFile || operation.payload?.parsed?.sourceFile || operation.payload?.fileName || '未命名分析文件')
}

function operationSummary(operation) {
  const payload = operation.payload || {}
  if (payload.summary?.conclusion) return payload.summary.conclusion
  if (payload.parsed?.summary) return payload.parsed.summary
  if (operation.type === 'standard_clause_match') return `完整性：${payload.summary?.overall || '待评估'}；缺失 ${payload.summary?.missing || 0} 项。`
  if (operation.type === 'contract_assistant_chat') return `问答引擎：${payload.engine?.provider || '未记录'}；引用 ${payload.citationSources?.length || 0} 项来源。`
  if (operation.type === 'managed_report_generate') return `统一审核报告 V${payload.versionNumber || 1}；${payload.status || '待人工确认'}。`
  if (operation.type === 'managed_report_review') return `报告 V${payload.versionNumber || 1} 的人工复核状态：${payload.status || '未记录'}。`
  if (operation.type === 'managed_report_export') return `统一审核报告 V${payload.versionNumber || 1} 已导出 ${payload.format || '文件'}。`
  if (payload.status) return `状态：${payload.status}`
  if (payload.contractType) return `合同类型：${payload.contractType}`
  return '已完成操作留痕，可展开查看结构化详情。'
}

function detailItems(operation) {
  const payload = operation.payload || {}
  if (operation.type === 'contract_parse') return [['解析状态', payload.parsed?.ai?.status || '未记录'], ['分析模型', payload.parsed?.ai?.provider || '本地基础解析'], ['合同类型', payload.parsed?.contractType?.predicted || '未识别'], ['文本长度', `${payload.parsed?.documentParsing?.textLength || 0} 字符`], ['解析摘要', payload.parsed?.summary || '未提供']].map(toDetailItem)
  if (operation.type === 'contract_risk_audit') return [['审核引擎', payload.audit?.engine?.provider || '增强规则库'], ['审核状态', payload.audit?.engine?.status || '未记录'], ['云端复核', payload.cloudReviewRequested ? '已授权并请求 DeepSeek 云端复核' : '未请求云端复核'], ['综合风险', payload.summary?.overallLevel || '待评估'], ['风险评分', `${payload.summary?.score ?? '待评估'} / 100`], ['风险统计', `高 ${payload.summary?.high || 0} 项；中 ${payload.summary?.medium || 0} 项；低 ${payload.summary?.low || 0} 项；缺失 ${payload.summary?.missing || 0} 项`]].map(toDetailItem)
  if (operation.type === 'standard_clause_match') return [['匹配引擎', payload.engine?.provider || '标准条款库'], ['匹配状态', payload.engine?.status || '未记录'], ['云端复核', payload.cloudReviewRequested ? '已授权并请求 DeepSeek 云端复核' : '未请求云端复核'], ['完整性评价', payload.summary?.overall || '待评估'], ['完整性得分', `${payload.summary?.completenessScore ?? '待评估'} / 100`], ['条款统计', `完整 ${payload.summary?.complete || 0} 项；部分具备 ${payload.summary?.partial || 0} 项；缺失 ${payload.summary?.missing || 0} 项`]].map(toDetailItem)
  if (operation.type === 'contract_assistant_chat') return [['问答引擎', payload.engine?.provider || '未记录'], ['处理状态', payload.engine?.status || '未记录'], ['语义检索', payload.retrieval?.semantic?.provider || '词法相关性排序'], ['全网法律检索', payload.retrieval?.web?.requested ? `已开启，${payload.retrieval?.web?.resultCount || 0} 条官方来源` : '未开启'], ['引用来源数', `${payload.citationSources?.length || 0} 项`], ['提问长度', `${payload.questionLength || 0} 字符`], ['答复长度', `${payload.answerLength || 0} 字符`], ['隐私说明', '仅记录操作元数据，不保存对话原文。']].map(toDetailItem)
  if (operation.type === 'ocr_preview_segment') return [['分段来源', payload.provider || '本地结构化分段'], ['分段状态', payload.status || '未记录'], ['章节数量', `${payload.sections?.length || 0} 个`]].map(toDetailItem)
  if (operation.type === 'audit_report_generate' || operation.type === 'risk_audit_checklist_export' || operation.type === 'standard_clause_match_export') return [['生成文件', payload.fileName || '未记录'], ['生成方式', payload.segmentationProvider || payload.auditProvider || payload.matchProvider || '系统生成'], ['文件大小', `${payload.byteLength || 0} 字节`]].map(toDetailItem)
  if (operation.type === 'managed_report_generate') return [['报告标识', shortOperationId(payload.reportId)], ['合同版本', `V${payload.versionNumber || 1}`], ['报告状态', payload.status || '待人工确认'], ['云端复核', payload.cloudReviewRequested ? '已授权并请求 DeepSeek 云端复核' : '未请求云端复核'], ['风险统计', `高 ${payload.summary?.high || 0} 项；中 ${payload.summary?.medium || 0} 项；低 ${payload.summary?.low || 0} 项；缺失 ${payload.summary?.missing || 0} 项`], ['完整性评价', `${payload.completeness?.overall || '待评估'}；${payload.completeness?.completenessScore ?? '待评估'} / 100`]].map(toDetailItem)
  if (operation.type === 'managed_report_review') return [['报告标识', shortOperationId(payload.reportId)], ['合同版本', `V${payload.versionNumber || 1}`], ['人工复核状态', payload.status || '未记录'], ['复核备注', payload.hasReviewerNote ? '已填写（内容保存在报告快照中）' : '未填写']].map(toDetailItem)
  if (operation.type === 'managed_report_export') return [['报告标识', shortOperationId(payload.reportId)], ['合同版本', `V${payload.versionNumber || 1}`], ['导出格式', payload.format || '未记录'], ['生成文件', payload.fileName || '未记录'], ['文件大小', `${payload.byteLength || 0} 字节`]].map(toDetailItem)
  if (operation.type === 'famie_annotation_dataset_export') return [['导出样本数', `${payload.unitCount || 0} 条`], ['原始段落数', `${payload.paragraphCount || 0} 条`], ['实体类型数', `${payload.entityTypeCount || 0} 类`], ['传输方式', payload.dataTransmission === 'manual_local_export_only' ? '仅本地手动导出，未自动上传' : '未记录']].map(toDetailItem)
  if (operation.type === 'famie_model_register') return [['模型版本', payload.versionName || '未命名版本'], ['模型文件', payload.fileName || '未记录'], ['模型状态', payload.status || '未记录'], ['文件大小', `${payload.byteLength || 0} 字节`], ['校验摘要', payload.sha256 || '未记录']].map(toDetailItem)
  return [toDetailItem(['操作说明', '已完成系统操作留痕。'])]
}

function toDetailItem([label, value]) {
  return { label, value: String(value || '未记录') }
}

function shortOperationId(value) {
  const text = String(value || '')
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text || '未记录'
}

function safeFileStem(value) {
  return String(value || 'operation').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'operation'
}

function formatDateTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(date)
}

function versionStatusClass(value) { return value === '已人工确认' ? 'confirmed' : value === '需复核' ? 'review' : '' }

function setFeedback(message, tone) {
  feedback.value = message
  feedbackTone.value = tone
}

function errorMessage(error) {
  return error instanceof Error ? error.message : '未知错误'
}
</script>

<style scoped>
.history-stage { display: grid; gap: 18px; align-content: start; padding: 26px; min-width: 0; }
.history-hero, .history-controls, .history-toolbar, .history-list, .version-panel { border: 1px solid #d8e1ea; border-radius: 8px; background: #fff; box-shadow: 0 18px 46px rgba(24,44,66,.08); }
.history-hero { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px; }
.section-kicker { margin: 0 0 6px; color: #6d7b8a; font-size: 12px; font-weight: 800; }
h2 { margin: 0 0 10px; color: #132335; font-size: 30px; line-height: 1.22; } .history-hero p:not(.section-kicker) { margin: 0; color: #607082; line-height: 1.7; }.archive-explanation{display:flex;align-items:flex-start;gap:6px;margin-top:9px!important;font-size:12px;line-height:1.55!important;color:#6a7988!important}
.history-hero-actions, .toolbar-actions, .row-actions { display: flex; align-items: center; gap: 8px; }.history-hero button, .history-toolbar button, .row-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; border: 0; border-radius: 8px; cursor: pointer; font: inherit; }
.icon-command { width: 40px; color: #31495f; background: #edf4f9; }.backup-command { padding: 0 14px; color: #fff; font-weight: 800; background: #2364d2; }
.history-controls { display: grid; grid-template-columns: minmax(260px, 1fr) 170px 190px; gap: 12px; padding: 14px; }.history-search { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 0 12px; border: 1px solid #cfdae5; border-radius: 8px; color: #607082; background: #fbfdff; }.history-search input { width: 100%; min-width: 0; height: 40px; border: 0; outline: 0; color: #20394f; background: transparent; }.history-filter { display: grid; grid-template-columns: 38px 1fr; align-items: center; gap: 7px; color: #647587; font-size: 13px; }.history-filter select { min-width: 0; height: 40px; padding: 0 8px; border: 1px solid #cfdae5; border-radius: 8px; color: #20394f; background: #fff; }
.history-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 14px; }.selection-toggle { display: inline-flex; align-items: center; gap: 8px; color: #4f6172; font-size: 13px; font-weight: 700; }.history-toolbar button { padding: 0 12px; color: #31495f; background: #eef4f7; }.history-toolbar .danger-command, .row-actions .delete-button { color: #aa3434; background: #fff0f0; }.history-toolbar button:disabled, .row-actions button:disabled, .history-hero button:disabled { cursor: not-allowed; opacity: .55; }
.history-feedback { margin: -6px 0 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; font-weight: 700; }.history-feedback.success { color: #0f6b4d; background: #e3f7ed; }.history-feedback.error { color: #a63232; background: #fff0f0; }.history-feedback.neutral { color: #596a7a; background: #eef2f5; }
.version-panel{padding:20px}.version-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px;color:#456177}.version-heading h3{margin:3px 0 7px;color:#1c3449;font-size:18px}.version-heading p:not(.section-kicker){max-width:700px;margin:0;color:#68798a;font-size:13px;line-height:1.6}.version-list{display:grid;gap:8px}.version-list article{display:grid;grid-template-columns:48px minmax(170px,1fr) minmax(130px,.5fr) auto 72px;align-items:center;gap:12px;padding:11px 0;border-top:1px solid #edf1f4}.version-list article:first-child{border-top:0}.version-number{display:grid;width:42px;height:32px;place-items:center;border-radius:6px;color:#245674;background:#e9f2f7;font-size:12px;font-weight:900}.version-file,.version-meta{display:grid;min-width:0;gap:3px}.version-file strong,.version-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.version-file strong{color:#203a50;font-size:13px}.version-file span,.version-meta{color:#718191;font-size:12px}.version-meta small{font-size:11px}.version-status{padding:5px 8px;border-radius:999px;color:#687887;background:#edf1f4;font-size:11px;font-weight:800;white-space:nowrap}.version-status.confirmed{color:#176447;background:#e1f5eb}.version-status.review{color:#965909;background:#fff2dc}.version-list b{color:#37536a;font-size:12px;text-align:right;white-space:nowrap}.version-empty{margin:0;color:#718191;font-size:13px;line-height:1.6}
.history-list { overflow: hidden; }.history-empty { display: flex; min-height: 180px; align-items: center; justify-content: center; gap: 10px; padding: 24px; color: #637489; text-align: center; }
.operation-row { display: grid; grid-template-columns: 30px 156px minmax(190px,1fr) 160px 56px 124px; gap: 12px; align-items: center; min-width: 0; padding: 15px 16px; border-bottom: 1px solid #e4ebf0; }.operation-row:last-child { border-bottom: 0; }.operation-row.archived { background: #f7f9fa; }.row-check { display: grid; place-items: center; }.operation-type { display: inline-flex; align-items: center; gap: 8px; color: #234258; font-size: 13px; font-weight: 800; }.operation-file { display: grid; min-width: 0; gap: 4px; }.operation-file strong, .operation-file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.operation-file strong { color: #1d3347; }.operation-file span { color: #71808e; font-size: 12px; }.operation-row time { color: #647587; font-size: 12px; }.archive-state { justify-self: start; padding: 5px 8px; border-radius: 999px; color: #216a54; font-size: 11px; font-weight: 800; background: #e2f6eb; }.archive-state.archived { color: #697887; background: #e9eef1; }.row-actions { justify-content: flex-end; }.row-actions button { width: 36px; color: #3e556a; background: #edf3f7; }
.operation-detail { grid-column: 2 / -1; display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px; padding: 14px; border: 1px solid #dbe6ee; border-radius: 8px; background: #f8fbfd; }.operation-detail div { display: grid; gap: 4px; min-width: 0; }.operation-detail span { color: #738290; font-size: 12px; }.operation-detail strong { min-width: 0; color: #23394e; font-size: 13px; overflow-wrap: anywhere; }.operation-detail .detail-item{padding:10px;border:1px solid #e0e8ee;border-radius:6px;background:#fff}.spinning { animation: spin 900ms linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1000px) { .history-controls { grid-template-columns: 1fr 1fr; }.history-search { grid-column: 1 / -1; }.operation-row { grid-template-columns: 28px 144px minmax(160px,1fr) 110px; }.archive-state { display: none; }.row-actions { grid-column: 4; grid-row: 1; }.operation-detail { grid-column: 2 / -1; }.version-list article{grid-template-columns:48px minmax(160px,1fr) auto 72px}.version-meta{display:none} }
@media (max-width: 680px) { .history-stage { padding: 16px; }.history-hero, .history-toolbar { align-items: flex-start; flex-direction: column; }.history-controls { grid-template-columns: 1fr; }.history-search { grid-column: auto; }.operation-row { grid-template-columns: 28px 1fr 78px; gap: 9px; }.operation-type { grid-column: 2; }.operation-file { grid-column: 2 / -1; }.operation-row time { grid-column: 2; }.row-actions { grid-column: 3; grid-row: 1; }.operation-detail { grid-column: 2 / -1; grid-template-columns: 1fr; }.operation-detail pre { grid-column: auto; }.version-list article{grid-template-columns:44px minmax(0,1fr) auto}.version-list b{display:none}.version-status{font-size:10px}.version-file span{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical} }
</style>
