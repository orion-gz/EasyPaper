function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char])
}

export function parseStructuredVocabulary(text) {
  try {
    const value = JSON.parse(text)
    if (!value || !Array.isArray(value.advanced_words) || !Array.isArray(value.technical_terms)) return null
    return value
  } catch {
    return null
  }
}

function renderItems(items, advanced) {
  if (!items.length) return '<div class="insight-keyword-empty">해당 항목이 없습니다.</div>'
  return items.map(item => `
    <div class="insight-keyword-item">
      <button type="button" class="insight-keyword-term" data-page-num="${Number(item.page_num) || 1}" data-char-start="${Number(item.char_start) || 0}" data-char-end="${Number(item.char_end) || 0}" data-occurrence="${Number(item.occurrence) || 1}" title="클릭하면 지정된 원문 위치로 이동합니다">${escapeHtml(item.term)}</button>
      <span class="insight-keyword-def">${escapeHtml(item.meaning || '')}</span>
      ${advanced ? `<span class="document-type-chip general">${escapeHtml(item.level)}</span>` : ''}
      ${item.part_of_speech ? `<small>${escapeHtml(item.part_of_speech)}</small>` : ''}
      ${item.example ? `<small>${escapeHtml(item.example)}</small>` : ''}
    </div>`).join('')
}

export function renderStructuredVocabulary(value) {
  const advancedNotice = value.advanced_words_notice && value.advanced_words.length === 0
    ? `<div class="insight-keyword-empty">${escapeHtml(value.advanced_words_notice)}</div>`
    : renderItems(value.advanced_words, true)
  return `<div class="insight-vocabulary-section"><h4>고급 어휘</h4>${advancedNotice}</div>
    <div class="insight-vocabulary-section"><h4>전문 키워드</h4>${renderItems(value.technical_terms, false)}</div>`
}
