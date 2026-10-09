// Contexts follow explicit document headings. Unrelated standalone paragraphs are never concatenated.
export function clauseContexts(contract) {
  const result = []
  let current = null
  const paragraphs = contract?.paragraphStructure || []
  for (const paragraph of paragraphs) {
    const text = String(paragraph.content || paragraph.text || '').trim()
    if (!text) continue
    const heading = /^(第[一二三四五六七八九十百零\d]+[条章节]|[一二三四五六七八九十]+[、．.]|\d+[、．.]\s*\D)/.test(text)
    const namedHeading = text.length < 36 && /^(?:保密条款|交付验收|违约责任|不可抗力|争议解决|合同主体|通知送达)[:：]?$/.test(text)
    if (heading || namedHeading) {
      current = { paragraphs: [paragraph], text }
      result.push(current)
    } else if (current) {
      current.paragraphs.push(paragraph)
      current.text += '\n' + text
    } else result.push({ paragraphs: [paragraph], text })
  }
  return result
}

