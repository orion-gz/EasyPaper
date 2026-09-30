// Ignore whitespace only; never guess by sentence counts, prefixes or proximity.
export function exactSentenceOffsets(text, sentences) {
  let normalized = ''
  const offsets = []
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i])) { normalized += text[i]; offsets.push(i) }
  }
  let cursor = 0
  return sentences.map(sentence => {
    const target = sentence.source_text.replace(/\s/g, '')
    const start = target ? normalized.indexOf(target, cursor) : -1
    if (start < 0) return null
    cursor = start + target.length
    return { start: offsets[start], end: offsets[cursor - 1] + 1 }
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
