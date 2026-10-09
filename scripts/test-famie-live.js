import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { getFamieStatus } from '../backend/services/famie-service.js'
import { runDocker } from './famie-launch-support.js'

const receipt = { checkedAt: new Date().toISOString(), checks: [], uploadedContracts: 0 }
const check = async (name, run) => { const details = await run(); receipt.checks.push({ name, passed: true, ...details }); console.log('PASS ' + name) }
await check('real FAMIE identity and application status integration', async () => {
  const health = await (await fetch('http://127.0.0.1:9000/api/health')).json()
  assert.equal(health.service, 'famie'); assert.equal(health.status, 'ready')
  assert.equal((await getFamieStatus()).ready, true)
  return { health }
})
await check('container dependencies and non-root runtime', async () => {
  assert.equal((await runDocker(['exec', 'contract-audit-famie', 'pip', 'check'], { timeoutMs: 15000 })).code, 0)
  const uid = await runDocker(['exec', 'contract-audit-famie', 'id', '-u'], { timeoutMs: 5000 })
  assert.equal(uid.output.trim(), '10001')
  const state = await runDocker(['inspect', '--format', '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}}', 'contract-audit-famie'])
  assert.equal(state.output.trim(), 'running healthy 0')
  return { state: state.output.trim(), uid: 10001 }
})
await check('real Edge loads the annotation workspace and local assets', async () => {
  const require = createRequire(import.meta.url)
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage(), errors = [], localFailures = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => { if (response.url().startsWith('http://127.0.0.1:9000/') && response.status() >= 400) localFailures.push({ url: response.url(), status: response.status() }) })
    const response = await page.goto('http://127.0.0.1:9000/', { waitUntil: 'networkidle', timeout: 30000 })
    assert.equal(response.status(), 200)
    const text = await page.locator('body').innerText()
    assert.ok(text.trim().length > 30, 'Rendered workspace must contain actual UI text')
    assert.equal(errors.length, 0); assert.equal(localFailures.length, 0)
    await fs.mkdir('tmp/performance-library-famie', { recursive: true })
    await page.screenshot({ path: 'tmp/performance-library-famie/famie-workspace.png', fullPage: true })
    return { title: await page.title(), renderedText: text.slice(0, 800), pageErrors: errors, localFailures }
  } finally { await browser.close() }
})
if (process.argv.includes('--restart')) await check('restart reuses persistent resources and returns real ready', async () => {
  const start = Date.now()
  assert.equal((await runDocker(['compose', '--profile', 'famie', 'restart', 'famie'], { timeoutMs: 30000 })).code, 0)
  while (Date.now() - start < 90000) {
    if ((await getFamieStatus()).ready) return { elapsedMs: Date.now() - start }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  assert.fail('FAMIE did not regain real readiness after restart')
})
await fs.writeFile('tmp/performance-library-famie/famie-live-results.json', JSON.stringify(receipt, null, 2) + '\n')
