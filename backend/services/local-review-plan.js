import { splitParagraphs } from './model-review-protocol.js'

// Focused model review follows the full deterministic scan. It never claims a full-text model scan.
export function planLocalReview(contract, candidates, sourceBudget = 3200) {
  const paragraphs = contract.paragraphStructure || []
  const jobs = [], skipped = []
  for (const candidate of candidates) {
    const keywords = candidate.reviewKeywords || []
    if (!keywords.length && candidate.kind !== 'pattern') {
      for (const chunk of splitParagraphs(paragraphs, sourceBudget, 100)) jobs.push({ group: [candidate], chunk })
      continue
    }
    const positions = new Set()
    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i], text = String(paragraph.content || paragraph.text || '')
      if ((candidate.kind === 'pattern' && (paragraph.index ?? i + 1) === candidate.paragraphIndex) ||
          (candidate.kind !== 'pattern' && keywords.some((word) => word && text.includes(word)))) {
        for (const offset of [-1, 0, 1]) if (paragraphs[i + offset]) positions.add(i + offset)
      }
    }
    if (!positions.size) { skipped.push(candidate.candidateId || candidate.ruleId || candidate.code); continue }
    const selected = [...positions].sort((a, b) => a - b).map((i) => ({ ...paragraphs[i], index: paragraphs[i].index ?? i + 1 }))
    for (const chunk of splitParagraphs(selected, sourceBudget, 100)) jobs.push({ group: [candidate], chunk })
  }
  // Identical source windows can share a model call, retaining the protocol's four-candidate cap.
  const merged = []
  for (const job of jobs) {
    const key = JSON.stringify(job.chunk.map((p) => [p.paragraphIndex, p.start, p.end]))
    const existing = merged.find((item) => item.key === key && item.group.length < 4)
    if (existing) existing.group.push(...job.group)
    else merged.push({ ...job, key })
  }
  return { jobs: merged, skipped }
}
