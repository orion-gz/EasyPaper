// Character offsets belong to one text layer, not to the PDF itself.
function fingerprint(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return `${text.length}:${hash >>> 0}`
}

export function createAnnotationAnchor(text, startOffset, endOffset) {
  return {
    quote: text.slice(startOffset, endOffset),
    prefix: text.slice(Math.max(0, startOffset - 48), startOffset),
    suffix: text.slice(endOffset, endOffset + 48),
    fingerprint: fingerprint(text),
  }
}

function contextScore(text, start, end, anchor) {
  let score = 0
  const prefix = anchor?.prefix || '', suffix = anchor?.suffix || ''
  for (let index = 1; index <= prefix.length && start >= index; index++) {
    if (prefix.at(-index) !== text[start - index]) break
    if (!/\s/u.test(text[start - index])) score++
  }
  for (let index = 0; index < suffix.length && end + index < text.length; index++) {
    if (suffix[index] !== text[end + index]) break
    if (!/\s/u.test(text[end + index])) score++
  }
  return score
}

export function resolveAnnotationAnchor(text, annotation) {
  const { startOffset, endOffset, textAnchor } = annotation
  const quote = textAnchor?.quote || annotation.text
  if (typeof quote !== 'string' || !quote.length) return null
  const validOffsets = Number.isInteger(startOffset) && Number.isInteger(endOffset)
    && startOffset >= 0 && endOffset > startOffset && endOffset <= text.length
  if (validOffsets && text.slice(startOffset, endOffset) === quote
    && (!textAnchor || textAnchor.fingerprint === fingerprint(text))) return { startOffset, endOffset }

  const matches = []
  for (let start = text.indexOf(quote); start !== -1; start = text.indexOf(quote, start + 1)) {
    const end = start + quote.length
    matches.push({ startOffset: start, endOffset: end, score: contextScore(text, start, end, textAnchor) })
  }
  matches.sort((left, right) => right.score - left.score)
  if (!matches.length || (matches.length > 1 && matches[0].score === matches[1].score)) return null
  return { startOffset: matches[0].startOffset, endOffset: matches[0].endOffset }
}
