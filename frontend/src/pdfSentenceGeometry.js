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

// Merge only when the union is itself a rectangle. Filling a gap (or the
// corners between different baselines) paints pixels belonging to other text.
export function mergePdfHighlightRects(rects) {
  const result = []
  for (const rect of rects) {
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
        || rect.width <= 0 || rect.height <= 0) continue
    let r = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    for (let i = 0; i < result.length;) {
      const other = result[i]
      const right = r.left + r.width, bottom = r.top + r.height
      const otherRight = other.left + other.width, otherBottom = other.top + other.height
      const contains = (r.left <= other.left && r.top <= other.top && right >= otherRight && bottom >= otherBottom)
        || (other.left <= r.left && other.top <= r.top && otherRight >= right && otherBottom >= bottom)
      const sameRow = r.top === other.top && bottom === otherBottom && r.left <= otherRight && other.left <= right
      const sameColumn = r.left === other.left && right === otherRight && r.top <= otherBottom && other.top <= bottom
      if (!contains && !sameRow && !sameColumn) { i++; continue }
      const left = Math.min(r.left, other.left), top = Math.min(r.top, other.top)
      r = { left, top, width: Math.max(right, otherRight) - left, height: Math.max(bottom, otherBottom) - top }
      result.splice(i, 1)
      i = 0
    }
    result.push(r)
  }
  return result.sort((a, b) => a.top - b.top || a.left - b.left)
}

export function sentenceCharParts(range) {
  const parts = range.charParts ?? [{ start: range.charStart, end: range.charEnd }]
  const result = []
  for (const part of parts.filter(p => Number.isInteger(p.start) && Number.isInteger(p.end)
    && p.start >= 0 && p.end > p.start).sort((a, b) => a.start - b.start)) {
    const last = result.at(-1)
    if (last && part.start <= last.end) last.end = Math.max(last.end, part.end)
    else result.push({ start: part.start, end: part.end })
  }
  return result
}

export function contiguousSentenceBounds(range, fullText) {
  const parts = sentenceCharParts(range)
  if (!parts.length || parts.at(-1).end > fullText.length) return null
  if (parts.some((part, index) => index && fullText.slice(parts[index - 1].end, part.start).trim())) return null
  return { start: parts[0].start, end: parts.at(-1).end }
}

export function mappedSentenceRange(ranges, sentenceIdx) {
  const parts = ranges.filter(r => (r.originalSentenceIdx ?? r.sentenceIdx) === sentenceIdx)
  if (!parts.length) return null
  const charParts = sentenceCharParts({ charParts: parts.flatMap(sentenceCharParts) })
  return { ...parts[0], sentenceIdx, isEquation: false, charParts,
    charStart: charParts[0]?.start ?? -1, charEnd: charParts.at(-1)?.end ?? -1 }
}

// PyMuPDF uses the unrotated visible-page top left; PDF.js uses PDF bottom left.
export function projectSourceRects(mapping, viewport) {
  if (mapping?.status !== 'exact' || mapping.coordinate_space !== 'unrotated-top-left') return []
  const { pageX, pageY, pageHeight } = viewport.rawDims
  // Keep original glyph boxes for both hit testing and drawing. In particular,
  // never use display line boxes to decide which PDF.js characters belong here.
  const sourceBoxes = (mapping.segments || []).flatMap(segment => segment.rects || [])
  return sourceBoxes.flatMap(box => {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
        || box[2] <= box[0] || box[3] <= box[1]) return []
    const [x0, y0] = viewport.convertToViewportPoint(pageX + box[0], pageY + pageHeight - box[3])
    const [x1, y1] = viewport.convertToViewportPoint(pageX + box[2], pageY + pageHeight - box[1])
    return [{ left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }]
  })
}

export function sourceMappingMatchesRevision(mapping, revision) {
  return Boolean(mapping && revision && (mapping.layout_revision || mapping.source_revision) === revision)
}
