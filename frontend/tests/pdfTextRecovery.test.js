import test from 'node:test'
import assert from 'node:assert/strict'
import { recoveredTextContent } from '../src/pdfTextLayer.js'

test('OCR coordinates retain crop origin and PDF user units', () => {
  const content = recoveredTextContent([{ text: '日本語', bbox: [40, 60, 200, 100] }], {
    userUnit: 2, rawDims: { pageX: 10, pageY: 20, pageHeight: 400 },
  })
  assert.deepEqual(content.items[0].transform, [20, 0, 0, 20, 30, 370])
  assert.equal(content.items[0].width, 80)
  assert.equal(content.items[0].str, '日本語')
})

test('OCR preserves RTL and text without spaces', () => {
  const viewport = { userUnit: 1, rawDims: { pageX: 0, pageY: 0, pageHeight: 800 } }
  for (const text of ['日本語', '한국어', '中文', 'Ελληνικά', 'العربية', 'עברית']) {
    const { items } = recoveredTextContent([{ text, bbox: [20, 30, 100, 50] }], viewport)
    assert.equal(items[0].str, text)
    assert.equal(items[0].dir, ['العربية', 'עברית'].includes(text) ? 'rtl' : 'ltr')
  }
})
