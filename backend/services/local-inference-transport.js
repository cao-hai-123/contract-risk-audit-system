import { requestJson, classifyModelError } from './model-review-protocol.js'
import { getLocalModelConfig } from './local-model-config.js'

// One CPU inference slot: serialize local callers instead of timing out inside llama.cpp.
let tail = Promise.resolve()
let pending = 0
const recent = []
export const getLocalInferenceDiagnostics = () => ({ pending, recent: recent.map((item) => ({ ...item })) })

export async function requestLocalJson(input) {
  if (pending >= 12) throw Object.assign(new Error('Local inference queue full'), { httpStatus: 429 })
  const queuedAt = Date.now()
  const previous = tail
  let release
  tail = new Promise((resolve) => { release = resolve })
  pending++
  await previous
  const config = getLocalModelConfig()
  const receipt = { task: input.task || 'review', startedAt: new Date().toISOString(), queueMs: Date.now() - queuedAt, model: config.model }
  const start = Date.now()
  try {
    if (receipt.queueMs >= config.reviewBudgetMs) throw new DOMException('Queue timeout', 'TimeoutError')
    const result = await requestJson({ ...input, endpoint: config.baseUrl + '/v1/chat/completions', key: undefined,
      model: config.model, timeoutMs: input.timeoutMs || config.requestTimeoutMs })
    receipt.status = 'success'
    return result
  } catch (error) {
    receipt.status = classifyModelError(error)
    throw error
  } finally {
    receipt.elapsedMs = Date.now() - start
    recent.push(receipt)
    if (recent.length > 30) recent.shift()
    pending--
    release()
    console.info('[local-inference]', JSON.stringify(receipt))
  }
}
