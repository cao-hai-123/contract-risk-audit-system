import { analyzeContractWithDeepSeek } from './deepseek-client.js'
import { ensureEmbeddedModelServer } from './embedded-llm-service.js'
import { requestLocalJson } from './local-inference-transport.js'
import { getLocalModelConfig } from './local-model-config.js'

export async function analyzeContract(input, dependencies = {}) {
  const config = getLocalModelConfig()
  const current = await (dependencies.ensureLocal || ensureEmbeddedModelServer)()
  let local
  if (current.state === 'ready') {
    // Reuse the same extraction validation, paragraph preservation and confidence calculation.
    local = await analyzeContractWithDeepSeek({ ...input, dependencies: {
      apiKey: 'local-only', chunkChars: 3200, timeBudgetMs: config.reviewBudgetMs, requestTimeoutMs: config.requestTimeoutMs,
      request: (request) => (dependencies.localRequest || requestLocalJson)({ ...request, task: 'parse', key: undefined,
        system: request.system + ' /no_think', maxTokens: 1400 })
    } })
    local.ai = { ...local.ai, provider: local.ai.used ? config.provider : '本地规则解析', model: local.ai.used ? config.model : 'local-rules',
      requestedProvider: config.provider, requestedModel: config.model, trackingId: undefined }
  }
  const cloud = await (dependencies.cloudAnalyze || analyzeContractWithDeepSeek)(input)
  const localStage = { status: local?.ai.status || current.state, used: Boolean(local?.ai.used), model: config.model, coverage: local?.ai.coverage }
  const stages = { local: localStage, cloud: { status: cloud.ai.status, used: Boolean(cloud.ai.used), model: cloud.ai.model } }
  const result = cloud.ai.used ? cloud : local?.ai.used ? local : cloud
  result.ai = { ...result.ai, stages,
    provider: cloud.ai.used && localStage.used ? config.provider + ' + DeepSeek' : result.ai.provider,
    message: `本地 Qwen：${localStage.status}；DeepSeek：${stages.cloud.status}。` +
      (cloud.ai.used ? '采用云端分析结果；本地结果已独立抽取。' : localStage.used ? '云端未完成，采用本地 Qwen 分析结果，请核对关键要素。' : '模型未完成有效分析，保留本地规则结果。') }
  return result
}
