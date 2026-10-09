import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createDatabaseBackup, backupTables } from './mysql-backup-service.js'

export const externalRoots = ['data', 'match', 'matchreal', 'models']
export async function fileHash(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export function contained(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Unsafe backup path')
  const result = path.resolve(root, relative)
  if (!result.startsWith(path.resolve(root) + path.sep)) throw Error('Unsafe backup path')
  return result
}
async function walk(root, relative = '') {
  const items = []
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw Error('Backup refuses symbolic links: ' + name)
    if (entry.isDirectory()) items.push(...await walk(root, name))
    else if (entry.isFile() && !entry.name.endsWith('.tmp') && entry.name !== 'ocr.lock') items.push(name)
  }
  return items
}
export async function createFullBackup({ root = process.cwd(), destination, databasePool, roots = externalRoots, extraFiles = [] }) {
  if (!destination) throw Error('Backup destination required')
  await fs.mkdir(destination, { recursive: false })
  const manifest = { version: 1, status: 'incomplete', createdAt: new Date().toISOString(), tables: backupTables, roots, absentRoots: [], files: [],
    consistency: 'MySQL consistent snapshot; external files individually stable copies. OCR checkpoints can represent different page completion times.',
    excluded: ['.env and API keys', 'runtime binaries and dependencies', 'temporary .tmp files and OCR locks', 'Docker MySQL volume (replaced by SQL snapshot)'] }
  try {
    const requiredFiles = new Set()
    const sql = await createDatabaseBackup({ databasePool, onRow: (table,row)=>{
      if(table==='seal_reference_sample') {
        for(const relative of [row.source_path,path.join(row.image_path,'original.png')]) {
          const safe=contained(path.resolve(root,'data/seal'),relative)
          requiredFiles.add(path.join('files','data','seal',path.relative(path.resolve(root,'data/seal'),safe)).split(path.sep).join('/'))
        }
      }
    } })
    manifest.tables = [...sql.matchAll(/^CREATE TABLE IF NOT EXISTS `([^`]+)`/gm)].map(match=>match[1])
    manifest.absentTables = backupTables.filter(table=>!manifest.tables.includes(table))
    manifest.famieArchiveIncluded = extraFiles.some(item=>item.relative==='docker/famie-data.tar')
    await fs.writeFile(path.join(destination, 'database.sql'), sql, 'utf8')
    manifest.files.push({ path: 'database.sql', sha256: await fileHash(path.join(destination,'database.sql')), bytes: Buffer.byteLength(sql) })
    const inputs = []
    for (const folder of roots) {
      const source = contained(root, folder)
      try { await fs.access(source) } catch { manifest.absentRoots.push(folder); continue }
      for (const relative of await walk(source)) inputs.push({ source: contained(source,relative), relative: path.join(folder,relative) })
    }
    inputs.push(...extraFiles)
    for (const input of inputs) {
      const relative = path.join('files',input.relative)
      const target = contained(destination,relative)
      await fs.mkdir(path.dirname(target),{recursive:true})
      let copied = false
      for (let attempt=0;attempt<3;attempt++) {
        const before = await fs.stat(input.source)
        await fs.copyFile(input.source,target)
        const after = await fs.stat(input.source)
        if (before.size===after.size && before.mtimeMs===after.mtimeMs) {copied=true;break}
      }
      if (!copied) throw Error('File kept changing during backup: '+input.relative)
      manifest.files.push({path:relative.split(path.sep).join('/'),sha256:await fileHash(target),bytes:(await fs.stat(target)).size})
    }
    const copiedPaths = new Set(manifest.files.map(item=>item.path))
    for(const required of requiredFiles)if(!copiedPaths.has(required))throw Error('Database-referenced seal file is missing: '+required)
    manifest.requiredFiles=[...requiredFiles]
    manifest.status='complete'
    await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2))
    await verifyFullBackup(destination)
    return manifest
  } catch(error) {
    manifest.status='incomplete'
    await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2))
    throw error
  }
}
export async function verifyFullBackup(directory) {
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'))
  if(manifest.version!==1 || manifest.status!=='complete')throw Error('Incomplete backup')
  const seen=new Set()
  for(const item of manifest.files) {
    if(seen.has(item.path))throw Error('Duplicate backup entry')
    seen.add(item.path)
    const file=contained(directory,item.path)
    if((await fs.lstat(file)).isSymbolicLink())throw Error('Symlink backup entry')
    const realRoot=await fs.realpath(directory), realFile=await fs.realpath(file)
    if(!realFile.startsWith(realRoot+path.sep))throw Error('Backup entry escapes directory')
    if((await fs.stat(file)).size!==item.bytes || await fileHash(file)!==item.sha256)throw Error('Backup checksum mismatch: '+item.path)
  }
  if(!seen.has('database.sql'))throw Error('SQL snapshot missing')
  return manifest
}
export async function restoreExternalFiles(directory, destination) {
  const manifest=await verifyFullBackup(directory)
  // Never overwrite an existing project. Restore into a new review directory.
  await fs.mkdir(destination,{recursive:false})
  for(const item of manifest.files.filter(f=>f.path.startsWith('files/'))) {
    const target=contained(destination,item.path.slice(6))
    await fs.mkdir(path.dirname(target),{recursive:true})
    await fs.copyFile(contained(directory,item.path),target)
    if(await fileHash(target)!==item.sha256)throw Error('Restore checksum mismatch')
  }
  return manifest
}
