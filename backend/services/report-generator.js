import { contractMetadataRows, evidenceLocation } from './report-content.js'
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'

const reportFont = 'SimSun'
const pageWidth = 9360
const labelWidth = 2700
const detailWidth = pageWidth - labelWidth

export async function buildAuditReportDocx(contract, organizedReport) {
  const keyElements = contract.keyElements || {}
  const metadataRows = [
    ['来源文件', contract.sourceFile || '未命名合同'],
    ['合同类型', contract.contractType?.predicted || '未识别'],
    ['类型置信度', formatPercent(contract.contractType?.confidence)],
    ['合同双方', keyElements.parties || '未识别'],
    ['签署日期', keyElements.signedDate || '未识别'],
    ['合同金额', keyElements.amount || '未识别'],
    ['履行期限', keyElements.performancePeriod || '未识别'],
    ['争议解决方式', keyElements.disputeResolution || '未识别']
  ]

  const document = new Document({
    creator: '企业合同智能审核与风险预警系统',
    title: '企业合同智能审核报告',
    description: '由合同智能解析模块生成的审核报告。',
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
          }
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 110 },
            children: [
              new TextRun({ text: '合同智能审核说明报告', bold: true, size: 36, color: '1F1F1F', font: reportFont })
            ]
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 280 },
            children: [
              new TextRun({
                text: `文本整理方式：${organizedReport.provider === 'DeepSeek' ? 'DeepSeek 语义整理' : '本地结构化整理'}`,
                size: 20,
                color: '666666',
                font: reportFont
              })
            ]
          }),
          heading('合同要素概览'),
          buildMetadataTable(metadataRows),
          heading('说明摘要'),
          bodyParagraph(organizedReport.formalSummary || buildFormalSummary(contract)),
          heading('智能整理后的合同文本'),
          ...buildSectionParagraphs(organizedReport.sections)
        ]
      }
    ]
  })

  return Packer.toBuffer(document)
}

export async function buildRiskAuditChecklistDocx(contract, audit) {
  const summary = audit?.summary || {}
  const metadataRows = [
    ['审核文件', contract.sourceFile || '未命名合同'],
    ['合同类型', contract.contractType?.predicted || '未识别'],
    ['审核引擎', audit?.engine?.provider || '增强规则库'],
    ['审核时间', formatDateTime(audit?.engine?.reviewedAt)],
    ['综合风险等级', summary.overallLevel || '待评估'],
    ['风险评分', Number.isFinite(Number(summary.score)) ? `${summary.score} / 100` : '待评估'],
    ['风险项目统计', `高风险 ${summary.high || 0} 项；中风险 ${summary.medium || 0} 项；低风险 ${summary.low || 0} 项；缺失条款 ${summary.missing || 0} 项`]
  ]
  const findings = [
    ...(audit?.risks || []).map((item) => ({ ...item, kind: '风险条款' })),
    ...(audit?.missingClauses || []).map((item) => ({ ...item, kind: '缺失条款' }))
  ]

  const document = new Document({
    creator: '企业合同智能审核与风险预警系统',
    title: '合同风险审核清单',
    description: '由合同风险审核模块生成的正式风险审核清单。',
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 110 }, children: [new TextRun({ text: '合同风险审核清单', bold: true, size: 36, color: '1F1F1F', font: reportFont })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 280 }, children: [new TextRun({ text: '企业合同智能审核与风险预警系统', size: 20, color: '1F1F1F', font: reportFont })] }),
        heading('一、审核概览'),
        buildMetadataTable(metadataRows),
        heading('二、审核说明'),
        bodyParagraph(`本清单依据已解析合同文本、风险规则库及已启用的模型复核结果生成，用于协助识别需进一步审阅的合同事项。风险等级反映系统对文本风险信号的审慎评估，不构成法律意见或最终法律结论。`),
        heading('三、风险与缺失条款清单'),
        ...(findings.length ? findings.flatMap((finding, index) => buildChecklistFinding(index + 1, finding)) : [bodyParagraph('本次审核未识别出需列示的风险条款或缺失条款。')]),
        heading('四、使用提示'),
        bodyParagraph('建议结合交易背景、合同全文、业务资料及适用法律法规，对本清单所列事项进行人工复核；涉及重大金额、核心权利义务或争议解决安排的，应由具备相应资质的专业人员进一步审阅。')
      ]
    }]
  })

  return Packer.toBuffer(document)
}

export async function buildStandardClauseMatchDocx(contract, matchResult) {
  const summary = matchResult?.summary || {}
  const metadataRows = [
    ['审核文件', contract?.sourceFile || '未命名合同'],
    ['合同类型', contract?.contractType?.predicted || '未识别'],
    ['匹配引擎', matchResult?.engine?.provider || '标准条款库'],
    ['匹配时间', formatDateTime(matchResult?.engine?.reviewedAt)],
    ['完整性评价', summary.overall || '待评估'],
    ['完整性得分', Number.isFinite(Number(summary.completenessScore)) ? `${summary.completenessScore} / 100` : '待评估'],
    ['条款统计', `完整 ${summary.complete || 0} 项；部分具备 ${summary.partial || 0} 项；缺失 ${summary.missing || 0} 项`]
  ]
  const items = matchResult?.items || []
  const document = new Document({
    creator: '企业合同智能审核与风险预警系统',
    title: '标准合同条款匹配报告',
    description: '由标准条款匹配模块生成的合同完整性说明报告。',
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 110 }, children: [new TextRun({ text: '标准合同条款匹配报告', bold: true, size: 36, color: '1F1F1F', font: reportFont })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 280 }, children: [new TextRun({ text: '企业合同智能审核与风险预警系统', size: 20, color: '1F1F1F', font: reportFont })] }),
        heading('一、匹配说明'),
        bodyParagraph('本报告依据系统标准合同条款库、已解析的合同文本及已启用的模型复核生成，用于协助识别合同内容是否覆盖常见的必要条款要素。报告所列“缺失”或“部分具备”仅表示系统未在当前可识别文本中确认相应要素，不代表相关条款在合同中当然无效或交易不可执行。'),
        heading('二、合同与匹配概览'),
        buildMetadataTable(metadataRows),
        heading('三、条款完整性匹配明细'),
        ...(items.length ? items.flatMap((item, index) => buildStandardMatchItem(index + 1, item)) : [bodyParagraph('本次未取得可用于匹配的标准条款结果。')]),
        heading('四、完善建议与使用提示'),
        bodyParagraph('建议优先补充标注为“缺失”或“部分具备”的条款要素，并结合合同标的、交易模式、履行周期、行业监管要求及双方谈判结果进行人工复核。涉及重大交易、强制性规范、消费者权益、数据处理或争议解决安排的，应由具备相应资质的专业人员进一步审阅。'),
        bodyParagraph(matchResult?.boundary || '本报告仅用于合同完整性审阅参考，不构成法律意见。')
      ]
    }]
  })
  return Packer.toBuffer(document)
}

export async function buildManagedAuditReportDocx(report) {
  const contract = report?.snapshot?.contract || {}
  const audit = report?.snapshot?.audit || {}
  const match = report?.snapshot?.match || {}
  const versionLabel = `V${report?.versionNumber || 1}`
  const overviewRows = [
    ...contractMetadataRows(report),
    ['审核文件', contract.sourceFile || report?.sourceFile || '未命名合同'],
    ['合同版本', versionLabel],
    ['合同类型', contract.contractType?.predicted || report?.contractType || '未识别'],
    ['报告状态', report?.status || '待人工确认'],
    ['综合风险等级', audit.summary?.overallLevel || '待评估'],
    ['风险评分', Number.isFinite(Number(audit.summary?.score)) ? `${audit.summary.score} / 100` : '待评估'],
    ['条款完整性', match.summary?.overall || '待评估'],
    ['完整性得分', Number.isFinite(Number(match.summary?.completenessScore)) ? `${match.summary.completenessScore} / 100` : '待评估']
  ]
  const findings = [...(audit.risks || []).map((item) => ({ ...item, kind: '风险条款' })), ...(audit.missingClauses || []).map((item) => ({ ...item, kind: '缺失条款' }))]
  const incomplete = (match.items || []).filter((item) => item.status !== '完整')
  const document = new Document({
    creator: '企业合同智能审核与风险预警系统',
    title: '企业合同统一审核报告',
    description: '整合风险审核与标准条款匹配结果的正式说明报告。',
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: '企业合同统一审核报告', bold: true, size: 36, color: '1F1F1F', font: reportFont })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 260 }, children: [new TextRun({ text: `报告版本：${versionLabel}　生成时间：${formatDateTime(report?.createdAt)}`, size: 20, color: '555555', font: reportFont })] }),
        heading('一、审核结果概览'),
        buildMetadataTable(overviewRows),
        heading('二、审核说明与人工复核状态'),
        bodyParagraph('本报告统一汇总已解析合同文本、风险规则库、标准条款匹配以及已启用模型复核的可识别结果。系统结论仅用于合同审阅辅助，涉及重大交易或法律效果的事项应由具备相应资质的人员结合完整材料复核。'),
        bodyParagraph(`当前人工复核状态：${report?.status || '待人工确认'}。${report?.reviewerNote ? `复核备注：${report.reviewerNote}` : '尚未填写人工复核备注。'}`),
        heading('三、风险统计与重点发现'),
        bodyParagraph(`统计结果：高风险 ${audit.summary?.high || 0} 项；中风险 ${audit.summary?.medium || 0} 项；低风险 ${audit.summary?.low || 0} 项；缺失条款 ${audit.summary?.missing || 0} 项。`),
        ...(findings.length ? findings.flatMap((finding, index) => buildChecklistFinding(index + 1, finding)) : [bodyParagraph('本次审核未识别出需列示的风险或缺失条款。')]),
        heading('四、标准条款完整性'),
        bodyParagraph(`匹配统计：完整 ${match.summary?.complete || 0} 项；部分具备 ${match.summary?.partial || 0} 项；缺失 ${match.summary?.missing || 0} 项。`),
        ...(incomplete.length ? incomplete.flatMap((item, index) => buildStandardMatchItem(index + 1, item)) : [bodyParagraph('本次匹配未识别出需要补充的标准条款要素。')]),
        heading('五、合同版本信息'),
        bodyParagraph(report?.changeSummary || '初始版本：基于当前可识别合同文本生成。'),
        heading('六、使用提示'),
        bodyParagraph('本报告由系统自动组织生成，原文依据、风险等级与修改建议均应结合合同全文及交易背景进行人工确认。本报告不构成法律意见或最终法律结论。')
      ]
    }]
  })
  return Packer.toBuffer(document)
}

function buildMetadataTable(rows) {
  return new Table({
    width: { size: pageWidth, type: WidthType.DXA },
    columnWidths: [labelWidth, detailWidth],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' }
    },
    rows: rows.map(([label, value]) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: labelWidth, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, color: 'F2F2F2', fill: 'F2F2F2' },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [tableParagraph(label, true)]
          }),
          new TableCell({
            width: { size: detailWidth, type: WidthType.DXA },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [tableParagraph(value)]
          })
        ]
      })
    )
  })
}

function buildSectionParagraphs(sections) {
  const safeSections = Array.isArray(sections) && sections.length ? sections : [{ title: '合同正文', paragraphs: [] }]
  return safeSections.flatMap((section) => [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 220, after: 100 },
      children: [new TextRun({ text: normalizeText(section.title || '合同正文'), bold: true, color: '1F1F1F', font: reportFont })]
    }),
    ...(section.paragraphs || []).map((paragraph) => bodyParagraph(paragraph.text || paragraph))
  ])
}

function heading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 220, after: 120 },
    children: [new TextRun({ text, bold: true, color: '1F1F1F', font: reportFont })]
  })
}

function bodyParagraph(text) {
  return new Paragraph({
    spacing: { after: 120, line: 330 },
    children: [new TextRun({ text: normalizeText(text), size: 22, color: '1F1F1F', font: reportFont })]
  })
}

function tableParagraph(text, bold = false) {
  return new Paragraph({
    spacing: { after: 0, line: 280 },
    children: [new TextRun({ text: normalizeText(text), size: 20, bold, color: '1F1F1F', font: reportFont })]
  })
}

function buildChecklistFinding(index, finding) {
  const label = `${index}. ${normalizeText(finding.kind || '审核事项')}：${normalizeText(finding.title || '未命名事项')}`
  const lines = [
    `风险等级：${normalizeText(finding.level || '待评估')}风险。`,
    finding.kind === '缺失条款' ? '识别依据：未在已解析文本中识别到足以满足条款完整性的内容。' : `原文位置：${evidenceLocation(finding)}。原文依据：${normalizeText(finding.evidence || '未提供')}`,
    `审核说明：${normalizeText(finding.reason || '未提供')}`,
    `修改建议：${normalizeText(finding.suggestion || '建议结合合同实际情况补充或调整。')}`
  ]
  return [
    new Paragraph({ spacing: { before: 180, after: 80 }, children: [new TextRun({ text: label, bold: true, size: 23, color: '1F1F1F', font: reportFont })] }),
    ...lines.map((line) => bodyParagraph(line))
  ]
}

function buildStandardMatchItem(index, item) {
  const headingText = `${index}. ${normalizeText(item.title || '未命名标准条款')}（${normalizeText(item.status || '待评估')}）`
  const present = Array.isArray(item.presentRequirements) && item.presentRequirements.length ? item.presentRequirements.join('、') : '未确认'
  const missing = Array.isArray(item.missingRequirements) && item.missingRequirements.length ? item.missingRequirements.join('、') : '未识别出明确缺口'
  const sourceText = item.sourceCount ? `标准模板覆盖：在 ${item.sourceCount} 份已分析标准模板中识别到相关主题。` : '标准模板覆盖：采用系统标准条款基线进行匹配。'
  return [
    new Paragraph({ spacing: { before: 180, after: 80 }, children: [new TextRun({ text: headingText, bold: true, size: 23, color: '1F1F1F', font: reportFont })] }),
    bodyParagraph(`识别依据：${normalizeText(item.evidence || '未提供')}`),
    bodyParagraph(`已识别要素：${normalizeText(present)}`),
    bodyParagraph(`建议补充要素：${normalizeText(missing)}`),
    bodyParagraph(`完善建议：${normalizeText(item.suggestion || '建议结合交易实际情况补充对应条款。')}`),
    bodyParagraph(sourceText)
  ]
}

function formatPercent(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(0)}%` : '待评估'
}

function formatDateTime(value) {
  const date = new Date(value || Date.now())
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeStyle: 'medium', hour12: false }).format(date)
}

function normalizeText(value) {
  return String(value || '未识别').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim()
}

function buildFormalSummary(contract) {
  const sourceFile = normalizeText(contract.sourceFile || '当前合同文件')
  const contractType = normalizeText(contract.contractType?.predicted || '未识别合同类型')
  return `本说明报告基于“${sourceFile}”的可识别文本生成，已完成合同文本解析、段落结构整理、合同类型初步判断及关键要素提取。当前初判类型为“${contractType}”。本报告用于为后续风险审核、问答及报告生成提供结构化输入，不构成法律意见或最终审核结论。`
}
