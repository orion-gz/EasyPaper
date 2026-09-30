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
