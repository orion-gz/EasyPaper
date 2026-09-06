import test from 'node:test'
import assert from 'node:assert/strict'
import { pageCoordinates } from '../src/pdfCoordinates.js'
import { alignTextLayer, collectTextContent } from '../src/pdfTextLayer.js'

globalThis.getComputedStyle = () => ({})
test.after(() => { delete globalThis.getComputedStyle })

test('viewport rects map into a bordered, scrolled page under fractional zoom', t => {
  t.mock.method(globalThis, 'getComputedStyle', () => ({
    width: '602.5px', height: '802.25px', boxSizing: 'border-box',
    borderLeftWidth: '1px', borderRightWidth: '1px', borderTopWidth: '1px', borderBottomWidth: '1px',
  }))
  const coordinates = pageCoordinates({
    getBoundingClientRect: () => ({ left: 30, top: -40, width: 602.5 * 0.8, height: 802.25 * 0.8 }),
    scrollLeft: 0, scrollTop: 10,
  })
  assert.equal(coordinates.width, 600.5)
  const result = coordinates.rectToLocal({ left: 110.8, top: 112.8, width: 240, height: 16 })
  for (const [key, expected] of Object.entries({ left: 100, top: 200, width: 300, height: 20 })) {
    assert.ok(Math.abs(result[key] - expected) < 1e-9)
  }
})

test('DOM advances replace stale canvas width and preserve text/rotation', t => {
  t.mock.method(globalThis, 'getComputedStyle', () => ({
    width: '400px', getPropertyValue: () => '0.8',
  }))
  const changes = []
  const span = { isConnected: true, style: { setProperty: (...args) => changes.push(args) } }
  alignTextLayer({ textDivs: [span] }, {
    items: [{ type: 'beginMarkedContent' }, { str: 'variable width', width: 300, fontName: 'f' }],
    styles: { f: {} },
  }, { scale: 1.5, userUnit: 2, rotation: 90 })
  assert.deepEqual(changes, [['--scale-x', 1.8]])
})

test('stream fallback preserves marked content, font styles and language', async () => {
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue({ items: [{ type: 'beginMarkedContent' }], styles: { f: { vertical: true } }, lang: 'ja' })
    controller.enqueue({ items: [{ str: 'text', fontName: 'f' }], styles: {} })
    controller.close()
  } })
  const result = await collectTextContent(stream)
  assert.equal(result.items.length, 2)
  assert.equal(result.styles.f.vertical, true)
  assert.equal(result.lang, 'ja')
  assert.equal(stream.locked, false)
})
