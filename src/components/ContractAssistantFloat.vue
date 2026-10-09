<template>
  <Teleport to="body">
    <section v-if="isOpen" class="assistant-panel" :style="panelStyle" role="dialog" aria-modal="false" aria-label="合同智能助手">
      <header class="assistant-header">
        <div class="assistant-heading">
          <span class="assistant-mark"><Bot :size="20" /></span>
          <div>
            <strong>合同智能助手</strong>
            <small>{{ currentFileName }}</small>
          </div>
        </div>
        <button class="assistant-icon-button" type="button" title="关闭助手" aria-label="关闭助手" @click="isOpen = false"><X :size="19" /></button>
      </header>

      <div class="assistant-engine" :class="engineTone">
        <Cloud :size="15" />
        <span>{{ engineNotice }}</span>
      </div>

      <div ref="messageList" class="assistant-messages" aria-live="polite">
        <article v-for="message in messages" :key="message.id" :class="['assistant-message', message.role]">
          <div class="message-role"><Bot v-if="message.role === 'assistant'" :size="14" /><UserRound v-else :size="14" /><span>{{ message.role === 'assistant' ? '智能助手' : '你' }}</span></div>
          <p>{{ message.content }}</p>
          <p v-if="message.summary" class="message-summary">{{ message.summary }}</p>
          <ul v-if="message.suggestions?.length" class="message-suggestions">
            <li v-for="suggestion in message.suggestions" :key="suggestion">{{ suggestion }}</li>
          </ul>
          <div v-if="message.citations?.length" class="citation-list">
            <component :is="citation.url ? 'a' : 'span'" v-for="citation in message.citations" :key="citation.id" class="citation-card" :href="citation.url || undefined" :target="citation.url ? '_blank' : undefined" :rel="citation.url ? 'noreferrer' : undefined">
              <span class="citation-type"><FileText v-if="citation.type === 'contract'" :size="13" /><Database v-else-if="citation.type === 'database'" :size="13" /><BookOpen v-else :size="13" />{{ citation.type === 'contract' ? '合同原文' : citation.type === 'database' ? '系统知识库' : '可信公开来源' }}</span>
              <b>[{{ citation.id }}] {{ citation.title }}</b>
              <em>{{ citation.excerpt }}</em>
            </component>
          </div>
          <small v-if="message.boundary" class="message-boundary">{{ message.boundary }}</small>
        </article>
        <div v-if="isSending" class="assistant-typing"><span></span><span></span><span></span>正在组织可核验的答复</div>
      </div>

      <div class="assistant-prompts" aria-label="快捷提问">
        <button v-for="prompt in quickPrompts" :key="prompt" type="button" :disabled="isSending || !canAnalyze" :title="isSending ? '禁用' : prompt" @click="sendQuestion(prompt)">{{ prompt }}</button>
      </div>

      <form class="assistant-composer" @submit.prevent="sendQuestion(question)">
        <div class="assistant-composer-left">
          <textarea v-model="question" :disabled="isSending || !canAnalyze" maxlength="2000" rows="3" placeholder="输入合同问题、条款解释或修改需求" @keydown.enter.exact.prevent="sendQuestion(question)" />
          <button :class="['web-search-toggle', { active: allowWebSearch }]" type="button" :disabled="isSending || !canAnalyze" :aria-pressed="allowWebSearch" :title="isSending ? '禁用' : '开放全网搜索：仅发送当前问题关键词，不发送合同原文'" @click="allowWebSearch = !allowWebSearch"><Globe2 :size="14" />开放全网搜索</button>
        </div>
        <button class="assistant-send-button" type="submit" :disabled="isSending || !canAnalyze || !question.trim()" :title="isSending || !question.trim() ? '禁用' : '发送问题'">
          <CircleSlash v-if="isSending || !question.trim()" :size="18" /><Send v-else :size="18" />
        </button>
      </form>
    </section>

    <button class="assistant-orb" type="button" :style="orbStyle" :aria-label="isOpen ? '收起合同智能助手' : '打开合同智能助手'" :title="isOpen ? '收起合同智能助手' : '打开合同智能助手'" @pointerdown="beginDrag" @click="toggleAssistant">
      <Bot :size="25" />
      <span>AI</span>
    </button>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BookOpen, Bot, CircleSlash, Cloud, Database, FileText, Globe2, Send, UserRound, X } from 'lucide-vue-next'

const props = defineProps({
  contract: { type: Object, required: true }
})

import { isPersistedContract } from '../../shared/contract-content.js'
import { createLatestRequest } from '../utils/latest-request.js'
const requests = createLatestRequest()
const canAnalyze = computed(() => isPersistedContract(props.contract))
onBeforeUnmount(() => requests.cancel())
const safeMargin = 12
const orbSize = 62
const isOpen = ref(false)
const isSending = ref(false)
const question = ref('')
const allowWebSearch = ref(false)
const messageList = ref(null)
const viewport = ref({ width: window.innerWidth, height: window.innerHeight })
const position = ref(loadPosition())
const drag = ref({ active: false, moved: false, offsetX: 0, offsetY: 0 })
const engine = ref({ provider: '就绪', status: 'idle', fallback: false, notice: '默认先由本地 Qwen 生成证据草稿，再由 DeepSeek 云端复核和润色。' })
const messages = ref([{
  id: crypto.randomUUID(),
  role: 'assistant',
  content: '我可以基于当前合同原文、系统知识库和可信公开来源，协助解释条款、概括重点并提出审慎的完善建议。',
  boundary: '答复仅用于合同审阅辅助，不构成法律意见。'
}])

watch(() => props.contract?.parseSnapshotId, () => {
  requests.cancel(); messages.value = []; question.value = ''; isSending.value = false; allowWebSearch.value = false
  engine.value = { provider: '待提问', status: 'idle', notice: '会话已切换到当前合同，先前合同上下文已清除。' }
})

const quickPrompts = ['概括本合同重点', '解释当前合同的争议解决条款', '有哪些条款建议完善']
const currentFileName = computed(() => String(props.contract?.sourceFile || '当前解析合同'))
const engineNotice = computed(() => !canAnalyze.value ? '请先上传并成功解析合同，示例或失败数据不能用于问答。' : engine.value.notice || '正在等待提问。')
const engineTone = computed(() => engine.value.fallback ? 'fallback' : engine.value.status === 'cloud_polished' ? 'cloud' : '')
const orbStyle = computed(() => ({ left: `${position.value.x}px`, top: `${position.value.y}px` }))
const panelStyle = computed(() => {
  const width = Math.min(430, Math.max(280, viewport.value.width - safeMargin * 2))
  const height = Math.min(640, Math.max(420, viewport.value.height - safeMargin * 2))
  const opensLeft = position.value.x > viewport.value.width / 2
  const rawLeft = opensLeft ? position.value.x - width - 14 : position.value.x + orbSize + 10
  const rawTop = position.value.y > viewport.value.height / 2 ? position.value.y - height + orbSize : position.value.y
  return { width: `${width}px`, height: `${height}px`, left: `${clamp(rawLeft, safeMargin, viewport.value.width - width - safeMargin)}px`, top: `${clamp(rawTop, safeMargin, viewport.value.height - height - safeMargin)}px` }
})

function toggleAssistant() {
  if (drag.value.moved) return
  isOpen.value = !isOpen.value
  if (isOpen.value) scrollMessages()
}

function beginDrag(event) {
  drag.value = { active: true, moved: false, offsetX: event.clientX - position.value.x, offsetY: event.clientY - position.value.y }
  event.currentTarget.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', moveDrag)
  window.addEventListener('pointerup', endDrag, { once: true })
}

function moveDrag(event) {
  if (!drag.value.active) return
  const nextX = clamp(event.clientX - drag.value.offsetX, safeMargin, viewport.value.width - orbSize - safeMargin)
  const nextY = clamp(event.clientY - drag.value.offsetY, safeMargin, viewport.value.height - orbSize - safeMargin)
  if (Math.abs(nextX - position.value.x) > 3 || Math.abs(nextY - position.value.y) > 3) drag.value.moved = true
  position.value = { x: nextX, y: nextY }
}

function endDrag() {
  if (!drag.value.active) return
  drag.value.active = false
  window.removeEventListener('pointermove', moveDrag)
  localStorage.setItem('contract-assistant-orb', JSON.stringify(position.value))
}

async function sendQuestion(rawQuestion) {
  const content = String(rawQuestion || '').trim()
  if (!content || isSending.value || !canAnalyze.value) return
  const request = requests.begin()
  question.value = ''
  messages.value.push({ id: crypto.randomUUID(), role: 'user', content })
  isSending.value = true
  engine.value = { provider: '处理中', status: 'processing', fallback: false, notice: allowWebSearch.value ? '正在进行本地混合检索、官方全网法律检索，并请求本地模型和 DeepSeek 复核。' : '正在进行本地混合检索，并请求本地模型和 DeepSeek 复核。' }
  scrollMessages()
  try {
    const response = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: request.signal,
      body: JSON.stringify({ question: content, contract: props.contract, allowWebSearch: allowWebSearch.value, history: messages.value.slice(-7).map(({ role, content: itemContent }) => ({ role, content: itemContent })) })
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
    if (!request.isCurrent()) return
    const reply = payload.reply
    engine.value = reply.engine
    messages.value.push({ id: crypto.randomUUID(), role: 'assistant', content: reply.answer, summary: reply.summary, suggestions: reply.suggestions, citations: reply.citations, boundary: reply.boundary })
  } catch (error) {
    if (!request.isCurrent()) return
    engine.value = { provider: '服务异常', status: 'error', fallback: true, notice: '问答服务暂时不可用，未生成可核验的答复。' }
    messages.value.push({ id: crypto.randomUUID(), role: 'assistant', content: `本次问答未完成：${error instanceof Error ? error.message : '未知错误'}。请稍后重试。`, boundary: '未生成模型答复。' })
  } finally {
    if (request.isCurrent()) { isSending.value = false; scrollMessages() }
  }
}

function resizeViewport() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  position.value = { x: clamp(position.value.x, safeMargin, viewport.value.width - orbSize - safeMargin), y: clamp(position.value.y, safeMargin, viewport.value.height - orbSize - safeMargin) }
}

function scrollMessages() {
  nextTick(() => { if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight })
}

function loadPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem('contract-assistant-orb') || '{}')
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved
  } catch {
    // Use the default bottom-right position when the saved value is malformed.
  }
  return { x: Math.max(safeMargin, window.innerWidth - 86), y: Math.max(safeMargin, window.innerHeight - 104) }
}

function clamp(value, minimum, maximum) { return Math.min(Math.max(value, minimum), Math.max(minimum, maximum)) }

onMounted(() => window.addEventListener('resize', resizeViewport))
onBeforeUnmount(() => { window.removeEventListener('resize', resizeViewport); window.removeEventListener('pointermove', moveDrag) })
</script>

<style scoped>
.assistant-orb{position:fixed;z-index:100;display:grid;place-items:center;width:62px;height:62px;border:0;border-radius:50%;background:#0f766e;color:#fff;box-shadow:0 12px 28px rgba(15,118,110,.32);cursor:grab;touch-action:none;user-select:none}.assistant-orb:active{cursor:grabbing}.assistant-orb span{font-size:10px;font-weight:800;line-height:1;margin-top:-3px}.assistant-panel{position:fixed;z-index:101;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto;overflow:hidden;border:1px solid #d8e2e8;border-radius:8px;background:#fff;box-shadow:0 20px 48px rgba(19,42,61,.24);color:#172b3a}.assistant-header{display:grid;grid-template-columns:minmax(0,1fr) 36px;gap:10px;align-items:center;padding:16px 16px 12px;border-bottom:1px solid #edf1f3}.assistant-heading{display:grid;grid-template-columns:34px minmax(0,1fr);min-width:0;gap:10px;align-items:center}.assistant-heading>div{min-width:0}.assistant-heading strong,.assistant-heading small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.assistant-heading strong{font-size:16px}.assistant-heading small{margin-top:3px;color:#607181;font-size:12px}.assistant-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:8px;background:#e2f5ef;color:#0f766e}.assistant-icon-button{display:grid;place-items:center;flex:0 0 36px;width:36px;height:36px;border:0;border-radius:7px;background:#f1f5f7;color:#385168;cursor:pointer}.assistant-engine{display:flex;align-items:flex-start;gap:7px;padding:9px 16px;background:#edf7f5;color:#17655c;font-size:12px;line-height:1.5}.assistant-engine.fallback{background:#fff7e6;color:#8a5b12}.assistant-engine.cloud{background:#eaf2ff;color:#285f96}.assistant-messages{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:14px;background:#f8fafb}.assistant-message{max-width:94%;margin:0 0 13px;padding:11px 12px;border:1px solid #e1e8ec;border-radius:8px;background:#fff;overflow-wrap:anywhere}.assistant-message.user{margin-left:auto;border-color:#b9ddd6;background:#effaf7}.message-role{display:flex;align-items:center;gap:5px;margin-bottom:7px;color:#527083;font-size:12px;font-weight:700}.assistant-message p{margin:0;white-space:pre-wrap;font-size:14px;line-height:1.65}.message-summary{margin-top:8px!important;color:#506272;font-size:12px!important}.message-suggestions{margin:9px 0 0;padding-left:18px;font-size:13px;line-height:1.55}.citation-list{display:grid;gap:7px;margin-top:10px}.citation-card{display:grid;gap:3px;padding:8px;border-left:3px solid #69a99d;background:#f4f8f8;color:#254154;text-decoration:none;overflow-wrap:anywhere}.citation-card:hover[href]{background:#e8f4f1}.citation-type{display:flex;align-items:center;gap:4px;color:#417668;font-size:11px;font-weight:700}.citation-card b{font-size:12px;line-height:1.4}.citation-card em{color:#607181;font-size:11px;font-style:normal;line-height:1.45}.message-boundary{display:block;margin-top:9px;color:#77848e;font-size:11px;line-height:1.45}.assistant-typing{display:flex;align-items:center;gap:4px;padding:8px;color:#607181;font-size:12px}.assistant-typing span{width:5px;height:5px;border-radius:50%;background:#0f766e;animation:pulse 1.2s infinite}.assistant-typing span:nth-child(2){animation-delay:.15s}.assistant-typing span:nth-child(3){animation-delay:.3s}.assistant-prompts{display:flex;gap:7px;overflow-x:auto;padding:10px 12px;border-top:1px solid #edf1f3;background:#fff}.assistant-prompts button{flex:0 0 auto;border:1px solid #d9e3e8;border-radius:6px;background:#fff;color:#31566e;padding:6px 8px;font-size:12px;cursor:pointer}.assistant-prompts button:disabled,.assistant-composer button:disabled{cursor:not-allowed;opacity:.55}.assistant-composer{display:grid;grid-template-columns:minmax(0,1fr) 40px;gap:9px;padding:11px 12px 13px;border-top:1px solid #edf1f3;background:#fff}.assistant-composer-left{display:grid;gap:7px;min-width:0}.assistant-composer textarea{min-width:0;resize:none;border:1px solid #cbd9df;border-radius:7px;padding:9px 10px;color:#1b3345;font:inherit;font-size:13px;line-height:1.45;outline:none}.assistant-composer textarea:focus{border-color:#0f766e;box-shadow:0 0 0 3px rgba(15,118,110,.11)}.web-search-toggle{display:flex;align-items:center;justify-self:start;gap:5px;border:0;background:transparent;color:#647782;padding:2px 0;font-size:12px;cursor:pointer}.web-search-toggle.active{color:#0f766e;font-weight:700}.assistant-send-button{display:grid;place-items:center;align-self:end;width:40px;height:40px;border:0;border-radius:7px;background:#0f766e;color:#fff;cursor:pointer}@keyframes pulse{50%{opacity:.25;transform:translateY(-2px)}}
</style>
