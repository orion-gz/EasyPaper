const escape = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const list = (title, items, mapper = item => item) => {
  const values = Array.isArray(items) ? items.filter(Boolean) : []
  if (!values.length) return ''
  return `<section class="outline-summary-section"><strong>${escape(title)}</strong><ul>${values.map(item => `<li>${escape(mapper(item))}</li>`).join('')}</ul></section>`
}

const termText = term => {
  if (typeof term === 'string') return term
  if (!term || typeof term !== 'object') return ''
  const name = term.term ?? term.name ?? ''
  const definition = term.definition ?? term.description ?? ''
  return [name, definition].filter(Boolean).join(' — ')
}

export function renderChapterSummaryHtml(summary, labels = {}) {
  return `<article class="outline-summary-detail">
    <strong>${escape(summary?.headline || summary?.chapter?.title || labels.title || '')}</strong>
    <p>${escape(summary?.summary || '')}</p>
    ${list(labels.keyPoints || 'Key points', summary?.key_points)}
    ${list(labels.terms || 'Terms', summary?.terms, termText)}
    ${list(labels.limitations || 'Limitations', summary?.limitations)}
  </article>`
}

export function renderFullSummaryHtml(summary, labels = {}) {
  return `<article class="outline-summary-detail">
    <strong>${escape(summary?.headline || labels.title || '')}</strong>
    <p>${escape(summary?.summary || '')}</p>
    ${list(labels.keyPoints || 'Key points', summary?.key_points)}
    ${list(labels.connections || 'Chapter connections', summary?.chapter_connections)}
    ${list(labels.limitations || 'Limitations', summary?.limitations)}
  </article>`
}
