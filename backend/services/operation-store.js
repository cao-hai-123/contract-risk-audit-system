import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDirectory = path.resolve(__dirname, '../../data')
const databasePath = path.join(dataDirectory, 'operation-store.json')
const maxOperations = 300
let writeQueue = Promise.resolve()

export async function recordOperation(type, payload) {
  let operation
  await enqueueWrite(async () => {
    const database = await readDatabase()
    operation = {
      id: randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      payload
    }
    database.operations.unshift(operation)
    database.operations = database.operations.slice(0, maxOperations)
    database.updatedAt = operation.createdAt
    await writeDatabase(database)
  })
  return { stored: true, operationId: operation.id, database: 'embedded-json' }
}

export async function listOperations(limit = 50) {
  const database = await readDatabase()
  return database.operations
    .map(normalizeOperation)
    .slice(0, Math.min(Math.max(Number(limit) || 50, 1), maxOperations))
}

export async function archiveOperations(ids) {
  const normalizedIds = normalizeIds(ids)
  if (!normalizedIds.length) return { archived: 0, operations: [] }

  const archivedOperations = []
  await enqueueWrite(async () => {
    const database = await readDatabase()
    const archivedAt = new Date().toISOString()
    database.operations = database.operations.map((operation) => {
      if (!normalizedIds.includes(operation.id) || operation.archivedAt) return operation
      const archived = { ...operation, archivedAt }
      archivedOperations.push(normalizeOperation(archived))
      return archived
    })
    database.updatedAt = archivedAt
    await writeDatabase(database)
  })
  return { archived: archivedOperations.length, operations: archivedOperations }
}

export async function deleteOperations(ids) {
  const normalizedIds = normalizeIds(ids)
  if (!normalizedIds.length) return { deleted: 0 }

  let deleted = 0
  await enqueueWrite(async () => {
    const database = await readDatabase()
    const before = database.operations.length
    database.operations = database.operations.filter((operation) => !normalizedIds.includes(operation.id))
    deleted = before - database.operations.length
    if (deleted) {
      database.updatedAt = new Date().toISOString()
      await writeDatabase(database)
    }
  })
  return { deleted }
}

export async function createOperationBackup() {
  const database = await readDatabase()
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    operations: database.operations.map(normalizeOperation)
  }
}

async function readDatabase() {
  await mkdir(dataDirectory, { recursive: true })
  try {
    const content = await readFile(databasePath, 'utf8')
    const parsed = JSON.parse(content)
    return { version: 1, operations: Array.isArray(parsed.operations) ? parsed.operations : [], updatedAt: parsed.updatedAt || null }
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { version: 1, operations: [], updatedAt: null }
    throw error
  }
}

async function writeDatabase(database) {
  const temporaryPath = `${databasePath}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, databasePath)
}

function normalizeOperation(operation) {
  return {
    ...operation,
    archivedAt: operation.archivedAt || null,
    archived: Boolean(operation.archivedAt)
  }
}

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean))]
}

async function enqueueWrite(task) {
  writeQueue = writeQueue.catch(() => undefined).then(task)
  return writeQueue
}
