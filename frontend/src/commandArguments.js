// Only known commands consume arguments; localized names remain searchable.
export function parseCommandQuery(value) {
  const match = value.trimStart().match(/^\/([^\s]*)(\s+)?([\s\S]*)$/)
  return match ? { name: match[1].toLowerCase(), argument: match[3].trim(), hasArgument: Boolean(match[2]) } : null
}

export function commandArgumentError(name, argument, totalPages) {
  if (name === 'page') return !/^\d+$/.test(argument) || Number(argument) < 1 || Number(argument) > totalPages
  if (name === 'zoom') return !/^\d+(?:\.\d+)?%?$/.test(argument) || parseFloat(argument) < 50 || parseFloat(argument) > 300
  if (name === 'theme') return Boolean(argument) && !['light', 'dark'].includes(argument.toLowerCase())
  return false
}

export function formatDocumentCitation(doc) {
  const meta = doc.metadata || {}
  const biblio = meta.bibliography || {}
  const authors = (Array.isArray(meta.authors) ? meta.authors : [meta.authors]).map(author => typeof author === 'string' ? author : author?.name).filter(Boolean).join(', ')
  const year = meta.year || meta.publication_year
  const title = meta.title || doc.filename || doc.id
  const doi = biblio.doi || meta.doi
  const link = doi ? `https://doi.org/${String(doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')}` : meta.source_url || doc.source_url
  return [authors, year && `(${year})`, title, biblio.venue || meta.venue, link].filter(Boolean).join('. ')
}
