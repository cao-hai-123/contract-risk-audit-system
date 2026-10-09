import fs from 'node:fs/promises'
import path from 'node:path'

const inputPath = path.resolve(process.cwd(), 'training/legal-embedding/data/review-required-pairs.jsonl')
const lines = (await fs.readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean)
const rows = lines.map((line, index) => {
  try { return JSON.parse(line) } catch { throw new Error(`第 ${index + 1} 行不是合法 JSONL。`) }
})
const invalid = rows.filter((row) => !row.query || !row.passage || ![0, 1].includes(row.label) || row.reviewStatus !== 'requires_legal_reviewer_confirmation')
const positives = rows.filter((row) => row.label === 1).length
const negatives = rows.filter((row) => row.label === 0).length
if (invalid.length || !positives || !negatives) throw new Error('训练数据必须同时包含人工待复核的正负样本，且字段完整。')
console.log(JSON.stringify({ status: 'passed', rows: rows.length, positives, negatives, promotionAllowed: false, reason: '尚未完成法律专家标签复核和独立评测。' }))
