import fs from 'node:fs/promises'
import path from 'node:path'

const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/embedding-retrieval/contract-retrieval.json')
const outputDirectory = path.resolve(process.cwd(), 'training/legal-embedding/data')
const outputPath = path.join(outputDirectory, 'review-required-pairs.jsonl')
const cases = JSON.parse(await fs.readFile(fixturePath, 'utf8'))
const rows = []
for (const item of cases) {
  for (const source of item.sources) {
    rows.push({
      query: item.query,
      passage: `${source.title}\n${source.excerpt}`,
      label: item.relevant.includes(source.id) ? 1 : 0,
      source: `controlled_fixture:${item.id}`,
      reviewStatus: 'requires_legal_reviewer_confirmation'
    })
  }
}
await fs.mkdir(outputDirectory, { recursive: true })
await fs.writeFile(outputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
console.log(JSON.stringify({ status: 'prepared', file: path.relative(process.cwd(), outputPath), rows: rows.length, requiresHumanReview: true }))
