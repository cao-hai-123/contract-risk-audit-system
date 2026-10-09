import 'dotenv/config'
import { getLocalModelConfig, probeGenerationModel } from '../backend/services/local-model-config.js'
const config = getLocalModelConfig()
const baseUrl = config.baseUrl
if (await probeGenerationModel(config) !== 'ready') throw new Error('Configured model identity or health mismatch')

const health = await fetch(`${baseUrl}/health`)
if (!health.ok) throw new Error(`Embedded model health check failed: HTTP ${health.status}`)

const completion = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: config.model,
    temperature: 0,
    max_tokens: 80,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: '仅输出 JSON，不输出推理过程。/no_think' },
      { role: 'user', content: '请输出 {"status":"ok","language":"zh"}。' }
    ]
  })
})
if (!completion.ok) throw new Error(`Embedded model completion failed: HTTP ${completion.status}`)

const payload = await completion.json()
const content = payload.choices?.[0]?.message?.content || ''
const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}')
if (parsed.status !== 'ok' || parsed.language !== 'zh') throw new Error('Embedded model returned an unexpected verification payload.')

console.log('Embedded local model self-test passed: health and Chinese JSON completion are available.')
