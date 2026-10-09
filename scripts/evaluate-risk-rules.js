import { existsSync } from 'node:fs'
import path from 'node:path'

const datasetRoot = path.resolve('datasets/archive')
const requiredArchives = ['cuad-main.zip', 'LeCaRD-main.zip']
const missing = requiredArchives.filter((file) => !existsSync(path.join(datasetRoot, file)))

if (missing.length) {
  console.error(`Missing public dataset archives: ${missing.join(', ')}`)
  process.exit(1)
}

console.log(JSON.stringify({
  status: 'evaluation_scaffold_ready',
  datasets: ['CUAD', 'LeCaRD'],
  requiredNextStep: 'Create an expert-reviewed label mapping and a desensitized validation split before calculating risk-rule precision, recall, and macro F1.'
}))
