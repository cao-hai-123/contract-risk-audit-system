import 'dotenv/config'
import { spawn } from 'node:child_process'
import { sealPython } from '../backend/services/seal-service.js'
const child=spawn(sealPython(),['scripts/ocr-real-contract-corpus.py',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true})
child.once('error',error=>{console.error('OCR runtime unavailable:',error.code);process.exitCode=1})
child.once('exit',code=>{process.exitCode=code??1})
