import 'dotenv/config'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import mysql from 'mysql2/promise'
import assert from 'node:assert/strict'
import { verifyFullBackup } from '../backend/services/full-backup-service.js'
import { pool } from '../backend/db.js'
const directory=path.resolve(process.argv[2]||'')
const name=process.argv[3]||'contract_restore_'+Date.now()
if(!/^contract_restore_[a-zA-Z0-9_]+$/.test(name))throw Error('Restore only into a new contract_restore_* database')
const quote='`'+name+'`'
let connection,created=false
const receipt={database:name,status:'failed',tables:{}}
try {
 await verifyFullBackup(directory)
 connection=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',charset:'utf8mb4'})
 await connection.query('CREATE DATABASE '+quote+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');created=true
 await connection.query('USE '+quote)
 let statement='';const expected=new Map()
 for await(const line of readline.createInterface({input:fs.createReadStream(path.join(directory,'database.sql'),{encoding:'utf8'}),crlfDelay:Infinity})){
  if(!statement&&(!line.trim()||line.startsWith('--')))continue
  statement+=line+'\n'
  if(line.trimEnd().endsWith(';')){
   const table=statement.match(/^CREATE TABLE IF NOT EXISTS `([^`]+)`/);if(table)expected.set(table[1],0)
   const row=statement.match(/^INSERT INTO `([^`]+)`/);if(row)expected.set(row[1],(expected.get(row[1])||0)+1)
   await connection.query(statement);statement=''
  }
 }
 assert.equal(statement.trim(),'','Unterminated SQL statement')
 for(const [table,count]of expected){assert.match(table,/^[a-z_]+$/);const [rows]=await connection.query('SELECT COUNT(*) n FROM `'+table+'`');assert.equal(Number(rows[0].n),count);receipt.tables[table]=count}
 receipt.status='passed'
}finally{
 if(connection){if(created&&process.argv.includes('--verify-then-drop')){await connection.query('DROP DATABASE '+quote);receipt.testDatabaseRemoved=true}await connection.end()}
 await pool.end();await fsp.mkdir('tmp/backup-retrieval',{recursive:true});await fsp.writeFile('tmp/backup-retrieval/database-restore.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt))
}
