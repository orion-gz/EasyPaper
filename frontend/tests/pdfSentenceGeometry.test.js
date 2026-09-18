import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { normalizePdfText, mergePdfHighlightRects, mappedSentenceRange } from '../src/pdfSentenceGeometry.js'

import { alignSentencesToText as align } from '../src/sentenceAlignment.js'

// Exercise the actual production alignment function without booting the UI.
const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const equations = source.slice(source.indexOf('function findDisplayEquationsFromVTM('), source.indexOf('// 문장 범위로부터 오버레이'))
const detectEquations = vm.runInNewContext(`${equations}; findDisplayEquationsFromVTM`)

test('multilingual prose is not split into equations because it lacks English words', () => {
  for (const fullText of ['Linux / UNIX を説明します。', 'Ελληνικό κείμενο / περιγραφή', 'النص العربي / نص آخر', '한국어 / 설명입니다.']) {
    assert.equal(detectEquations({ fullText, spans: [{ charStart: 0, charEnd: fullText.length, lineIndex: 0 }] }).length, 0)
  }
  const fullText = 'α + β = 2'
  assert.equal(detectEquations({ fullText, spans: [{ charStart: 0, charEnd: fullText.length, lineIndex: 0 }] }).length, 1)
})

for (const text of ['日本語の文章です。', 'ひらがなだけです。', 'カタカナです。', '한국어입니다.', '这是中文。',
  'Ελληνικό κείμενο.', 'النص العربي.', 'עברית מלאה.', 'हिन्दी भाषा।', 'Café français.', '𠮷野家です。']) {
  test(`maps the entire source including its final characters: ${text}`, () => {
    const full = `前置き。 ${text} 次です。`
    const ranges = align(full, ['前置き。', text, '次です。'])
    assert.equal(full.slice(ranges[1].start, ranges[1].end), text)
    assert.ok(ranges[0].end <= ranges[1].start && ranges[1].end <= ranges[2].start)
  })
}

test('normalization preserves raw offsets for compatibility and decomposed letters', () => {
  const full = 'oﬃce ＡＢＣ Café 𠮷。'
  const [range] = align(full, ['office ABC Café 𠮷。'])
  assert.equal(full.slice(range.start, range.end), full)
})

test('glyph-spaced kana and punctuation map without clipping', () => {
  const full = 'ひ ら が な で す 。 次 の 文 。'
  const [first, second] = align(full, ['ひらがなです。', '次の文。'])
  assert.equal(full.slice(first.start, first.end), 'ひ ら が な で す 。')
  assert.equal(full.slice(second.start, second.end), '次 の 文 。')
})

test('OCR baseline variation, gaps and RTL order merge into one line box', () => {
  const rects = [{ left: 40, top: 12, width: 10, height: 12 },
    { left: 10, top: 10, width: 10, height: 16 }, { left: 25, top: 13, width: 10, height: 11 }]
  assert.deepEqual(mergePdfHighlightRects(rects), [{ left: 10, top: 10, width: 40, height: 16 }])
})

test('separate lines and column gutters stay separate', () => {
  const rects = [{ left: 10, top: 10, width: 30, height: 12 },
    { left: 100, top: 10, width: 30, height: 12 }, { left: 10, top: 28, width: 30, height: 12 }]
  assert.equal(mergePdfHighlightRects(rects).length, 3)
})

test('translation maps all fragments around a displayed equation', () => {
  const result = mappedSentenceRange([
    { sentenceIdx: 0, charStart: 0, charEnd: 10 },
    { sentenceIdx: 10010, originalSentenceIdx: 0, charStart: 10, charEnd: 20, isEquation: true },
    { sentenceIdx: 0, charStart: 20, charEnd: 40 },
    { sentenceIdx: 1, charStart: 41, charEnd: 50 },
  ], 0)
  assert.equal(result.charStart, 0)
  assert.equal(result.charEnd, 40)
  assert.equal(result.sentenceIdx, 0)
})
