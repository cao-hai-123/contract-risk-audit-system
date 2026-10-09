import { closeDatabase, initializeDatabase } from '../backend/db.js'
import { listOperations as listLegacyOperations } from '../backend/services/operation-store.js'
import { importLegacyOperations } from '../backend/services/mysql-operation-store.js'
import { syncRiskRuleLibrary } from '../backend/services/risk-audit-service.js'

try {
  await initializeDatabase()
  const operations = await listLegacyOperations(300)
  const imported = await importLegacyOperations(operations)
  const rules = await syncRiskRuleLibrary()
  console.log(JSON.stringify({ database: 'mysql', legacyOperations: operations.length, imported, riskRules: rules.count }))
} finally {
  await closeDatabase()
}
