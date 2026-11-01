import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { alignSentencesToText as align } from '../src/sentenceAlignment.js'
import { mergePdfHighlightRects, projectSourceRects, mappedSentenceRange, sentenceCharParts, contiguousSentenceBounds } from '../src/pdfSentenceGeometry.js'
import { createFocusBackdropRects } from '../src/focusMode.js'

for (const [full, sources] of [
  ['First sentence. Extra sentence. Last sentence.', ['Missing OCR sentence.', 'Last sentence.']],
  ['Shared opening words end. Another sentence follows. Final sentence.', ['Shared opening words with OCR content that differs.', 'Final sentence.']],
]) {
  test(`unverified fallback cannot select neighbouring sentences: ${full}`, () => {
    const ranges = align(full, sources)
    assert.equal(ranges[0].start, ranges[0].end)
    assert.equal(ranges[1].text, sources[1])
  })
}

test('small OCR errors map one entire sentence and preserve the following exact match', () => {
  const first = 'Measurements were collected using specialized instruments.'
  const last = 'Another sentence follows.'
  const result = align(`${first} ${last}`, [first.replace('Measurements', 'Measurernents'), last])
  assert.equal(result[0].text, first)
  assert.equal(result[0].end, first.length)
  assert.equal(result[1].text, last)
})

test('equally plausible OCR sentences remain unresolved', () => {
  const result = align('The value is 101 today. The value is 102 today.', ['The value is 103 today.'])
  assert.equal(result[0].start, result[0].end)
})

test('normalization cannot erase a sentence boundary to manufacture an exact match', () => {
  const result = align('First. Second.', ['First second.'])
  assert.equal(result[0].start, result[0].end)
})

test('short out-of-order exact sentences keep their own ranges', () => {
  const result = align('Caption. Body.', ['Body.', 'Caption.'])
  assert.deepEqual(result.map(r => r.text), ['Body.', 'Caption.'])
  assert.equal(result[1].start, 0)
})

const viewport = { rawDims: { pageX: 0, pageY: 0, pageHeight: 100 }, convertToViewportPoint: (x, y) => [x, 100 - y] }
const mapping = { status: 'exact', coordinate_space: 'unrotated-top-left', segments: [{ rects: [[0, 0, 10, 10], [20, 0, 30, 10]] }] }
const inside = (r, x, y) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height

test('projected glyph boxes and highlight boxes never fill the gap between glyphs', () => {
  const rects = projectSourceRects(mapping, viewport)
  assert.equal(rects.length, 2)
  assert.ok(!rects.some(r => inside(r, 15, 5)))
  assert.ok(!mergePdfHighlightRects(rects).some(r => inside(r, 15, 5)))
})

test('merging preserves the exact pixel union even with overlapping baselines and RTL order', () => {
  const rects = [{ left: 20, top: 1, width: 10, height: 10 }, { left: 0, top: 0, width: 10, height: 10 },
    { left: 8, top: 3, width: 10, height: 10 }, { left: 30, top: 1, width: 5, height: 10 }]
  const merged = mergePdfHighlightRects(rects)
  for (let x = -1; x <= 36; x++) for (let y = -1; y <= 14; y++) {
    assert.equal(merged.some(r => inside(r, x + 0.5, y + 0.5)), rects.some(r => inside(r, x + 0.5, y + 0.5)))
  }
})

test('focus openings neither add padding nor expose the gap between sentence fragments', () => {
  const regions = createFocusBackdropRects(projectSourceRects(mapping, viewport), 40, 20)
  assert.ok(regions.some(r => inside(r, 15, 5)))
  assert.ok(regions.some(r => inside(r, 30.5, 5)))
  assert.ok(!regions.some(r => inside(r, 5, 5)))
})

test('reassembling sentence fragments preserves intervening unrelated text as a gap', () => {
  const full = 'First. Other. Last.'
  const range = mappedSentenceRange([{ sentenceIdx: 0, charStart: 0, charEnd: 6 }, { sentenceIdx: 0, charStart: 14, charEnd: 19 }], 0)
  assert.deepEqual(range.charParts, [{ start: 0, end: 6 }, { start: 14, end: 19 }])
  assert.equal(contiguousSentenceBounds(range, full), null)
  assert.deepEqual(contiguousSentenceBounds({ charParts: [{ start: 0, end: 3 }, { start: 4, end: 7 }] }, 'One two'), { start: 0, end: 7 })
})

// Exercise production DOM-range collection with glyph-level geometry, including
// an unrelated glyph whose centre lies inside the old merged line box.
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
function loadFunction(name, next, context) {
  return vm.runInNewContext(`${main.slice(main.indexOf(`function ${name}(`), main.indexOf(next, main.indexOf(`function ${name}(`)))}; ${name}`, context)
}
const fakeDocument = { createRange: () => ({
  setStart(node, offset) { this.node = node; this.start = offset },
  setEnd(node, offset) { this.end = offset },
  getClientRects() { return [{ left: this.start * 10, top: 0, width: (this.end - this.start) * 10, height: 10 }] },
}) }
const coordinates = () => ({ rectToLocal: r => r })
const container = { closest: () => ({ dataset: { page: '1' } }) }

test('sourceMappedRanges excludes a PDF.js character between source glyphs', () => {
  const map = loadFunction('sourceMappedRanges', 'function getSentenceRects(', {
    document: fakeDocument, pageCoordinates: coordinates, sourceMappingRects: () => projectSourceRects(mapping, viewport),
  })
  const result = map([{ src: 'AC', source_mapping: mapping }], { nodeRanges: [{ node: { length: 3 }, start: 0, end: 3 }] }, container, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].charParts)), [{ start: 0, end: 1 }, { start: 2, end: 3 }])
})

test('hover and active highlight DOM ranges do not span a sentence fragment gap', () => {
  const getRects = loadFunction('getSentenceRects', '// 오버레이 레이어에 하이라이트', {
    document: fakeDocument, pageCoordinates: coordinates, mergePdfHighlightRects, sentenceCharParts,
  })
  const rects = getRects({ charStart: 0, charEnd: 3, charParts: [{ start: 0, end: 1 }, { start: 2, end: 3 }] },
    { nodeRanges: [{ node: { length: 3 }, start: 0, end: 3 }] }, container)
  assert.ok(!rects.some(r => inside(r, 15, 5)))
  assert.equal(rects.length, 2)
})

test('opening and closing quotation marks remain within the selected sentence', () => {
  const full = 'Before. "Quoted sentence." After.'
  const result = align(full, ['Before.', '"Quoted sentence."', 'After.'])
  assert.equal(result[1].text, '"Quoted sentence."')
  assert.ok(result[0].end < result[1].start)
  assert.ok(result[1].end < result[2].start)
})

test('out-of-order repeated text searches beyond already occupied occurrences', () => {
  const result = align('Same sentence. Middle. Same sentence. Last.', ['Same sentence.', 'Last.', 'Same sentence.'])
  assert.equal(result[2].text, 'Same sentence.')
  assert.equal(result[2].start, 23)
})
