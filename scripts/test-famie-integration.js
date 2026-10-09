import assert from 'node:assert/strict'
import { buildFamieAnnotationDataset, buildFamieEntityTypeFile, getFamieConfiguration, getFamieStatus } from '../backend/services/famie-service.js'

const contract = {
  sourceFile: '脱敏服务合同.pdf',
  paragraphStructure: [
    { index: 1, content: '-- 1 of 2 --' },
    { index: 2, content: '甲方：示例科技有限公司；乙方：示例服务有限公司。合同金额为人民币 100,000 元。' },
    { index: 3, content: '双方因履行本合同发生争议的，应先协商；协商不成的，提交合同签订地人民法院处理。' }
  ]
}

const configuration = getFamieConfiguration()
assert.equal(configuration.sourceAvailable, true, '项目内应保留 FAMIE 源码。')
assert.equal(configuration.license, 'GPL-3.0-only')

const dataset = buildFamieAnnotationDataset(contract)
assert.equal(dataset.sourceFile, '脱敏服务合同.pdf')
assert.equal(dataset.paragraphCount, 3)
assert.ok(dataset.unitCount >= 2, '应按语义单位导出标注样本。')
assert.equal(dataset.text.includes('-- 1 of 2 --'), false, '页码标记不应进入标注集。')
assert.match(dataset.fileName, /famie-unlabeled-contract-elements\.txt$/)

const schema = buildFamieEntityTypeFile()
assert.equal(schema.entityTypes.length, 14)
assert.match(schema.text, /CONTRACT_PARTY/)
assert.match(schema.text, /DISPUTE_RESOLUTION/)

const ready = await getFamieStatus({
  fetchImpl: async () => Response.json({service: 'famie', status: 'ready'})
})
assert.equal(ready.ready, true)
assert.equal(ready.state, 'ready')

const unavailable = await getFamieStatus({
  fetchImpl: async () => {
    const error = new Error('connect ECONNREFUSED')
    error.cause = { code: 'ECONNREFUSED' }
    throw error
  }
})
assert.equal(unavailable.ready, false)
assert.equal(unavailable.state, 'unavailable')
assert.match(unavailable.message, /尚未启动/)

for (const response of [new Response('ok'), new Response('missing', {status: 404}), Response.json({service: 'other', status: 'ready'})]) {
  assert.equal((await getFamieStatus({fetchImpl: async () => response})).ready, false)
}

console.log('FAMIE integration self-test passed: source, data export, schema, ready, and unavailable states.')
