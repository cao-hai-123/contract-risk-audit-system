export function contractMetadataRows(report) {
  const contract = report.snapshot?.contract || {}
  const key = contract.keyElements || {}
  return [
    ['合同双方', key.parties || '未识别'],
    ['签署日期', key.signedDate || '未识别'],
    ['合同金额', key.amount || '未识别'],
    ['履行期限', key.performancePeriod || '未识别'],
    ['争议解决方式', key.disputeResolution || '未识别'],
    ['解析批次', contract.parseSnapshotId || '旧记录未保存'],
    ['风险审核批次', report.snapshot?.audit?.analysisRunId || '旧记录未保存'],
    ['标准匹配批次', report.snapshot?.match?.analysisRunId || '旧记录未保存'],
    ['风险执行情况', report.snapshot?.audit?.engine?.notice || report.snapshot?.audit?.engine?.provider || '未记录'],
    ['匹配执行情况', report.snapshot?.match?.engine?.notice || report.snapshot?.match?.engine?.provider || '未记录'],
    ['解析提示', contract.documentParsing?.warnings?.join('；') || '未记录解析警告']
  ]
}

export function evidenceLocation(item) {
  const span = item.evidenceSpans?.[0] || item.requirementEvidence?.[0]
  const paragraph = span?.paragraphIndex ?? item.paragraphIndex
  return [span?.page ? '第 ' + span.page + ' 页' : '', paragraph ? '段落 ' + paragraph : '',
    Number.isInteger(span?.charStart) ? '字符 ' + span.charStart + ' 至 ' + span.charEnd : ''].filter(Boolean).join('，') || '未定位，需人工核对'
}

