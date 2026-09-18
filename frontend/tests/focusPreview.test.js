import test from 'node:test'
import assert from 'node:assert/strict'
import { placeFocusPreview, previewBelongsToSentence } from '../src/focusPreview.js'

test('preview belongs to the current page and exact sentence or sentence part', () => {
  const anchor = { isConnected: true, dataset: { focusPage: '1', focusStart: '40', focusEnd: '47' } }
  assert.equal(previewBelongsToSentence(anchor, { pageNum: 1 }, { charStart: 20, charEnd: 50 }), true)
  assert.equal(previewBelongsToSentence(anchor, { pageNum: 2 }, { charStart: 20, charEnd: 50 }), false)
  assert.equal(previewBelongsToSentence(anchor, { pageNum: 1 }, { charStart: 0, charEnd: 40 }), false)
  assert.equal(previewBelongsToSentence(anchor, { pageNum: 1 }, { charStart: 45, charEnd: 80 }), false)
  assert.equal(previewBelongsToSentence({ ...anchor, isConnected: false }, { pageNum: 1 }, { charStart: 20, charEnd: 50 }), false)
  assert.equal(previewBelongsToSentence(anchor, null, null), false)
})

test('large previews fit the viewport without overlapping source or translated lines', () => {
  const obstacles = [{ left: 20, top: 80, width: 280, height: 40 }, { left: 330, top: 160, width: 280, height: 80 }]
  const result = placeFocusPreview({ left: 60, top: 70, width: 900, height: 900 }, obstacles, 640, 480)
  assert.ok(result)
  assert.ok(result.left >= 8 && result.top >= 8)
  assert.ok(result.left + result.width <= 632 && result.top + result.height <= 472)
  for (const r of obstacles) assert.ok(result.left + result.width <= r.left - 10 || result.left >= r.left + r.width + 10
    || result.top + result.height <= r.top - 10 || result.top >= r.top + r.height + 10)
  assert.equal(placeFocusPreview({ left: 0, top: 0, width: 300, height: 200 }, [{ left: 0, top: 0, width: 640, height: 480 }], 640, 480), null)
})
