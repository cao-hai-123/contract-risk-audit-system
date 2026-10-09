import { analyzeTemplateCorpus } from '../backend/services/template-corpus.js'
const { manifest } = await analyzeTemplateCorpus({ onProgress: ({ current, total, status, cached, fileName }) =>
  console.log(`${current}/${total} ${status}${cached ? ' cached' : ''}: ${fileName}`) })
console.log(JSON.stringify({ ...manifest, files: undefined }))
if (manifest.partialFiles || manifest.unavailableFiles.length) process.exitCode = 2
