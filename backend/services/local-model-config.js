import path from 'node:path'

const integer = (value, fallback, min, max) => {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

export function getLocalModelConfig(env = process.env) {
  const port = integer(env.LOCAL_LLM_PORT, 11435, 1, 65535)
  const model = env.LOCAL_LLM_MODEL || 'Qwen3-8B-Q4_K_M'
  return {
    mode: env.LOCAL_LLM_MODE || 'disabled', port, model,
    provider: '本地 ' + model.replace(/-Q\d[^/]*$/i, ''),
    baseUrl: String(env.LOCAL_LLM_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    serverPath: path.resolve(env.LOCAL_LLM_SERVER_PATH || 'runtime/llama.cpp/llama-server.exe'),
    modelPath: path.resolve(env.LOCAL_LLM_MODEL_PATH || 'models/Qwen3-8B-Q4_K_M.gguf'),
    contextSize: integer(env.LOCAL_LLM_CONTEXT_SIZE, 8192, 2048, 32768),
    gpuLayers: integer(env.LOCAL_LLM_GPU_LAYERS, 0, 0, 999),
    threads: integer(env.LOCAL_LLM_THREADS, 16, 1, 64),
    batchThreads: integer(env.LOCAL_LLM_BATCH_THREADS, 28, 1, 64),
    requestTimeoutMs: integer(env.LOCAL_LLM_REQUEST_TIMEOUT_MS, 120000, 1000, 300000),
    reviewBudgetMs: integer(env.LOCAL_LLM_REVIEW_BUDGET_MS, 300000, 1000, 600000)
  }
}

export const getLocalModelProvider = () => getLocalModelConfig().provider

export function generationArguments(config) {
  return ['-m', config.modelPath, '--alias', config.model, '--host', '127.0.0.1', '--port', String(config.port),
    '-c', String(config.contextSize), '-ngl', String(config.gpuLayers), '-t', String(config.threads),
    '-tb', String(config.batchThreads), '-np', '1', '-ub', '256', '--reasoning', 'off']
}

export async function probeGenerationModel(config, fetchImpl = fetch) {
  try {
    const health = await fetchImpl(config.baseUrl + '/health', { signal: AbortSignal.timeout(1500) })
    if (!health.ok) return 'unavailable'
    const response = await fetchImpl(config.baseUrl + '/v1/models', { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return 'model_mismatch'
    const payload = await response.json()
    const expected = new Set([config.model, path.basename(config.modelPath)])
    return payload.data?.some((item) => expected.has(String(item.id).split(/[\\/]/).at(-1))) ? 'ready' : 'model_mismatch'
  } catch { return 'unavailable' }
}
