import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { apiRuntimeArguments } from '../scripts/api-runtime.js'
import { describeStartupError } from '../backend/services/startup-error.js'

test('API launch disables only supported server Web Storage and preserves caller arguments', () => {
  assert.deepEqual(apiRuntimeArguments(['backend/server.js'], new Set()), ['backend/server.js'])
  assert.deepEqual(apiRuntimeArguments(['--trace-warnings', 'backend/server.js'], new Set(['--no-experimental-webstorage'])), ['--no-experimental-webstorage', '--trace-warnings', 'backend/server.js'])
})

test('real docx report import has no localStorage warning with API runtime options', () => {
  const result = spawnSync(process.execPath, apiRuntimeArguments(['--trace-warnings', '--input-type=module', '-e', "await import('./backend/services/report-generator.js'); console.log('report-ready')"]),
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.match(result.stdout, /report-ready/)
  assert.doesNotMatch(result.stderr, /localstorage-file|node:internal\/webstorage/)
})

test('binary-log failure receives a preservation-first recovery message', () => {
  const message = describeStartupError({ code: 'ER_BINLOG_LOGGING_IMPOSSIBLE', message: "Binary logging not possible. An error occurred during flush stage of the commit. 'binlog_error_action' is set to 'ABORT_SERVER'." })
  assert.match(message, /二进制日志/)
  assert.match(message, /Start-Service MySQL/)
  assert.match(message, /不要删除 binlog/)
  assert.match(message, /API 未启动/)
})

test('database connection and authorization failures remain actionable without exposing credentials', () => {
  assert.match(describeStartupError({ code: 'ECONNREFUSED' }), /DB_HOST、DB_PORT/)
  assert.match(describeStartupError({ code: 'ER_ACCESS_DENIED_ERROR', message: 'private credential' }), /账号、密码及授权/)
  assert.doesNotMatch(describeStartupError({ message: 'private credential' }), /private credential/)
})

test('npm server entry exits cleanly with a classified error when MySQL is unreachable', async () => {
  const reservation = net.createServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const unusedPort = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  const result = spawnSync(process.execPath, ['scripts/start-api.js'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(unusedPort), DB_PASSWORD: 'startup-test-secret',
      DEEPSEEK_API_DISABLED: 'true', LOCAL_LLM_MODE: 'disabled', LOCAL_EMBEDDING_MODE: 'disabled' }
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /无法连接 MySQL/)
  assert.match(result.stderr, /DB_HOST、DB_PORT/)
  assert.doesNotMatch(result.stderr, /startup-test-secret|localstorage-file/)
  assert.doesNotMatch(result.stdout, /API listening/)
})
