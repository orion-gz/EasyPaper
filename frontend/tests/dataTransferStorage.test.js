import test from 'node:test'
import assert from 'node:assert/strict'
import { collectBrowserData, prepareBrowserRestore, restoreBrowserData } from '../src/dataTransferStorage.js'

function storage(initial = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    get length() { return entries.size }, key: index => [...entries.keys()][index],
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key),
  }
}

test('collect settings without credentials or unrelated application storage', () => {
  const saved = storage({ easypaper_ui_locale: 'ko', easypaper_token: 'secret', other_app: 'private', 'trans-pane-width': '620' })
  assert.deepEqual(collectBrowserData(saved), { easypaper_ui_locale: 'ko', 'trans-pane-width': '620' })
})

test('remap document notes, favorites and workspace state across accounts and origins', () => {
  const result = prepareBrowserRestore({
    easypaper_memos_old: '{"1":[{"text":"old is a word"}]}',
    easypaper_memos_foreign: '{}',
    easypaper_library_favorites: '["old","foreign"]',
    'easypaper_workspace_v1:oldOrigin:alice:research': '{"activeTabId":"document:old","tabs":[{"target":"old"}]}',
    easypaper_api_key: 'secret',
  }, { old: 'new' }, 'bob', 'http://new')
  assert.equal(result.easypaper_memos_new, '{"1":[{"text":"old is a word"}]}')
  assert.equal(result.easypaper_library_favorites, '["new"]')
  assert.equal(result['easypaper_workspace_v1:http%3A%2F%2Fnew:bob:research'], '{"activeTabId":"document:new","tabs":[{"target":"new"}]}')
  assert.equal(result.easypaper_memos_foreign, undefined)
  assert.equal(result.easypaper_api_key, undefined)
})

test('merge favorites and roll back browser writes on quota failure', () => {
  const saved = storage({ easypaper_ui_locale: 'en', easypaper_library_favorites: '["existing"]' })
  restoreBrowserData({ easypaper_library_favorites: '["new"]' }, saved)
  assert.equal(saved.getItem('easypaper_library_favorites'), '["existing","new"]')
  const set = saved.setItem
  saved.setItem = (key, value) => { if (key === 'fail') throw new Error('quota'); set(key, value) }
  assert.throws(() => restoreBrowserData({ easypaper_ui_locale: 'ko', fresh: 'value', fail: 'value' }, saved), /quota/)
  assert.equal(saved.getItem('easypaper_ui_locale'), 'en')
  assert.equal(saved.getItem('fresh'), null)
})

test('preserve note text and remap routes and reading receipts', () => {
  const restored = prepareBrowserRestore({
    easypaper_memos_old: '{"1":[{"text":"old"}]}',
    'easypaper_workspace_v1:origin:alice:research': '{"tabs":[{"target":"old","route":"#viewer?id=old&page=2"}]}',
    'easypaper_reading_time:alice:request': '{"requestId":"request","docId":"old","seconds":60}',
  }, { old: 'new', request: 'new-request' }, 'bob', 'origin')
  assert.equal(restored.easypaper_memos_new, '{"1":[{"text":"old"}]}')
  assert.match(restored['easypaper_workspace_v1:origin:bob:research'], /#viewer\?id=new&page=2/)
  assert.equal(JSON.parse(restored['easypaper_reading_time:bob:new-request']).requestId, 'new-request')
})
