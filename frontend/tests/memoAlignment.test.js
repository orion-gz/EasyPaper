import test from 'node:test'
import assert from 'node:assert/strict'
import { compareMemoAnchors, stackMemoCards } from '../src/memoAlignment.js'
import { getMemoLayoutPreferences } from '../src/readerPreferenceStore.js'

test('sorts by source anchor with stable ties and unanchored notes last', () => {
  const notes = [{ id: 'page', sentenceIdx: -1 }, { id: 'later', charStart: 90 }, { id: 'b', sentenceIdx: 3, createdAt: '2026-01-02' }, { id: 'a', charStart: 10, createdAt: '2026-01-01' }]
  assert.deepEqual(notes.sort((a, b) => compareMemoAnchors(a, b, [{ sentenceIdx: 3, charStart: 10 }])).map(x => x.id), ['a', 'b', 'later', 'page'])
})
test('stacks measured heights without overlap', () => {
  assert.deepEqual(stackMemoCards([{ height: 80 }, { height: 320 }, { height: 40 }]).map(x => x.top), [0, 92, 424])
  assert.deepEqual(stackMemoCards([]), [])
})
test('layout preferences validate values and tolerate unavailable storage', () => {
  assert.deepEqual(getMemoLayoutPreferences({ getItem: () => 'invalid' }), { rightPosition: 'outside', overflow: 'expand' })
  assert.deepEqual(getMemoLayoutPreferences({ getItem: key => key.endsWith('memoOverflow') ? 'scroll' : 'between' }), { rightPosition: 'between', overflow: 'scroll' })
  assert.deepEqual(getMemoLayoutPreferences({ getItem() { throw Error() } }), { rightPosition: 'outside', overflow: 'expand' })
})
