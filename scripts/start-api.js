import { spawn } from 'node:child_process'
import { apiRuntimeArguments } from './api-runtime.js'

const child = spawn(process.execPath, apiRuntimeArguments(), { stdio: 'inherit', windowsHide: true })
child.once('error', (error) => {
  console.error('Contract parser API could not start:', error.code || 'spawn_failed')
  process.exitCode = 1
})
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
