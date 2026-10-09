import net from 'node:net'
import { spawn } from 'node:child_process'
import 'dotenv/config'
import { apiRuntimeArguments } from './api-runtime.js'
import { getLocalModelConfig } from '../backend/services/local-model-config.js'

const apiPort = Number(process.env.PORT || 3001)
const uiPort = Number(process.env.VITE_PORT || 5173)
const children = []
let isStopping = false

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (isListening) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(isListening)
    }

    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(600, () => finish(false))
  })
}

function startProcess(label, args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true })
  children.push(child)

  child.once('error', (error) => {
    console.error(`${label} could not start (${error.code || 'spawn_failed'}).`)
    stopAll(1)
  })

  child.once('exit', (code, signal) => {
    if (!isStopping) {
      console.error(`${label} exited unexpectedly (${signal || `code ${code}`}).`)
      stopAll(code || 1)
    }
  })
}

function stopAll(exitCode = 0) {
  if (isStopping) return
  isStopping = true
  children.forEach((child) => child.kill())
  process.exit(exitCode)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopAll())
}

async function checkApi() {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(2500) })
  if (!response.ok) throw new Error('API/MySQL 健康检查失败。')
  const health = await response.json()
  if (health.service !== 'contract-intelligent-parser') throw new Error('API 端口被其他服务占用。')
  const model = getLocalModelConfig()
  if (model.mode === 'embedded' && health.localModel?.model !== model.model) throw new Error('API 仍在使用旧模型配置。请先停止原来的 npm run dev 后重新启动。')
}

try {
  if (await isPortListening(apiPort)) {
    await checkApi()
    console.log(`Reusing verified contract API on ${apiPort}.`)
  } else {
    if (await isPortListening(uiPort)) throw new Error('前端端口已被占用，但合同 API 未启动。请关闭原开发服务后重试。')
    startProcess('Contract parser API', apiRuntimeArguments(['backend/server.js']))
    const deadline = Date.now() + 180000
    while (true) {
      try { await checkApi(); break } catch (error) { if (Date.now() >= deadline) throw error }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  if (await isPortListening(uiPort)) {
    const response = await fetch(`http://127.0.0.1:${uiPort}/api/health`, { signal: AbortSignal.timeout(2500) })
    if (!response.ok || (await response.json()).service !== 'contract-intelligent-parser') throw new Error('前端端口被其他服务占用。')
    console.log(`项目已运行：http://127.0.0.1:${uiPort}/。无需重复启动；更新后请先停止原开发服务。`)
  } else {
    startProcess('Vite development server', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort'])
  }
} catch (error) {
  console.error('Development startup failed:', error.message)
  stopAll(1)
}
