import fs from 'node:fs/promises'
import path from 'node:path'
import { initializeDatabase } from '../backend/db.js'
import { parseContractDocument } from '../backend/services/document-parser.js'
import { matchStandardClauses, syncStandardClauseLibrary } from '../backend/services/standard-clause-service.js'

const fixtureDirectory = path.resolve(process.cwd(), 'tests/fixtures/external-contracts')
const useCloudReview = process.argv.includes('--deepseek')
if (!useCloudReview) process.env.LOCAL_LLM_MODE = 'disabled'
const fixtures = [
  { fileName: 'dongguan-housing-rental-contract.docx', minScore: 75, maxMissing: 0 },
  { fileName: 'shanghai-affordable-rental-housing-contract.pdf', minScore: 75, maxMissing: 0 },
  { fileName: 'dongguan-market-management-service-contract.docx', minScore: 55, maxMissing: 1 }
]

await initializeDatabase()
await syncStandardClauseLibrary()

const results = []
for (const fixture of fixtures) {
  const buffer = await fs.readFile(path.join(fixtureDirectory, fixture.fileName))
  const parsed = await parseContractDocument({ originalname: fixture.fileName, buffer })
  if (!parsed.text) throw new Error(`${fixture.fileName}: 未提取到测试文本。`)
  const match = await matchStandardClauses({
    sourceFile: fixture.fileName,
    contractType: { predicted: '其他' },
    paragraphStructure: parsed.paragraphs
  }, { allowCloudReview: useCloudReview })
  const passed = match.summary.completenessScore >= fixture.minScore && match.summary.missing <= fixture.maxMissing
  results.push({ fileName: fixture.fileName, parser: parsed.parser, paragraphs: parsed.paragraphs.length, score: match.summary.completenessScore, missing: match.summary.missing, engine: match.engine.status, passed })
}

console.log(JSON.stringify({ cloudReview: useCloudReview, results }, null, 2))
if (results.some((result) => !result.passed)) process.exitCode = 1
