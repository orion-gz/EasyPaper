import test from 'node:test'
import assert from 'node:assert/strict'
import { createTabsStore, sanitizeReading, workspaceStorageKey } from '../src/workspaceTabsStore.js'
function setup(saved, options = {}) {
  const data = new Map(saved ? [['test', JSON.stringify(saved)]] : [])
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }
  return { store: createTabsStore({ storage, key: 'test', ...options }), data }
}
test('opens unique tabs after the active tab and selects the adjacent tab on close', () => {
  const { store } = setup()
  store.restoreWorkspace()
  store.openTab('document', 'a', 'A.pdf')
  store.openTab('document', 'b', 'B.pdf')
  store.activateTab('document:a')
  store.openTab('page', 'library', 'Library')
  assert.deepEqual(store.tabs.map(tab => tab.id), ['page:dashboard', 'document:a', 'page:library', 'document:b'])
  store.openTab('document', 'a', 'Renamed.pdf')
  assert.equal(store.tabs.length, 4)
  assert.equal(store.active.title, 'Renamed.pdf')
  store.closeTab('document:a')
  assert.equal(store.activeTabId, 'page:library')
  store.reorderTabs('document:b', 'page:dashboard')
  assert.equal(store.tabs[0].id, 'document:b')
  for (const tab of [...store.tabs]) store.closeTab(tab.id)
  assert.equal(store.activeTabId, 'page:dashboard')
})
test('restores reading preferences and excludes streams, drafts and caches from storage', () => {
  const { store, data } = setup()
  store.restoreWorkspace()
  store.openTab('document', 'a', 'A')
  store.update('document:a', { reading: { page: 12, zoom: 1.7, panel: 'notes', offset: 0.4 }, draft: 'private', status: 'busy', cache: 'pdf' })
  const saved = JSON.parse(data.get('test'))
  assert.equal(saved.tabs[1].draft, undefined)
  assert.equal(saved.tabs[1].status, undefined)
  const restored = setup(saved).store
  restored.restoreWorkspace()
  assert.equal(restored.active.target, 'a')
  assert.equal(restored.active.reading.page, 12)
  assert.equal(restored.active.reading.panel, 'notes')
})
test('filters invalid, duplicate and mode-incompatible tabs on restore', () => {
  const { store } = setup({ version: 1, activeTabId: 'page:graph', tabs: [null, { kind: 'page', target: 'graph' }, { kind: 'page', target: 'other' }, { kind: 'document', target: 'a' }, { kind: 'document', target: 'a' }] }, { mode: 'general' })
  store.restoreWorkspace()
  assert.equal(store.tabs.length, 1)
  assert.equal(store.activeTabId, 'document:a')
  assert.throws(() => store.openTab('page', 'graph'))
  assert.equal(sanitizeReading({ page: -4, zoom: 99 }).page, 1)
})
test('storage failure leaves an operable in-memory workspace', () => {
  let errors = 0
  const store = createTabsStore({ storage: { getItem: () => '{broken', setItem: () => { throw new Error('quota') } }, key: 'x', onStorageError: () => errors++ })
  store.restoreWorkspace()
  store.openTab('document', 'a')
  assert.equal(store.active.target, 'a')
  assert.ok(errors > 0)
  assert.notEqual(workspaceStorageKey('server', 'alice', 'research'), workspaceStorageKey('server', 'bob', 'research'))
})
