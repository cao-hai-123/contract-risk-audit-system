import path from 'node:path'
import { initializeDatabase, pool } from '../backend/db.js'
import { rebuildStandardClauseLibrary } from '../backend/services/standard-clause-service.js'

const allowCloudAnalysis = process.argv.includes('--deepseek')

try {
  await initializeDatabase()
  const result = await rebuildStandardClauseLibrary({
    matchDirectory: path.resolve(process.cwd(), 'match'),
    allowCloudAnalysis
  })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(`Standard clause library build failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
