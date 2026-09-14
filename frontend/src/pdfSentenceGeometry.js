// Normalized matching must retain DOM (UTF-16) offsets, including ligatures,
// combining marks and supplementary-plane letters.
export function normalizePdfText(text, { includeMathSymbols = false } = {}) {
  let clean = ''
  const starts = [], ends = []
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    for (const char of segment.normalize('NFKC').toLowerCase()) {
      if (!/[\p{L}\p{M}\p{N}]/u.test(char) && !(includeMathSymbols && /[\u2200-\u22ff\u2190-\u21ff\u00d7\u00f7\u00b1\u00b7]/u.test(char))) continue
      clean += char
      for (let i = 0; i < char.length; i++) {
        starts.push(index)
        ends.push(index + segment.length)
      }
    }
  }
  return { clean, starts, ends }
}

// OCR emits glyph-sized spans with varying ascenders and baselines. Merge by
// vertical overlap, in visual order (also RTL), without bridging column gutters.
export function mergePdfHighlightRects(rects) {
  const lines = []
  for (const r of rects.filter(r => r.width > 0 && r.height > 0).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const line = lines.find(line => {
      const overlap = Math.min(line.bottom, r.top + r.height) - Math.max(line.top, r.top)
      return overlap >= Math.min(line.height, r.height) * 0.55
        && Math.abs(line.center - (r.top + r.height / 2)) <= Math.max(line.height, r.height) * 0.5
    })
    if (line) line.rects.push(r)
    else lines.push({ top: r.top, bottom: r.top + r.height, height: r.height, center: r.top + r.height / 2, rects: [r] })
  }
  return lines.flatMap(line => {
    const boxes = []
    for (const r of line.rects.sort((a, b) => a.left - b.left)) {
      const last = boxes.at(-1)
      if (last && r.left - (last.left + last.width) <= Math.max(last.height, r.height) * 1.25) {
        const right = Math.max(last.left + last.width, r.left + r.width)
        const bottom = Math.max(last.top + last.height, r.top + r.height)
        last.top = Math.min(last.top, r.top)
        last.width = right - last.left
        last.height = bottom - last.top
      } else boxes.push({ left: r.left, top: r.top, width: r.width, height: r.height })
    }
    return boxes
  })
}

export function mappedSentenceRange(ranges, sentenceIdx) {
  const parts = ranges.filter(r => (r.originalSentenceIdx ?? r.sentenceIdx) === sentenceIdx)
  if (!parts.length) return null
  return { ...parts[0], sentenceIdx, isEquation: false,
    charStart: Math.min(...parts.map(r => r.charStart)),
    charEnd: Math.max(...parts.map(r => r.charEnd)) }
}
