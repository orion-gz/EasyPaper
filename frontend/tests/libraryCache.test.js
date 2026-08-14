import assert from 'node:assert/strict'
import test from 'node:test'

import { deleteLibraryDoc, fetchLibrary, invalidateLibraryGetCache } from '../src/library.js'

test('성공한 mutation 뒤 공유 GET 캐시를 무효화한다', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return {
      ok: true,
      async json() {
        return { documents: [{ id: `call-${calls}` }] }
      },
    }
  }

  try {
    invalidateLibraryGetCache()
    const first = await fetchLibrary()
    const second = await fetchLibrary()
    assert.equal(calls, 1)
    assert.deepEqual(second, first)

    await deleteLibraryDoc('doc-1')
    const refreshed = await fetchLibrary()
    assert.equal(calls, 3)
    assert.equal(refreshed.documents[0].id, 'call-3')
  } finally {
    globalThis.fetch = originalFetch
    invalidateLibraryGetCache()
  }
})
