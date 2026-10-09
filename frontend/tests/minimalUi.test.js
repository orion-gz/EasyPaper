import test from 'node:test'
import assert from 'node:assert/strict'
import { isMinimalUi, setMinimalUi } from '../src/minimalUi.js'

test('minimal UI defaults off and persists a shared boolean preference', () => {
  const data = new Map()
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }
  assert.equal(isMinimalUi(storage), false)
  setMinimalUi(true, storage)
  assert.equal(isMinimalUi(storage), true)
  setMinimalUi(false, storage)
  assert.equal(isMinimalUi(storage), false)
})
