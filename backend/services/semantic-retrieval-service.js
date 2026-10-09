import crypto from 'node:crypto'
import { pool } from '../db.js'
import { ensureEmbeddedEmbeddingServer } from './embedded-embedding-service.js'

const batchSize = 4
const queryInstruction = 'Instruct: Given a Chinese enterprise contract question, retrieve relevant clauses and legal risk guidance.\nQuery: '

export async function rankSourcesBySemanticSimilarity({ question, sources }) {
  const current = await ensureEmbeddedEmbeddingServer()
  if (current.state !== 'ready') return { status: 'local_embedding_unavailable', provider: '词法相关性排序', scores: new Map() }

  const candidates = normalizeSources(sources)
  if (!candidates.length) return { status: 'empty_candidates', provider: '词法相关性排序', scores: new Map() }

  try {
    const prepared = candidates.map((source) => ({ ...source, sourceHash: createSourceHash(source, current) }))
    const vectors = await loadOrCreateVectors(prepared, current)
    const queryVector = await createEmbeddings([`${queryInstruction}${trimText(question, 900)}`], current).then((items) => items[0])
    if (!isUsableVector(queryVector, current.dimensions)) throw new Error('专用向量模型未返回预期维度的查询向量。')

    const scores = new Map()
    for (const source of prepared) {
      const vector = vectors.get(source.sourceHash)
      if (isUsableVector(vector, current.dimensions)) scores.set(source.id, cosineSimilarity(queryVector, vector))
    }
    if (!scores.size) throw new Error('本地语义索引没有可用向量。')
    return { status: 'ready', provider: '本地 Qwen3-Embedding-0.6B + 全文词法检索', scores,
      coverage: { totalChunks: candidates.length, scoredChunks: scores.size, complete: scores.size === candidates.length, reusedChunks: vectors.reused } }
  } catch (error) {
    return { status: 'embedding_unavailable', provider: '词法相关性排序', scores: new Map(), message: sanitizeError(error) }
  }
}

export async function indexSemanticSources(sources) {
  const current = await ensureEmbeddedEmbeddingServer()
  if (current.state !== 'ready') throw new Error(current.message || '专用向量模型不可用。')
  const prepared = normalizeSources(sources).map((source) => ({ ...source, sourceHash: createSourceHash(source, current) }))
  if (!prepared.length) return { indexed: 0, reused: 0, model: current.model, modelVersion: current.modelVersion, dimensions: current.dimensions }
  const vectors = await loadOrCreateVectors(prepared, current)
  return { indexed: prepared.length, reused: vectors.reused || 0, model: current.model, modelVersion: current.modelVersion, dimensions: current.dimensions }
}

export async function createDedicatedEmbedding(input) {
  const current = await ensureEmbeddedEmbeddingServer()
  if (current.state !== 'ready') throw new Error(current.message || '专用向量模型不可用。')
  return { current, vectors: await createEmbeddings(input, current) }
}

function normalizeSources(sources) {
  return (sources || [])
    .filter((source) => source?.id && source?.excerpt)
    .map((source) => ({
      ...source,
      type: String(source.type || 'fixture'),
      title: String(source.title || source.id),
      semanticText: `${trimText(source.title || source.id, 180)}\n${source.excerpt}`
    }))
}

async function loadOrCreateVectors(sources, current) {
  const rows = []
  for (let start = 0; start < sources.length; start += 200) {
    const hashes = sources.slice(start, start + 200).map((source) => source.sourceHash)
    const [batch] = await pool.execute(`SELECT source_hash, embedding_json, embedding_model, embedding_model_version, embedding_dimension FROM semantic_vector_index WHERE source_hash IN (${hashes.map(() => '?').join(',')})`, hashes)
    rows.push(...batch)
  }
  const vectors = new Map(rows
    .filter((row) => row.embedding_model === current.model && row.embedding_model_version === current.modelVersion && Number(row.embedding_dimension) === current.dimensions)
    .map((row) => [row.source_hash, parseVector(row.embedding_json)])
    .filter(([, vector]) => isUsableVector(vector, current.dimensions)))
  const missing = sources.filter((source) => !vectors.has(source.sourceHash))
  const reused = sources.length - missing.length

  for (let index = 0; index < missing.length; index += batchSize) {
    const batch = missing.slice(index, index + batchSize)
    const generated = await createEmbeddings(batch.map((source) => source.semanticText), current)
    if (generated.length !== batch.length || generated.some((vector) => !isUsableVector(vector, current.dimensions))) throw new Error('专用向量模型返回的向量数量或维度异常。')
    await saveVectors(batch, generated, current)
    batch.forEach((source, itemIndex) => vectors.set(source.sourceHash, generated[itemIndex]))
  }
  vectors.reused = reused
  return vectors
}

async function createEmbeddings(input, current) {
  const response = await fetch(`${current.endpoint}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: current.model, input, encoding_format: 'float' }),
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) throw new Error(`专用向量模型 HTTP ${response.status}`)
  const payload = await response.json()
  return (payload.data || []).sort((left, right) => left.index - right.index).map((item) => parseVector(item.embedding))
}

async function saveVectors(sources, vectors, current) {
  const now = new Date()
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]
    await pool.execute(
      `INSERT INTO semantic_vector_index (source_hash, source_kind, source_key, source_title, source_text, embedding_json, embedding_model, embedding_model_version, embedding_dimension, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE source_kind = VALUES(source_kind), source_key = VALUES(source_key), source_title = VALUES(source_title), source_text = VALUES(source_text), embedding_json = VALUES(embedding_json), embedding_model = VALUES(embedding_model), embedding_model_version = VALUES(embedding_model_version), embedding_dimension = VALUES(embedding_dimension), updated_at = VALUES(updated_at)`,
      [source.sourceHash, source.type, source.id, source.title, source.semanticText, JSON.stringify(vectors[index]), current.model, current.modelVersion, current.dimensions, now]
    )
  }
}

function createSourceHash(source, current) {
  return crypto.createHash('sha256').update(`${current.model}\n${current.modelVersion}\n${current.dimensions}\n${source.type}\n${source.id}\n${source.semanticText}`).digest('hex')
}

function parseVector(value) {
  if (Array.isArray(value)) return value.map(Number)
  try { return JSON.parse(value).map(Number) } catch { return [] }
}

function cosineSimilarity(left, right) {
  if (left.length !== right.length || !left.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  return dot / Math.max(Math.sqrt(leftNorm) * Math.sqrt(rightNorm), 0.000001)
}

function isUsableVector(value, dimensions) {
  return Array.isArray(value) && value.length === dimensions && value.every((item) => Number.isFinite(Number(item)))
}

function trimText(value, limit) {
  const source = String(value || '').replace(/\s+/g, ' ').trim()
  return source.length > limit ? source.slice(0, limit) : source
}

function sanitizeError(error) {
  return String(error?.message || '本地嵌入服务不可用。').replace(/[\r\n]/g, ' ').slice(0, 160)
}
