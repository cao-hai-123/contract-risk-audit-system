import { createDedicatedEmbedding } from '../backend/services/semantic-retrieval-service.js'

const { current, vectors } = await createDedicatedEmbedding([
  '合同价款应在验收合格并收到发票后十五个工作日内支付。',
  '双方应当对在履行过程中知悉的商业秘密承担保密义务。'
])

if (current.endpoint !== 'http://127.0.0.1:11436') throw new Error(`专用向量模型未绑定预期本地端点：${current.endpoint}`)
if (current.state !== 'ready') throw new Error(`专用向量模型未就绪：${current.message}`)
if (vectors.length !== 2 || vectors.some((vector) => vector.length !== current.dimensions || vector.some((item) => !Number.isFinite(item)))) {
  throw new Error('专用向量模型未返回两个有效的固定维度向量。')
}

console.log(JSON.stringify({ status: 'passed', provider: current.provider, model: current.model, modelVersion: current.modelVersion, dimensions: current.dimensions, endpoint: current.endpoint }))
