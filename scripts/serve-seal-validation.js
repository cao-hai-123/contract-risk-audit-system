// Development-only local validation host, sharing the business MySQL reference tables.
import express from 'express'
import path from 'node:path'
import {pool} from '../backend/db.js'
import {sealSchema} from '../backend/services/seal-repository.js'
import {createSealRouter} from '../backend/routes/seal.js'
for(const sql of sealSchema)await pool.query(sql)
const app=express();app.use(express.json());app.use('/api/seal',createSealRouter(pool));app.use(express.static(path.resolve('dist')))
const server=app.listen(3012,'127.0.0.1',()=>console.log('Seal validation UI http://127.0.0.1:3012'))
process.once('SIGINT',()=>server.close(()=>pool.end().finally(()=>process.exit(0))))
process.once('SIGTERM',()=>server.close(()=>pool.end().finally(()=>process.exit(0))))
