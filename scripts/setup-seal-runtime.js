import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const bundled=path.join(process.env.USERPROFILE||'','.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe')
const python=process.env.SEAL_PYTHON||(existsSync(bundled)?bundled:process.platform==='win32'?'python':'python3')
const r=spawnSync(python,['-m','pip','install','--no-compile','--target',path.join(root,'runtime','seal'),'--upgrade','-r',path.join(root,'backend','seal','requirements.txt')],{stdio:'inherit',windowsHide:true})
if(r.error||r.status!==0){console.error('印章依赖安装失败。请配置 SEAL_PYTHON 指向 Python 3.10–3.12，并检查网络与内存。');process.exit(1)}
const {runSealWorker}=await import('../backend/services/seal-service.js')
console.log(await runSealWorker({action:'health'},path.join(root,'data','seal','health')))
