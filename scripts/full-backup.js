import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createFullBackup,verifyFullBackup,restoreExternalFiles } from '../backend/services/full-backup-service.js'
import { pool } from '../backend/db.js'
const exec=promisify(execFile)
const mode=process.argv[2]||'create'
try {
  if(mode==='verify') {const m=await verifyFullBackup(path.resolve(process.argv[3]));console.log(JSON.stringify({status:'verified',files:m.files.length}));}
  else if(mode==='restore-files') {const m=await restoreExternalFiles(path.resolve(process.argv[3]),path.resolve(process.argv[4]));console.log(JSON.stringify({status:'restored',files:m.files.length}));}
  else if(mode==='create') {
    const base=path.resolve('backups');await fs.mkdir(base,{recursive:true})
    const destination=path.join(base,new Date().toISOString().replace(/[:.]/g,'-'))
    const extraFiles=[]
    // FAMIE stores annotations in a Docker volume, outside the project tree.
    if(!['0','false','off'].includes(String(process.env.FAMIE_ENABLED||'true').toLowerCase())) {
      const {stdout}=await exec('docker',['inspect','--format','{{json .State}}','contract-audit-famie'],{windowsHide:true})
      const state=JSON.parse(stdout);const archive=path.join(base,'famie-'+Date.now()+'.tar')
      let paused=false
      try {
        if(state.Running&&!state.Paused){await exec('docker',['pause','contract-audit-famie'],{windowsHide:true});paused=true}
        // docker cp produces an archive on stdout; stream bytes without shell conversion.
        const {spawn}=await import('node:child_process');const {createWriteStream}=await import('node:fs');const {pipeline}=await import('node:stream/promises')
        const child=spawn('docker',['cp','contract-audit-famie:/home/famie/.famie','-'],{windowsHide:true,stdio:['ignore','pipe','pipe']})
        const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('FAMIE archive failed')))})
        child.stderr.resume();await Promise.all([pipeline(child.stdout,createWriteStream(archive,{flags:'wx'})),done])
        extraFiles.push({source:archive,relative:'docker/famie-data.tar'})
      } finally {if(paused)await exec('docker',['unpause','contract-audit-famie'],{windowsHide:true})}
    }
    const m=await createFullBackup({destination,extraFiles})
    console.log(JSON.stringify({status:m.status,destination,files:m.files.length,bytes:m.files.reduce((n,f)=>n+f.bytes,0),absentRoots:m.absentRoots}))
    for(const item of extraFiles)await fs.unlink(item.source)
  } else throw Error('Use create, verify <directory>, or restore-files <backup> <new-directory>')
} finally {await pool.end()}
