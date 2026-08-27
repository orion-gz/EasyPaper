import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hasPendingAnnotationSync, normalizeResourceData,
  recordLocalResourceChange, syncResource,
} from '../src/annotationSync.js'


class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)) }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

function snapshot(data = {}, extras = {}) {
  return {
    data, updated_at: null, revision: 0, item_versions: {}, tombstones: {},
    ...extras,
  }
}

test('기존 ID 없는 항목을 fingerprint로 서버 항목과 매칭한다', () => {
  const local = { page_1: [{ type: 'highlight', text: 'same', startOffset: 1, endOffset: 5 }] }
  const server = { page_1: [{ id: 'server-id', type: 'highlight', text: 'same', startOffset: 1, endOffset: 5 }] }
  const result = normalizeResourceData('annotations', local, server)
  assert.equal(result.data.page_1[0].id, 'server-id')
})

test('로컬 변경은 즉시 저장되고 오프라인 큐에 유지된 뒤 재전송된다', async () => {
  const storage = new MemoryStorage()
  const saved = recordLocalResourceChange('memos', 'doc', {
    page_1: [{ content: 'offline memo', x: 10, y: 20 }],
  }, storage)
  assert.ok(saved.page_1[0].id)
  assert.equal(JSON.parse(storage.getItem('easypaper_memos_doc')).page_1[0].content, 'offline memo')
  assert.equal(hasPendingAnnotationSync('doc', storage), true)

  const failingConfig = {
    fetchSnapshot: async () => snapshot(),
    patchMutations: async () => { throw new Error('offline') },
  }
  await assert.rejects(syncResource('memos', 'doc', { storage, config: failingConfig }), /offline/)
  assert.equal(hasPendingAnnotationSync('doc', storage), true)

  let sent
  const onlineConfig = {
    fetchSnapshot: async () => snapshot(),
    patchMutations: async (_docId, payload) => {
      sent = payload.mutations
      const item = payload.mutations[0].item
      return snapshot({ page_1: [item] }, {
        revision: 1, item_versions: { [item.id]: 1 },
        results: [{ mutation_id: payload.mutations[0].mutation_id, applied: true }],
      })
    },
  }
  await syncResource('memos', 'doc', { storage, config: onlineConfig })
  assert.equal(sent[0].operation, 'upsert')
  assert.equal(hasPendingAnnotationSync('doc', storage), false)
})

test('최초 업그레이드는 서버와 로컬의 합집합을 저장한다', async () => {
  const local = { page_1: [{ type: 'highlight', text: 'shared', startOffset: 0, endOffset: 6 }] }
  const storage = new MemoryStorage({ easypaper_annotations_doc: JSON.stringify(local) })
  const serverData = { page_1: [
    { id: 'shared-id', type: 'highlight', text: 'shared', startOffset: 0, endOffset: 6 },
    { id: 'remote-id', type: 'underline', text: 'remote', startOffset: 8, endOffset: 14 },
  ] }
  let patchCalls = 0
  const config = {
    fetchSnapshot: async () => snapshot(serverData, {
      revision: 2, item_versions: { 'shared-id': 1, 'remote-id': 2 },
    }),
    patchMutations: async () => { patchCalls += 1 },
  }
  const result = await syncResource('annotations', 'doc', { storage, config })
  assert.equal(patchCalls, 0)
  assert.deepEqual(result.data.page_1.map(item => item.id), ['shared-id', 'remote-id'])
})

test('최초 이관 중 같은 ID의 다른 내용은 stale upsert로 전송한다', async () => {
  const storage = new MemoryStorage({
    easypaper_memos_doc: JSON.stringify({ page_1: [{ id: 'memo', content: 'local' }] }),
  })
  let mutation
  const config = {
    fetchSnapshot: async () => snapshot({ page_1: [{ id: 'memo', content: 'server' }] }, {
      revision: 1, item_versions: { memo: 1 },
    }),
    patchMutations: async (_docId, payload) => {
      mutation = payload.mutations[0]
      return snapshot({ page_1: [
        { id: 'memo', content: 'server' },
        { id: 'copy', conflict_of: 'memo', content: 'local' },
      ] }, { revision: 2, item_versions: { memo: 1, copy: 2 },
        results: [{ mutation_id: payload.mutations[0].mutation_id, conflict_copy: true }] })
    },
  }
  const result = await syncResource('memos', 'doc', { storage, config })
  assert.equal(mutation.base_version, 0)
  assert.deepEqual(result.data.page_1.map(item => item.content), ['server', 'local'])
  assert.equal(result.conflicts.length, 1)
})

test('서버 tombstone은 오래된 로컬 항목의 부활을 막는다', async () => {
  const storage = new MemoryStorage({
    easypaper_annotations_doc: JSON.stringify({ page_1: [{ id: 'deleted', text: 'old' }] }),
  })
  let patched = false
  const config = {
    fetchSnapshot: async () => snapshot({}, {
      revision: 3, item_versions: { deleted: 3 }, tombstones: { deleted: { version: 3, page_key: 'page_1' } },
    }),
    patchMutations: async () => { patched = true },
  }
  const result = await syncResource('annotations', 'doc', { storage, config })
  assert.deepEqual(result.data, {})
  assert.equal(patched, false)
})
