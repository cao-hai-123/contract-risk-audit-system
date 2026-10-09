import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'

async function server(body) {
  const service = http.createServer((_req, response) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)))
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve))
  return { instance: service, port: service.address().port, close: () => new Promise((resolve) => service.close(resolve)) }
}

async function runDev(apiPort, uiPort, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/dev.js'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(apiPort), VITE_PORT: String(uiPort), LOCAL_LLM_MODE: 'embedded',
        LOCAL_LLM_MODEL: 'Qwen3-8B-Q4_K_M', ...overrides } })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('Development launcher did not terminate')) }, 10000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data })
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }) })
  })
}

test('dev refuses an unrelated service on the API port without starting Vite', async () => {
  const api = await server({ service: 'unrelated' }), ui = await server({})
  try {
    const result = await runDev(api.port, ui.port)
    assert.equal(result.code, 1); assert.match(result.output, /其他服务占用/)
    assert.doesNotMatch(result.output, /VITE v|API listening/)
    assert.equal((await fetch('http://127.0.0.1:' + api.port)).status, 200)
  } finally { await api.close(); await ui.close() }
})

test('dev refuses to reuse a still-running old-model API', async () => {
  const api = await server({ service: 'contract-intelligent-parser', localModel: { model: 'Qwen3-4B-Q4_K_M' } }), ui = await server({})
  try {
    const result = await runDev(api.port, ui.port)
    assert.equal(result.code, 1); assert.match(result.output, /旧模型配置/)
    assert.equal((await fetch('http://127.0.0.1:' + api.port)).status, 200)
  } finally { await api.close(); await ui.close() }
})

test('dev reuses verified API/frontend without drifting to another port', async () => {
  const health = { service: 'contract-intelligent-parser', localModel: { model: 'Qwen3-8B-Q4_K_M' } }
  const api = await server(health), ui = await server(health)
  try {
    const result = await runDev(api.port, ui.port)
    assert.equal(result.code, 0); assert.match(result.output, /项目已运行/)
    assert.doesNotMatch(result.output, /VITE v|API listening/)
  } finally { await api.close(); await ui.close() }
})
