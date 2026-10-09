import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createSealService, sealRoot } from '../services/seal-service.js'

export function createSealRouter(pool,options={}) {
  const router=express.Router(), service=createSealService(pool,options)
  const uploadDir=path.join(options.base||sealRoot,'uploads')
  fs.mkdirSync(uploadDir,{recursive:true})
  const upload=multer({dest:uploadDir,limits:{fileSize:50*1024*1024,files:1,fields:2}})
  const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next)
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next()})
  router.get('/health',route(async(_req,res)=>res.json(await service.health())))
  router.get('/groups',route(async(_req,res)=>res.json(await service.repo.groups())))
  router.post('/groups',route(async(req,res)=>{
    const data={}
    for(const [key,max] of [['label',128],['sealName',255],['companyName',255]]){
      const value=req.body?.[key]
      if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw Object.assign(new Error('请完整填写身份编号、印章名称与单位名称，且不要超过长度限制。'),{status:400})
      data[key]=value.trim()
    }
    res.status(201).json(await service.repo.createGroup(data))
  }))
  router.get('/groups/:id/samples',route(async(req,res)=>res.json(await service.repo.samples(validId(req.params.id)))))
  router.post('/groups/:id/rebuild',route(async(req,res)=>res.status(202).json(await service.rebuild(validId(req.params.id)))))
  for(const [url,purpose] of [['/reference/document','reference'],['/analyze','query']]){
    router.post(url,upload.single('file'),route(async(req,res)=>{
      if(!req.file)throw Object.assign(new Error('请选择文件。'),{status:400})
      try{res.status(202).json(await service.upload(req.file,purpose))}
      finally{await fsp.rm(req.file.path,{force:true})}
    }))
  }
  router.get('/jobs/:id',route(async(req,res)=>res.json(await service.status(req.params.id))))
  router.post('/jobs/:id/selection',route(async(req,res)=>res.status(202).json(await service.select(req.params.id,req.body||{}))))
  router.post('/reference/samples',route(async(req,res)=>res.status(201).json(await service.confirm(req.body?.jobId,req.body||{}))))
  router.post('/samples/:id/disable',route(async(req,res)=>{
    if(req.body?.confirmed!==true)throw Object.assign(new Error('停用样本需要明确确认。'),{status:400})
    await service.repo.deactivate(validId(req.params.id));res.json({status:'disabled'})
  }))
  router.get('/jobs/:id/images/:name',route(async(req,res)=>res.sendFile(await service.asset(req.params.id,req.params.name))))
  router.get('/samples/:id/image',route(async(req,res)=>res.sendFile(await service.sampleAsset(validId(req.params.id)))))
  router.use((error,_req,res,_next)=>{
    const duplicate=error.code==='ER_DUP_ENTRY'
    const status=duplicate?409:error instanceof multer.MulterError?413:error.status||503
    res.status(status).json({error:duplicate?'此身份编号或印章样本已存在；跨身份重复图像不得入库。':
      error instanceof multer.MulterError?'上传超过 50 MB 或文件数量限制，请拆分后上传。':
      error.status?error.message:'印章服务暂不可用，请检查 MySQL、运行 npm run seal:setup 后重试。'})
  })
  return router
}
function validId(value){const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw Object.assign(new Error('无效编号。'),{status:400});return id}
