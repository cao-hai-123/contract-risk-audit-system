const trustedHostnames = ['court.gov.cn', 'www.court.gov.cn', 'gov.cn', 'www.gov.cn', 'npc.gov.cn', 'www.npc.gov.cn']

export async function searchTrustedLegalWeb(question) {
  const query = buildLegalSearchQuery(question)
  if (!query) return { status: 'empty_query', sources: [] }
  try {
    const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`
    const response = await fetch(url, { headers: { Accept: 'application/rss+xml, application/xml;q=0.9' }, signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error(`search HTTP ${response.status}`)
    const xml = await response.text()
    const sources = parseRssItems(xml)
      .filter((item) => isTrustedOfficialUrl(item.url))
      .slice(0, 5)
      .map((item, index) => ({ id: `W${index + 1}`, type: 'web', title: item.title, url: item.url, excerpt: item.excerpt }))
    return { status: sources.length ? 'success' : 'no_trusted_results', sources }
  } catch (error) {
    return { status: classifySearchError(error), sources: [] }
  }
}

export function buildLegalSearchQuery(question) {
  const normalized = String(question || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const legalKeywords = ['合同解除', '解除', '违约责任', '违约', '争议解决', '争议', '仲裁', '管辖', '付款', '价款', '验收', '交付', '保密', '个人信息', '知识产权', '不可抗力', '履行期限', '合同效力', '格式条款', '变更']
  const matches = legalKeywords.filter((keyword) => normalized.includes(keyword)).slice(0, 4)
  return `${matches.length ? matches.join(' ') : '合同 条款'} 法律 (site:court.gov.cn OR site:gov.cn OR site:npc.gov.cn)`
}

function parseRssItems(xml) {
  const items = String(xml || '').match(/<item>[\s\S]*?<\/item>/gi) || []
  return items.map((item) => ({
    title: decodeXml(readTag(item, 'title')).slice(0, 220),
    url: decodeXml(readTag(item, 'link')).trim(),
    excerpt: stripHtml(decodeXml(readTag(item, 'description'))).slice(0, 500)
  })).filter((item) => item.title && item.url && item.excerpt)
}

function readTag(value, tag) {
  return String(value || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || ''
}

function isTrustedOfficialUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return trustedHostnames.some((trusted) => hostname === trusted || hostname.endsWith(`.${trusted}`))
  } catch {
    return false
  }
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function classifySearchError(error) {
  const code = error?.cause?.code
  if (code === 'ENOTFOUND') return 'dns_unavailable'
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return 'network_unavailable'
  return 'search_unavailable'
}
