import fs from 'node:fs/promises'
import path from 'node:path'
import { initializeDatabase, pool, saveEmbeddingEvaluationRun } from '../backend/db.js'
import { rankSourcesBySemanticSimilarity } from '../backend/services/semantic-retrieval-service.js'

const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/embedding-retrieval/contract-retrieval.json')
const cases = JSON.parse(await fs.readFile(fixturePath, 'utf8'))
await initializeDatabase()

let reciprocalRank = 0
let recallAt3 = 0
let evaluatedModel = null
for (const item of cases) {
  const result = await rankSourcesBySemanticSimilarity({ question: item.query, sources: item.sources })
  if (result.status !== 'ready') throw new Error(`嵌入检索未就绪：${result.message || result.status}`)
  const ranked = [...item.sources].sort((left, right) => (result.scores.get(right.id) || -1) - (result.scores.get(left.id) || -1))
  const firstRelevant = ranked.findIndex((source) => item.relevant.includes(source.id))
  if (firstRelevant >= 0) reciprocalRank += 1 / (firstRelevant + 1)
  if (ranked.slice(0, 3).some((source) => item.relevant.includes(source.id))) recallAt3 += 1
  evaluatedModel ||= await import('../backend/services/embedded-embedding-service.js').then(async ({ getEmbeddedEmbeddingStatus }) => getEmbeddedEmbeddingStatus())
}

const metrics = { caseCount: cases.length, mrr: Number((reciprocalRank / cases.length).toFixed(4)), recallAt3: Number((recallAt3 / cases.length).toFixed(4)) }
if (metrics.recallAt3 < 1) throw new Error(`专用向量模型未通过受控检索回归集：Recall@3=${metrics.recallAt3}`)
await saveEmbeddingEvaluationRun({ modelName: evaluatedModel.model, modelVersion: evaluatedModel.modelVersion, dimension: evaluatedModel.dimensions, datasetName: 'contract-retrieval-fixture-v1', metrics, notes: '仅使用脱敏的受控合同检索样例；不代表法律结论。' })
console.log(JSON.stringify({ status: 'passed', metrics }))
await pool.end()
