import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTextAnchor, resolveTextAnchor } from '../src/articleViewer.js'

test('article anchor restores at original offsets', () => {
  const text = 'prefix exact selection suffix'
  const anchor = buildTextAnchor(text, 7, 22, { unit_id: 'section-1', block_id: 'block-1' })
  assert.deepEqual(resolveTextAnchor(text, anchor), { start: 7, end: 22 })
  assert.equal(anchor.exact, 'exact selection')
})

test('article anchor relocates using exact prefix and suffix', () => {
  const original = 'alpha repeated omega and beta repeated gamma'
  const anchor = buildTextAnchor(original, 30, 38)
  const changed = 'inserted words alpha repeated omega and beta repeated gamma'
  assert.deepEqual(resolveTextAnchor(changed, anchor), { start: 45, end: 53 })
})

test('article anchor safely fails when exact text disappeared', () => {
  const anchor = buildTextAnchor('stable quote', 0, 6)
  assert.equal(resolveTextAnchor('different content', anchor), null)
})
