const escape = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

export function hasAdaptiveBriefing(data) {
  return data?.schema_version === 3 && Array.isArray(data.sections)
}

export function adaptiveBriefingSummary(data) {
  if (!hasAdaptiveBriefing(data)) return ''
  if (data.headline) return String(data.headline)
  const section = data.sections.find(item => item?.content || item?.items?.length)
  if (!section) return ''
  if (section.content) return String(section.content)
  const item = section.items[0]
  if (typeof item === 'string' || typeof item === 'number') return String(item)
  return item && typeof item === 'object' ? Object.values(item).filter(Boolean).join(' · ') : ''
}

function itemText(item) {
  if (typeof item === 'string' || typeof item === 'number') return escape(item)
  if (!item || typeof item !== 'object') return ''
  return Object.entries(item)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `<span class="primer-adaptive-field"><strong>${escape(key)}</strong> ${escape(value)}</span>`)
    .join('')
}

function renderItems(section) {
  const items = Array.isArray(section.items) ? section.items : []
  if (!items.length) return ''
  if (section.kind === 'glossary') {
    return `<div class="primer-glossary">${items.map(item => `
      <details class="primer-glossary-item">
        <summary class="primer-glossary-term">${escape(item?.term ?? item?.name ?? '')}</summary>
        <p class="primer-glossary-def">${escape(item?.definition ?? item?.description ?? '')}</p>
      </details>`).join('')}</div>`
  }
  const className = section.kind === 'triples' ? 'primer-adaptive-triples' : 'primer-checklist'
  return `<ul class="${className}">${items.map(item => `<li>${itemText(item)}</li>`).join('')}</ul>`
}

export function renderAdaptiveBriefingHtml(data, labels = {}) {
  const headline = data.headline
    ? `<div class="primer-hook-section"><span class="primer-hook-quote">&ldquo;</span><p class="primer-hook-text">${escape(data.headline)}</p></div>`
    : ''
  const sections = data.sections.map(section => `
    <section class="primer-adaptive-section" data-kind="${escape(section.kind || 'prose')}">
      <div class="primer-label"><span>${escape(section.title || section.id)}</span></div>
      ${section.content ? `<div class="primer-adaptive-content">${escape(section.content)}</div>` : ''}
      ${renderItems(section)}
    </section>`).join('')
  const questions = Array.isArray(data.suggested_questions) && data.suggested_questions.length
    ? `<section class="primer-adaptive-section"><div class="primer-label"><span>${escape(labels.suggestedQuestions || 'Suggested questions')}</span></div><ol class="primer-list">${data.suggested_questions.map(item => `<li>${escape(item)}</li>`).join('')}</ol></section>`
    : ''
  return `${headline}${sections}${questions}`
}
