import test from 'node:test'
import assert from 'node:assert/strict'

// Minimal mock for localStorage & IndexedDB in Node test environment
const storageMap = new Map()
globalThis.localStorage = {
  getItem: key => (storageMap.has(key) ? storageMap.get(key) : null),
  setItem: (key, val) => storageMap.set(key, String(val)),
  removeItem: key => storageMap.delete(key),
  clear: () => storageMap.clear(),
}

const idbRecords = new Map()
function createFakeIDB() {
  const makeStore = () => ({
    createIndex: () => {},
    get: key => {
      const req = {}
      queueMicrotask(() => {
        req.result = idbRecords.get(key) || undefined
        req.onsuccess?.({ target: req })
      })
      return req
    },
    put: record => {
      idbRecords.set(record.key, { ...record })
    },
    delete: key => {
      idbRecords.delete(key)
    },
    clear: () => {
      idbRecords.clear()
    },
    openCursor: () => {
      const entries = [...idbRecords.values()]
      let idx = 0
      const req = {}
      const step = () => {
        queueMicrotask(() => {
          if (idx < entries.length) {
            const value = entries[idx++]
            req.onsuccess?.({
              target: {
                result: {
                  value,
                  continue: step,
                },
              },
            })
          } else {
            req.onsuccess?.({ target: { result: null } })
          }
        })
      }
      step()
      return req
    },
    index: indexName => ({
      openKeyCursor: range => {
        const matchVal = range?._only
        const keys = [...idbRecords.values()]
          .filter(rec => (indexName === 'docId' ? rec.docId === matchVal : true))
          .map(rec => rec.key)
        let idx = 0
        const req = {}
        const step = () => {
          queueMicrotask(() => {
            if (idx < keys.length) {
              const primaryKey = keys[idx++]
              req.onsuccess?.({
                target: {
                  result: {
                    primaryKey,
                    continue: step,
                  },
                },
              })
            } else {
              req.onsuccess?.({ target: { result: null } })
            }
          })
        }
        step()
        return req
      },
    }),
  })

  return {
    open: () => {
      const req = {}
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => makeStore(),
          transaction: () => {
            const tx = {
              objectStore: () => makeStore(),
            }
            queueMicrotask(() => {
              tx.oncomplete?.()
            })
            return tx
          },
        }
        req.result = db
        req.onsuccess?.({ target: req })
      })
      return req
    },
  }
}

globalThis.IDBKeyRange = {
  only: val => ({ _only: val }),
}
globalThis.indexedDB = createFakeIDB()

const {
  makePageCacheKey,
  getCachedPageBlob,
  putCachedPageBlob,
  evictIfNeeded,
  drawCachedPageToCanvas,
  scheduleStoreRenderedPageCanvas,
  getCachedDocDimensions,
  setCachedDocDimensions,
  clearDocumentPageCache,
  clearAllPageCaches,
  _getL1CacheSizeForTest,
} = await import('../src/pdfPageCache.js')

test('stores and retrieves page bitmap blobs from L1 and L2 IndexedDB', async () => {
  await clearAllPageCaches()
  idbRecords.clear()

  const blob = new Blob([new Uint8Array(1024)], { type: 'image/webp' })
  const stored = await putCachedPageBlob('doc-alpha', 1, 892, 1262, blob)
  assert.equal(stored, true)
  assert.equal(_getL1CacheSizeForTest(), 1)
  assert.equal(idbRecords.has(makePageCacheKey('doc-alpha', 1, 892, 1262)), true)

  const hit = await getCachedPageBlob('doc-alpha', 1, 892, 1262)
  assert.ok(hit)
  assert.equal(hit.size, 1024)

  const miss = await getCachedPageBlob('doc-alpha', 2, 892, 1262)
  assert.equal(miss, null)
})

test('evicts oldest accessed entries when total size exceeds maxBytes', async () => {
  await clearAllPageCaches()
  idbRecords.clear()

  const b1 = new Blob([new Uint8Array(4000)], { type: 'image/webp' })
  const b2 = new Blob([new Uint8Array(4000)], { type: 'image/webp' })
  const b3 = new Blob([new Uint8Array(4000)], { type: 'image/webp' })

  await putCachedPageBlob('doc-lru', 1, 600, 800, b1)
  await new Promise(r => setTimeout(r, 5))
  await putCachedPageBlob('doc-lru', 2, 600, 800, b2)
  await new Promise(r => setTimeout(r, 5))
  await putCachedPageBlob('doc-lru', 3, 600, 800, b3)

  // Touch page 1 so page 2 becomes the oldest accessed
  await new Promise(r => setTimeout(r, 5))
  await getCachedPageBlob('doc-lru', 1, 600, 800)

  // Limit to 8500 bytes -> should evict 1 entry (page 2)
  const evictedCount = await evictIfNeeded(8500)
  assert.equal(evictedCount, 1)

  assert.ok(await getCachedPageBlob('doc-lru', 1, 600, 800))
  assert.equal(await getCachedPageBlob('doc-lru', 2, 600, 800), null)
  assert.ok(await getCachedPageBlob('doc-lru', 3, 600, 800))
})

test('caches and restores document page dimensions in localStorage and clears per document', async () => {
  await clearAllPageCaches()
  idbRecords.clear()
  storageMap.clear()

  const dims = new Map([
    [1, { width: 595.28, height: 841.89 }],
    [2, { width: 612, height: 792 }],
  ])
  setCachedDocDimensions('doc-dims', dims)

  const restored = getCachedDocDimensions('doc-dims')
  assert.ok(restored instanceof Map)
  assert.equal(restored.size, 2)
  assert.deepEqual(restored.get(1), { width: 595.28, height: 841.89 })
  assert.deepEqual(restored.get(2), { width: 612, height: 792 })

  await putCachedPageBlob('doc-dims', 1, 600, 800, new Blob([new Uint8Array(512)]))
  await putCachedPageBlob('doc-other', 1, 600, 800, new Blob([new Uint8Array(512)]))

  await clearDocumentPageCache('doc-dims')
  assert.equal(getCachedDocDimensions('doc-dims'), null)
  assert.equal(await getCachedPageBlob('doc-dims', 1, 600, 800), null)
  assert.ok(await getCachedPageBlob('doc-other', 1, 600, 800))
})

test('scheduleStoreRenderedPageCanvas skips zeroed or resized canvases safely and drawCachedPageToCanvas draws on 2d context', async () => {
  await clearAllPageCaches()
  idbRecords.clear()

  let toBlobCalls = 0
  const fakeCanvas = {
    width: 800,
    height: 1000,
    toBlob(cb) {
      toBlobCalls++
      cb(new Blob([new Uint8Array(256)], { type: 'image/webp' }))
    },
  }

  // Zero out canvas before idle task fires -> should skip without calling toBlob
  scheduleStoreRenderedPageCanvas('doc-race', 1, fakeCanvas, 800, 1000)
  fakeCanvas.width = 0
  fakeCanvas.height = 0
  await new Promise(r => setTimeout(r, 50))
  assert.equal(toBlobCalls, 0)
  assert.equal(await getCachedPageBlob('doc-race', 1, 800, 1000), null)

  // Valid canvas dimensions -> stores in cache
  const validCanvas = {
    width: 800,
    height: 1000,
    toBlob(cb) {
      toBlobCalls++
      cb(new Blob([new Uint8Array(256)], { type: 'image/webp' }))
    },
  }
  scheduleStoreRenderedPageCanvas('doc-race', 2, validCanvas, 800, 1000)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(toBlobCalls, 1)
  assert.ok(await getCachedPageBlob('doc-race', 2, 800, 1000))

  // Verify drawCachedPageToCanvas uses 2d context
  let drawn = false
  const prevCreateImageBitmap = globalThis.createImageBitmap
  globalThis.createImageBitmap = async () => ({
    close() {},
  })
  try {
    const targetCanvas = {
      width: 0,
      height: 0,
      getContext(type) {
        if (type !== '2d') return null
        return {
          drawImage() {
            drawn = true
          },
        }
      },
    }
    const ok = await drawCachedPageToCanvas('doc-race', 2, targetCanvas, 800, 1000)
    assert.equal(ok, true)
    assert.equal(drawn, true)
    assert.equal(targetCanvas.width, 800)
    assert.equal(targetCanvas.height, 1000)
  } finally {
    globalThis.createImageBitmap = prevCreateImageBitmap
  }
})

