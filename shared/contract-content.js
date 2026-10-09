// Pure helpers shared by the browser and the API. Analysis metadata never defines a content version.
export function recognizedText(contract) {
  return (Array.isArray(contract?.paragraphStructure) ? contract.paragraphStructure : [])
    .map((item) => String(item?.content ?? item?.text ?? '').normalize('NFC').replace(/\r\n?/g, '\n').trim())
    .filter(Boolean).join('\n')
}

export function hasUsableContract(contract) {
  return Boolean(contract && !['failed', 'parsing', 'empty', 'demo'].includes(contract.analysisState)
    && contract.ai?.status !== 'demo' && recognizedText(contract).replace(/\s/g, '').length >= 10)
}

export function isPersistedContract(contract) {
  return hasUsableContract(contract) && typeof contract.parseSnapshotId === 'string' && contract.parseSnapshotId.length === 36
}

export function assertUsableContract(contract) {
  if (!hasUsableContract(contract)) {
    const error = new Error('请先上传并成功解析有效合同，示例或解析失败的数据不能用于审核。')
    error.status = 422
    error.code = 'invalid_contract'
    throw error
  }
}

export function emptyContract(sourceFile = '', state = 'empty') {
  return {
    sourceFile, analysisState: state, paragraphStructure: [], keyElements: {}, contractType: {},
    documentParsing: { textLength: 0, warnings: [] }, ocr: { required: false, status: 'not_started' },
    ai: { provider: '未分析', model: '', used: false, status: state }, summary: ''
  }
}
