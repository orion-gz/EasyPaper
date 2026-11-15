import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnnotationAnchor, resolveAnnotationAnchor } from '../src/annotationAnchor.js'

function annotation(text, quote, start = text.indexOf(quote)) {
  return { text: quote, startOffset: start, endOffset: start + quote.length,
    textAnchor: createAnnotationAnchor(text, start, start + quote.length) }
}

test('OCR prefix insertion relocates a highlight instead of marking the old offsets', () => {
  const saved = annotation('Sample PDF A', 'Sample')
  assert.deepEqual(resolveAnnotationAnchor('OCR prefix Sample PDF A', saved), { startOffset: 11, endOffset: 17 })
})

test('context disambiguates repeated phrases even if the old offsets still match', () => {
  const saved = annotation('Sample in a book.', 'Sample')
  const next = 'Sample in a diagram. Sample in a book.'
  assert.deepEqual(resolveAnnotationAnchor(next, saved), { startOffset: 21, endOffset: 27 })
})

test('unchanged pages retain the selected occurrence', () => {
  const text = 'Sample Sample Sample'
  assert.deepEqual(resolveAnnotationAnchor(text, annotation(text, 'Sample', 7)), { startOffset: 7, endOffset: 13 })
})

test('ambiguous or missing OCR quotes are retained without displaying a wrong range', () => {
  const saved = annotation('Sample', 'Sample')
  assert.equal(resolveAnnotationAnchor('Sample / Sample', saved), null)
  assert.equal(resolveAnnotationAnchor('Corrected OCR text', saved), null)
  assert.equal(saved.text, 'Sample')
  assert.equal(saved.startOffset, 0)
  assert.equal(resolveAnnotationAnchor('Sample / Sample', annotation('Sample PDF A', 'Sample')), null)
})

test('legacy annotations with a unique quote can be migrated', () => {
  assert.deepEqual(resolveAnnotationAnchor('Prefix Sample PDF', {
    text: 'Sample', startOffset: 0, endOffset: 6,
  }), { startOffset: 7, endOffset: 13 })
  assert.equal(resolveAnnotationAnchor('Prefix Sample Sample', {
    text: 'Sample', startOffset: 0, endOffset: 6,
  }), null)
})

test('anchors use DOM UTF-16 offsets for Korean and supplementary characters', () => {
  const text = '📚 원문 선택한 문구 끝'
  const saved = annotation(text, '선택한 문구')
  const next = 'OCR ' + text
  const resolved = resolveAnnotationAnchor(next, saved)
  assert.equal(next.slice(resolved.startOffset, resolved.endOffset), saved.text)
  assert.equal(resolved.startOffset, saved.startOffset + 4)
})
