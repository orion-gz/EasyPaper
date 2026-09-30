// Normalize PDF typography while retaining exact UTF-16 source offsets.
// Punctuation and case remain significant; never infer a match from a prefix.
function normalizeSource(text) {
  let normalized = ''
  const starts = [], ends = []
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (segment === '\u00ad' || (segment === '-' && /\p{L}$/u.test(text.slice(0, index)) && /^-\s*\n\s*\p{L}/u.test(text.slice(index)))) continue
    for (const char of segment.normalize('NFKC')) {
      if (/\s/.test(char)) continue
      normalized += char
      for (let i = 0; i < char.length; i++) { starts.push(index); ends.push(index + segment.length) }
    }
  }
  return { normalized, starts, ends }
}

export function exactSentenceOffsets(text, sentences) {
  const { normalized, starts, ends } = normalizeSource(text)
  let cursor = 0
  return sentences.map(sentence => {
    const target = normalizeSource(sentence.source_text).normalized
    const start = target ? normalized.indexOf(target, cursor) : -1
    if (start < 0) return null
    cursor = start + target.length
    return { start: starts[start], end: ends[cursor - 1] }
  })
}

// Rectangles use viewport coordinates for both PDF mappings and DOM ranges.
export function clipSourceRect(rect, bounds) {
  const left = Math.max(rect.left, bounds.left), top = Math.max(rect.top, bounds.top)
  const right = Math.min(rect.left + rect.width, bounds.right)
  const bottom = Math.min(rect.top + rect.height, bounds.bottom)
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null
}

export function visibleSourceBounds(root) {
  const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  for (let node = root; node; node = node.parentElement) {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect()
    const left = rect.left + node.clientLeft, top = rect.top + node.clientTop
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, left)
      bounds.right = Math.min(bounds.right, left + node.clientWidth)
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, top)
      bounds.bottom = Math.min(bounds.bottom, top + node.clientHeight)
    }
  }
  return bounds
}
