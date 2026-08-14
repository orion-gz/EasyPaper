const QUOTED_TITLE_RE = /["“]([^"”]{8,300})["”]/
const YEAR_RE = /\b(?:19|20)\d{2}[a-z]?\b/i
const VENUE_RE = /\b(?:proceedings|conference|journal|transactions|workshop|symposium|arxiv|volume|vol\.?|issue|no\.?|pages?|pp\.?|publisher|press|doi)\b/i

function cleanTitleCandidate(value) {
  return (value || '')
    .replace(/\*\*/g, '')
    .replace(/["“”]/g, '')
    .replace(/^\s*[-–—,;:.]+|[-–—,;:.]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractCitationTitle(citationText) {
  const raw = (citationText || '').replace(/[\u200B-\u200D\uFEFF]/g, ' ').trim()
  if (!raw) return ''

  const quoted = QUOTED_TITLE_RE.exec(raw)
  if (quoted) return cleanTitleCandidate(quoted[1])

  let text = raw
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:\[[^\]]+\]|\d+[.)])\s*/, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/\bdoi\s*:\s*10\.\d{4,9}\/\S+/gi, ' ')
    .replace(/\b10\.\d{4,9}\/\S+/gi, ' ')
    .replace(/\barxiv\s*:\s*\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  text = text.replace(/^.*?\bet\s+al\.?(?:\s*[,;:])?\s*/i, '')
  const apaYear = text.match(/^.*?\((?:19|20)\d{2}[a-z]?\)\s*[.,;:]?\s*(.+)$/i)
  if (apaYear) text = apaYear[1]

  const candidates = text
    .split(/\.\s+(?=[A-Z0-9“"])/)
    .map(cleanTitleCandidate)
    .filter(Boolean)
    .filter(part => !YEAR_RE.test(part) || part.replace(YEAR_RE, '').trim().split(/\s+/).length >= 3)
    .map(part => {
      const words = part.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []
      const commaCount = (part.match(/,/g) || []).length
      let score = Math.min(words.length, 18)
      if (words.length < 3) score -= 10
      if (VENUE_RE.test(part)) score -= 8
      if (commaCount >= 3) score -= 6
      if (/^(?:[A-Z]\.?\s*){1,3}[A-Z][a-z]+/.test(part)) score -= 4
      return { part, score }
    })
    .sort((a, b) => b.score - a.score)

  if (candidates.length && candidates[0].score > 0) {
    return cleanTitleCandidate(candidates[0].part.replace(/\s*\b(?:19|20)\d{2}[a-z]?\b.*$/i, ''))
  }

  return cleanTitleCandidate(text
    .replace(YEAR_RE, ' ')
    .replace(/\b(?:vol|no|pp|pages?)\.?\s*[\d–—-]+/gi, ' ')
    .replace(/\s+/g, ' '))
    .split(/\s+/)
    .slice(0, 18)
    .join(' ')
}

export function buildScholarSearchUrl(citationTexts) {
  const texts = Array.isArray(citationTexts) ? citationTexts : [citationTexts]
  const titles = [...new Set(texts.map(extractCitationTitle).filter(Boolean))]
  const query = titles.map(title => `"${title.replace(/"/g, '')}"`).join(' OR ')
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`
}
