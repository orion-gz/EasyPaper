import test from 'node:test'
import assert from 'node:assert/strict'
import {
  UI_STYLES,
  DEFAULT_UI_STYLE,
  UI_STYLE_STORAGE_KEY,
  normalizeUiStyle,
  loadUiStyle,
  saveUiStyle,
  applyUiStyle,
} from '../src/themes/uiStyleEngine.js'

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
  }
}

test('uiStyleEngine applies identical global UI style across research and general modes', () => {
  assert.deepEqual(UI_STYLES, ['precision', 'editorial'])
  assert.equal(normalizeUiStyle('unknown'), DEFAULT_UI_STYLE)

  const storage = createStorage()
  assert.equal(loadUiStyle(storage), 'precision')

  saveUiStyle('editorial', storage)
  assert.equal(storage.getItem(UI_STYLE_STORAGE_KEY), 'editorial')
  assert.equal(loadUiStyle(storage), 'editorial')

  const root = { dataset: {} }
  const body = { dataset: {}, ownerDocument: { body: null, documentElement: root } }
  body.ownerDocument.body = body
  applyUiStyle(body, 'editorial')
  assert.equal(body.dataset.uiStyle, 'editorial')
  assert.equal(root.dataset.uiStyle, 'editorial')
})
