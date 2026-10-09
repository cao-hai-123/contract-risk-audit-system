import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const projectRoot = process.cwd()
const defaultPort = 11436
let serverProcess = null
let startPromise = null
let lastServerOutput = ''
let status = {
  mode: 'disabled',
  state: 'disabled',
  provider: '未启用专用向量模型',
  model: '',
  modelVersion: '',
  dimensions: 0,
  endpoint: '',
  message: '专用向量模型未启用。'
}

export async function ensureEmbeddedEmbeddingServer() {
  const config = getConfig()
  status = buildBaseStatus(config)
  if (config.mode !== 'embedded') return status
  if (await isHealthy(config.baseUrl)) {
    status = { ...buildBaseStatus(config), state: 'ready', message: '项目托管的专用向量模型服务已就绪。' }
    return status
  }
  if (startPromise) return startPromise
  startPromise = startServer(config)
  try { return await startPromise } finally { startPromise = null }
}

export function getEmbeddedEmbeddingStatus() {
  return { ...status }
}

export async function stopEmbeddedEmbeddingServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return
  const processToStop = serverProcess
  serverProcess = null
  processToStop.kill()
}

async function startServer(config) {
  try {
    await fs.access(config.serverPath)
    await fs.access(config.modelPath)
  } catch {
    status = { ...buildBaseStatus(config), state: 'unavailable', message: '专用向量模型运行时或模型文件不存在。请运行 npm run embedding-model:setup 完成项目内部署。' }
    return status
  }

  status = { ...buildBaseStatus(config), state: 'starting', message: '正在加载项目托管的专用向量模型。' }
  const args = ['-m', config.modelPath, '--alias', config.model, '--host', '127.0.0.1', '--port', String(config.port), '-c', String(config.contextSize), '-ngl', String(config.gpuLayers), '-t', String(config.threads), '-np', '1', '--embedding', '--pooling', 'last', '-ub', String(config.batchSize)]
  serverProcess = spawn(config.serverPath, args, { cwd: path.dirname(config.serverPath), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const captureServerOutput = (chunk) => { lastServerOutput = `${lastServerOutput}${String(chunk || '')}`.slice(-1200) }
  serverProcess.stdout.on('data', captureServerOutput)
  serverProcess.stderr.on('data', captureServerOutput)
  serverProcess.on('error', (error) => { status = { ...buildBaseStatus(config), state: 'unavailable', message: `专用向量模型服务无法启动：${error.message}` } })
  const startedPid = serverProcess.pid
  serverProcess.on('exit', (code) => {
    if (serverProcess?.pid === startedPid && status.state !== 'disabled') {
      const detail = lastServerOutput.trim().split(/\r?\n/).slice(-1)[0]
      status = { ...buildBaseStatus(config), state: 'stopped', message: `专用向量模型服务已退出（代码 ${code ?? '未知'}）。${detail ? ` ${detail}` : ''}` }
    }
  })

  const ready = await waitForHealth(config.baseUrl, 90000)
  if (!ready) {
    const detail = lastServerOutput.trim().split(/\r?\n/).slice(-1)[0]
    status = { ...buildBaseStatus(config), state: 'unavailable', message: `专用向量模型服务启动超时。${detail ? ` ${detail}` : ''}` }
    return status
  }
  status = { ...buildBaseStatus(config), state: 'ready', message: '项目托管的专用向量模型服务已就绪。' }
  return status
}

function getConfig() {
  const mode = process.env.LOCAL_EMBEDDING_MODE || 'embedded'
  const port = Number(process.env.LOCAL_EMBEDDING_PORT || defaultPort)
  const baseUrl = String(process.env.LOCAL_EMBEDDING_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '')
  return {
    mode,
    port,
    baseUrl,
    serverPath: resolveProjectPath(process.env.LOCAL_EMBEDDING_SERVER_PATH || 'runtime/llama.cpp/llama-server.exe'),
    modelPath: resolveProjectPath(process.env.LOCAL_EMBEDDING_MODEL_PATH || 'models/Qwen3-Embedding-0.6B-Q8_0.gguf'),
    model: process.env.LOCAL_EMBEDDING_MODEL || 'Qwen3-Embedding-0.6B-Q8_0',
    modelVersion: process.env.LOCAL_EMBEDDING_MODEL_VERSION || 'Qwen3-Embedding-0.6B-GGUF-Q8_0',
    dimensions: Math.max(32, Number(process.env.LOCAL_EMBEDDING_DIMENSIONS || 1024)),
    contextSize: Math.max(2048, Number(process.env.LOCAL_EMBEDDING_CONTEXT_SIZE || 8192)),
    gpuLayers: Math.max(0, Number(process.env.LOCAL_EMBEDDING_GPU_LAYERS || 0)),
    threads: Math.max(1, Number(process.env.LOCAL_EMBEDDING_THREADS || 4)),
    batchSize: Math.max(256, Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE || 2048))
  }
}

function buildBaseStatus(config) {
  return {
    mode: config.mode,
    state: config.mode === 'embedded' ? 'starting' : 'disabled',
    provider: config.mode === 'embedded' ? '本地 Qwen3-Embedding-0.6B' : '未启用专用向量模型',
    model: config.model,
    modelVersion: config.modelVersion,
    dimensions: config.dimensions,
    endpoint: config.baseUrl,
    message: config.mode === 'embedded' ? '专用向量模型等待启动。' : '专用向量模型未启用。'
  }
}

function resolveProjectPath(value) { return path.isAbsolute(value) ? value : path.resolve(projectRoot, value) }

async function isHealthy(baseUrl) {
  try { return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
}

async function waitForHealth(baseUrl, timeout) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await isHealthy(baseUrl)) return true
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  return false
}
