import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { sealRepository } from './seal-repository.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const sealRoot = path.join(root,'data','seal')
const MAX_AGE = 24*60*60*1000
const errors = {
  docx_converter_unavailable:'DOCX 页面转换器未安装。请将 Word 导出为 PDF 后上传，或配置本地 LibreOffice。',
  docx_conversion_failed:'Word 转 PDF 失败，请在 Word 中导出 PDF 后重试。',
  docx_external_content:'Word 含外部链接图像、嵌入对象或动态内容。为保持本地处理，请先在 Word 中导出 PDF。',
  page_limit:'文件须包含 1–200 页，请拆分后上传。', invalid_docx:'文件不是有效的 DOCX。',
  docx_expansion_limit:'DOCX 展开体积超限，请导出为 PDF。', roi_too_small:'印章区域太小，请重新框选更清晰的区域。',
  invalid_bbox:'框选坐标无效。',pixel_limit:'图像像素超过 4000 万，请缩小后上传。',
  visual_processing_failed:'图像处理失败，请检查文件是否损坏、加密或格式不受支持。',
  worker_timeout:'图像处理超时，请拆分文件或减少页数后重试。', runtime_unavailable:'印章图像运行环境未就绪，请运行 npm run seal:setup。'
}
export function safePath(base, relative) {
  const p = path.resolve(base,relative)
  if (!p.startsWith(path.resolve(base)+path.sep)) throw Object.assign(new Error('无效文件路径。'),{status:400})
  return p
}
export function validateBox(box) {
  if (!box || ['x','y','width','height'].some(k=>typeof box[k]!=='number' || !Number.isFinite(box[k])) ||
      box.x<0 || box.y<0 || box.width<=0 || box.height<=0 || box.x+box.width>1.000001 || box.y+box.height>1.000001)
    throw Object.assign(new Error('请选择有效的印章区域。'),{status:400})
  return Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(box[k].toFixed(6))]))
}
export function repairName(name) {
  const original=String(name||'document')
  const fixed=Buffer.from(original,'latin1').toString('utf8')
  return (/[\u0080-\u00ff]/.test(original) && !fixed.includes('\ufffd') ? fixed : original).slice(0,512)
}
const hash = data => createHash('sha256').update(data).digest('hex')
export const sealPython = () => process.env.SEAL_PYTHON || [path.join(root,'runtime','seal-python','python.exe'),
  path.join(process.env.USERPROFILE||'', '.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe')].find(existsSync) || (process.platform==='win32'?'python':'python3')

export async function runSealWorker(spec, directory, timeout=180000) {
  await fs.mkdir(directory,{recursive:true})
  const token=randomUUID(), input=path.join(directory,`task-${token}.json`), output=path.join(directory,`result-${token}.json`)
  await fs.writeFile(input,JSON.stringify({...spec,resultFile:output}))
  let code
  try {
    code=await new Promise((resolve,reject)=>{
      let child
      try { child=spawn(sealPython(),[path.join(root,'backend','seal','worker.py'),input],{
        cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',PYTHONUTF8:'1'}}) }
      catch {reject(Object.assign(new Error(errors.runtime_unavailable),{code:'runtime_unavailable'}));return}
      let settled=false
      child.stderr.on('data',()=>{}) // Never expose paths or document data in API errors.
      const timer=setTimeout(()=>{child.kill(); if(!settled){settled=true;reject(Object.assign(new Error(errors.worker_timeout),{code:'worker_timeout'}))}},timeout)
      child.on('error',()=>{clearTimeout(timer);if(!settled){settled=true;reject(Object.assign(new Error(errors.runtime_unavailable),{code:'runtime_unavailable'}))}})
      child.on('exit',status=>{clearTimeout(timer);if(!settled){settled=true;resolve(status)}})
    })
    const value=await fs.readFile(output,'utf8').then(JSON.parse).catch(()=>({error:'runtime_unavailable'}))
    if(code!==0 || value.error) throw Object.assign(new Error(errors[value.error]||errors.visual_processing_failed),{code:value.error||'visual_processing_failed'})
    return value
  } finally {await Promise.all([fs.rm(input,{force:true}),fs.rm(output,{force:true})])}
}

export function createSealService(pool, options={}) {
  const base=options.base||sealRoot, repo=sealRepository(pool), jobs=new Map()
  let queue=Promise.resolve(), queued=0, pendingUploads=0
  let healthCache, healthAt=0, healthPending
  const persist=async job=>{const file=path.join(job.directory,'job.json');await fs.writeFile(file+'.tmp',JSON.stringify(job));await fs.rename(file+'.tmp',file)}
  const ready=(async()=>{
    await fs.mkdir(path.join(base,'jobs'),{recursive:true})
    await fs.mkdir(path.join(base,'references'),{recursive:true})
    for(const entry of await fs.readdir(path.join(base,'jobs'),{withFileTypes:true})) {
      if(!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name))continue
      const directory=safePath(path.join(base,'jobs'),entry.name)
      const job=await fs.readFile(path.join(directory,'job.json'),'utf8').then(JSON.parse).catch(()=>null)
      if(!job || Date.now()-job.createdAt>MAX_AGE){await fs.rm(directory,{recursive:true,force:true});continue}
      job.directory=directory
      if(['queued','processing','matching','saving'].includes(job.status)){job.status='failed';job.error='服务重启导致任务中断，请重新上传。';await persist(job)}
      jobs.set(job.id,job)
    }
  })()
  // Expire private temporary pages even when nobody revisits their job URLs.
  const cleanup=setInterval(async()=>{
    try {
      await ready
      for(const [id,job] of jobs)if(Date.now()-job.createdAt>MAX_AGE && !['queued','processing','matching','saving'].includes(job.status)){
        jobs.delete(id);await fs.rm(safePath(path.join(base,'jobs'),id),{recursive:true,force:true})
      }
    } catch { /* A locked file may be retried on restart; never remove reference files. */ }
  },600000)
  cleanup.unref()
  const enqueue=(job,work)=>{
    queued++
    const next=queue.then(work).catch(async error=>{job.status='failed';job.error=error.status ? error.message : (errors[error.code]||'处理未完成，请检查 MySQL 与图像运行环境后重试。');await persist(job)}).finally(()=>{queued--})
    queue=next.catch(()=>{})
  }
  const get=async id=>{
    await ready
    const job=jobs.get(id)
    if(!job)throw Object.assign(new Error('任务不存在，请重新上传。'),{status:404})
    if(Date.now()-job.createdAt>MAX_AGE && !['processing','matching','saving'].includes(job.status)){
      jobs.delete(id);await fs.rm(safePath(path.join(base,'jobs'),id),{recursive:true,force:true})
      throw Object.assign(new Error('任务已过期，请重新上传。'),{status:410})
    }
    return job
  }
  const service={
    repo, ready, dispose(){clearInterval(cleanup)},
    async health(){
      await ready
      if(healthCache && Date.now()-healthAt<30000)return healthCache
      if(!healthPending)healthPending=runSealWorker({action:'health'},path.join(base,'health'),30000).then(value=>{healthCache=value;healthAt=Date.now();return value}).finally(()=>{healthPending=null})
      return healthPending
    },
    async upload(file,purpose){
      await ready
      if(queued+pendingUploads>=4) throw Object.assign(new Error('当前任务较多，请等待完成后再上传。'),{status:429})
      const extension=path.extname(file.originalname).toLowerCase()
      if(!['.pdf','.docx','.png','.jpg','.jpeg','.webp','.bmp','.tif','.tiff'].includes(extension))
        throw Object.assign(new Error('请选择 PDF、DOCX 或常用图片文件。旧 DOC 请先导出 PDF。'),{status:415})
      pendingUploads++
      try {
      const id=randomUUID(),directory=safePath(path.join(base,'jobs'),id)
      await fs.mkdir(directory,{recursive:true})
      const source=path.join(directory,'source'+extension)
      await fs.rename(file.path,source)
      const job={id,directory,source,extension,purpose,fileName:repairName(file.originalname),sourceHash:hash(await fs.readFile(source)),status:'queued',createdAt:Date.now(),pages:[]}
      jobs.set(id,job);await persist(job)
      enqueue(job,async()=>{job.status='processing';await persist(job);const result=await runSealWorker({action:'render',...job},directory,600000);job.pages=result.pages;job.status='ready';await persist(job)})
      return {id,status:'queued'}
      } finally {pendingUploads--}
    },
    async status(id){
      const j=await get(id)
      const progress=await fs.readFile(path.join(j.directory,'progress.json'),'utf8').then(JSON.parse).catch(()=>null)
      return {id:j.id,status:j.status,purpose:j.purpose,fileName:j.fileName,pages:j.pages,progress,error:j.error,
        selection:j.selection,crop:j.crop,result:j.result,savedSample:j.savedSample,rebuildCount:j.rebuildCount,expiresAt:new Date(j.createdAt+MAX_AGE).toISOString()}
    },
    async rebuild(groupId){
      await ready
      if(queued+pendingUploads>=4)throw Object.assign(new Error('当前任务较多，请稍后再试。'),{status:429})
      const group=(await repo.library()).find(g=>Number(g.id)===groupId)
      if(!group)throw Object.assign(new Error('当前身份没有可重建的在用样本。'),{status:422})
      const id=randomUUID(),directory=safePath(path.join(base,'jobs'),id)
      await fs.mkdir(directory,{recursive:true})
      const job={id,directory,purpose:'reference',fileName:'当前身份参考特征重建',status:'queued',pages:[],createdAt:Date.now()}
      jobs.set(id,job);await persist(job)
      enqueue(job,async()=>{
        job.status='processing';await persist(job)
        const samples=group.samples.map(s=>({...s,path:safePath(base,s.path)}))
        const result=await runSealWorker({action:'rebuild',samples},directory)
        await repo.updateFeatures(groupId,result.samples)
        job.rebuildCount=result.samples.length;job.status='done';await persist(job)
      })
      return {id,status:'queued'}
    },
    async select(id,{page,bbox}){
      const job=await get(id)
      if(queued>=4)throw Object.assign(new Error('当前任务较多，请稍后再试。'),{status:429})
      if(!['ready','done','failed'].includes(job.status))throw Object.assign(new Error('请等待页面或当前任务处理完成。'),{status:409})
      if(!Number.isInteger(page)||!job.pages.some(p=>p.page===page))throw Object.assign(new Error('页码无效。'),{status:400})
      const box=validateBox(bbox)
      job.status='matching';job.result=null;job.savedSample=null;job.error=null;job.selection={page,bbox:box};await persist(job)
      enqueue(job,async()=>{
        const cropPath=path.join(job.directory,'crop')
        // Remove stale visualization from a previous selected seal.
        await fs.rm(path.join(cropPath,'matches.png'),{force:true})
        job.crop=await runSealWorker({action:'crop',source:job.source,page,pagePath:path.join(job.directory,`page-${page}.png`),bbox:box,output:cropPath},job.directory)
        if(job.purpose==='query'){
          const groups=await repo.library()
          for(const group of groups)for(const sample of group.samples)sample.path=safePath(base,sample.path)
          job.result=await runSealWorker({action:'match',query:cropPath,groups},job.directory)
        }
        job.status='done';await persist(job)
      })
      return {id,status:job.status}
    },
    async confirm(id,{groupId,confirmed}){
      const job=await get(id)
      if(job.purpose!=='reference'||job.status!=='done'||!job.crop||confirmed!==true)
        throw Object.assign(new Error('请先选择参考印章，并明确确认印章身份。'),{status:400})
      if(!Number.isSafeInteger(groupId)||groupId<1)throw Object.assign(new Error('请选择印章身份。'),{status:400})
      if(job.crop.featureCount<30||job.crop.qualityScore<30)throw Object.assign(new Error('此样本过于模糊或特征不足，请补充清晰参考。'),{status:422})
      job.status='saving';await persist(job)
      const rel=path.join('references',randomUUID()), target=safePath(base,rel)
      let committed=false
      try {
        await fs.cp(path.join(job.directory,'crop'),target,{recursive:true})
        await fs.copyFile(job.source,path.join(target,'source'+job.extension))
        const saved=await repo.insertSample({groupId,fileName:job.fileName,sourceHash:job.sourceHash,
          sourcePath:path.join(rel,'source'+job.extension),imagePath:rel,page:job.selection.page,bbox:job.selection.bbox,
          roiHash:hash(JSON.stringify(job.selection.bbox)),...job.crop})
        committed=true;job.savedSample=saved;job.status='done';await persist(job);return saved
      } catch(error){if(!committed)await fs.rm(target,{recursive:true,force:true});job.status='done';await persist(job);throw error}
    },
    async asset(id,name){
      const job=await get(id)
      if(!/^page-\d+\.png$/.test(name)&&!['original.png','red-mask.png','gray.png','matches.png'].includes(name))throw Object.assign(new Error('图像不存在。'),{status:404})
      return path.join(job.directory,name.startsWith('page-')?name:path.join('crop',name))
    },
    async sampleAsset(id){const sample=await repo.sample(id);if(!sample)throw Object.assign(new Error('样本不存在。'),{status:404});return safePath(base,path.join(sample.image_path,'original.png'))}
  }
  return service
}
