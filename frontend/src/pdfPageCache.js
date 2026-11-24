/**
 * Persistent & In-Memory PDF Page Bitmap + Dimension Cache
 *
 * - L1: In-memory Map LRU (up to 120 rendered page bitmaps as Blob) for 0ms synchronous-like lookup
 * - L2: IndexedDB ('easypaper_pdf_page_cache_v1') with 150MB global LRU capacity cap
 * - Dimension cache: localStorage ('easypaper_pdf_dims_<docId>') so reopening a document
 *   computes all page viewports in 0ms without any PDF.js worker getPage() round-trips.
 */

const DB_NAME = 'easypaper_pdf_page_cache_v1'
const DB_VERSION = 1
const STORE_NAME = 'pages'
const DIMS_STORAGE_PREFIX = 'easypaper_pdf_dims_'

export const MAX_L1_ENTRIES = 120
export const MAX_CACHE_BYTES = 150 * 1024 * 1024 // 150 MB

const l1Cache = new Map()
let dbPromise = null
let evictionInFlight = null

export function makePageCacheKey(docId, pageNum, width, height) {
  return `${docId}:${pageNum}:${Math.round(width)}x${Math.round(height)}`
}

function touchL1(key, entry) {
  if (l1Cache.has(key)) l1Cache.delete(key)
  entry.lastAccessedAt = Date.now()
  l1Cache.set(key, entry)
  while (l1Cache.size > MAX_L1_ENTRIES) {
    const oldestKey = l1Cache.keys().next().value
    if (oldestKey === undefined) break
    l1Cache.delete(oldestKey)
  }
}

function touchL2Timestamp(key, record) {
  void openCacheDB().then(db => {
    if (!db) return
    try {
      const writeTx = db.transaction(STORE_NAME, 'readwrite')
      writeTx.objectStore(STORE_NAME).put(record)
    } catch {}
  })
}

function openCacheDB() {
  if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' })
          store.createIndex('docId', 'docId', { unique: false })
          store.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => {
          try { db.close() } catch {}
          dbPromise = null
        }
        db.onclose = () => {
          dbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

export async function getCachedPageBlob(docId, pageNum, width, height) {
  if (!docId || !pageNum || !width || !height) return null
  const key = makePageCacheKey(docId, pageNum, width, height)
  const memEntry = l1Cache.get(key)
  if (memEntry && memEntry.blob) {
    touchL1(key, memEntry)
    touchL2Timestamp(key, memEntry)
    return memEntry.blob
  }

  const db = await openCacheDB()
  if (!db) return null

  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(key)
      req.onsuccess = () => {
        const record = req.result
        if (!record || !record.blob) {
          resolve(null)
          return
        }
        const now = Date.now()
        record.lastAccessedAt = now
        touchL1(key, record)
        // Best-effort async timestamp touch in L2
        try {
          const writeTx = db.transaction(STORE_NAME, 'readwrite')
          writeTx.objectStore(STORE_NAME).put(record)
        } catch {}
        resolve(record.blob)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function putCachedPageBlob(docId, pageNum, width, height, blob) {
  if (!docId || !pageNum || !width || !height || !blob) return false
  const key = makePageCacheKey(docId, pageNum, width, height)
  const sizeBytes = Number(blob.size) || 0
  if (sizeBytes <= 0 || sizeBytes > MAX_CACHE_BYTES) return false

  const record = {
    key,
    docId: String(docId),
    pageNum: Number(pageNum),
    width: Math.round(width),
    height: Math.round(height),
    sizeBytes,
    lastAccessedAt: Date.now(),
    blob,
  }
  touchL1(key, record)

  const db = await openCacheDB()
  if (!db) return true

  const stored = await new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.put(record)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })

  if (stored) {
    void evictIfNeeded(MAX_CACHE_BYTES)
  }
  return stored
}

export async function evictIfNeeded(maxBytes = MAX_CACHE_BYTES) {
  if (evictionInFlight) return evictionInFlight
  evictionInFlight = (async () => {
    const db = await openCacheDB()
    if (!db) return 0
    const records = await new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const items = []
        const req = store.openCursor()
        req.onsuccess = event => {
          const cursor = event.target.result
          if (cursor) {
          const val = cursor.value
          const l1Entry = l1Cache.get(val.key)
          items.push({
            key: val.key,
            sizeBytes: Number(val.sizeBytes) || Number(val.blob?.size) || 0,
            lastAccessedAt: Math.max(
              Number(val.lastAccessedAt) || 0,
              Number(l1Entry?.lastAccessedAt) || 0,
            ),
          })
            cursor.continue()
          } else {
            resolve(items)
          }
        }
        req.onerror = () => resolve([])
      } catch {
        resolve([])
      }
    })

    let totalBytes = 0
    for (const item of records) totalBytes += item.sizeBytes
    if (totalBytes <= maxBytes) return 0

    // Oldest accessed first
    records.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
    const keysToDelete = []
    for (const item of records) {
      if (totalBytes <= maxBytes) break
      keysToDelete.push(item.key)
      totalBytes -= item.sizeBytes
      l1Cache.delete(item.key)
    }

    if (!keysToDelete.length) return 0
    await new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        for (const key of keysToDelete) store.delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
    return keysToDelete.length
  })().finally(() => {
    evictionInFlight = null
  })
  return evictionInFlight
}

export async function drawCachedPageToCanvas(docId, pageNum, targetCanvas, width, height) {
  if (!docId || !targetCanvas) return false
  const blob = await getCachedPageBlob(docId, pageNum, width, height)
  if (!blob) return false

  try {
    targetCanvas.width = Math.round(width)
    targetCanvas.height = Math.round(height)
    const ctx = targetCanvas.getContext('2d')
    if (!ctx) return false
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob)
      ctx.drawImage(bitmap, 0, 0, targetCanvas.width, targetCanvas.height)
      bitmap.close?.()
      return true
    }
    if (typeof Image === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const objectUrl = URL.createObjectURL(blob)
      try {
        await new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            ctx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height)
            resolve()
          }
          img.onerror = reject
          img.src = objectUrl
        })
        return true
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    }
  } catch {
    return false
  }
  return false
}

async function canvasToBlob(canvas) {
  if (!canvas) return null
  if (typeof canvas.convertToBlob === 'function') {
    try {
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
    } catch {
      try {
        return await canvas.convertToBlob({ type: 'image/png' })
      } catch {
        return null
      }
    }
  }
  if (typeof canvas.toBlob === 'function') {
    const webpBlob = await new Promise(resolve => {
      try {
        canvas.toBlob(b => resolve(b || null), 'image/webp', 0.82)
      } catch {
        resolve(null)
      }
    })
    if (webpBlob) return webpBlob
    return new Promise(resolve => {
      try {
        canvas.toBlob(b => resolve(b || null), 'image/png')
      } catch {
        resolve(null)
      }
    })
  }
  return null
}

export function scheduleStoreRenderedPageCanvas(docId, pageNum, sourceCanvas, width, height) {
  if (!docId || !pageNum || !sourceCanvas || !width || !height) return
  const key = makePageCacheKey(docId, pageNum, width, height)
  if (l1Cache.has(key)) return

  const task = async () => {
    if (l1Cache.has(key)) return
    if (!sourceCanvas.width || !sourceCanvas.height) return
    if (sourceCanvas.width !== Math.round(width) || sourceCanvas.height !== Math.round(height)) return
    const blob = await canvasToBlob(sourceCanvas)
    if (!blob) return
    if (!sourceCanvas.width || !sourceCanvas.height) return
    if (sourceCanvas.width !== Math.round(width) || sourceCanvas.height !== Math.round(height)) return
    await putCachedPageBlob(docId, pageNum, width, height, blob)
  }

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { void task() }, { timeout: 1200 })
  } else {
    setTimeout(() => { void task() }, 32)
  }
}

export function getCachedDocDimensions(docId) {
  if (!docId || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${DIMS_STORAGE_PREFIX}${docId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.pages) return null
    const map = new Map()
    for (const [pageStr, dim] of Object.entries(parsed.pages)) {
      const pageNum = Number(pageStr)
      if (Number.isInteger(pageNum) && pageNum >= 1 && dim && Number(dim.width) > 0 && Number(dim.height) > 0) {
        map.set(pageNum, { width: Number(dim.width), height: Number(dim.height) })
      }
    }
    return map.size > 0 ? map : null
  } catch {
    return null
  }
}

export function setCachedDocDimensions(docId, dimensionsMap) {
  if (!docId || !dimensionsMap || !(dimensionsMap instanceof Map) || dimensionsMap.size === 0) return
  if (typeof localStorage === 'undefined') return
  try {
    const pages = {}
    for (const [pageNum, dim] of dimensionsMap.entries()) {
      if (dim && Number(dim.width) > 0 && Number(dim.height) > 0) {
        pages[pageNum] = {
          width: Math.round(Number(dim.width) * 100) / 100,
          height: Math.round(Number(dim.height) * 100) / 100,
        }
      }
    }
    localStorage.setItem(`${DIMS_STORAGE_PREFIX}${docId}`, JSON.stringify({
      updatedAt: Date.now(),
      pages,
    }))
  } catch {}
}

export async function clearDocumentPageCache(docId) {
  if (!docId) {
    l1Cache.clear()
    return
  }
  const prefix = `${docId}:`
  for (const key of [...l1Cache.keys()]) {
    if (key.startsWith(prefix)) l1Cache.delete(key)
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(`${DIMS_STORAGE_PREFIX}${docId}`)
    } catch {}
  }
  const db = await openCacheDB()
  if (!db) return
  await new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const index = store.index('docId')
      const req = index.openKeyCursor(IDBKeyRange.only(String(docId)))
      req.onsuccess = event => {
        const cursor = event.target.result
        if (cursor) {
          store.delete(cursor.primaryKey)
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function clearAllPageCaches() {
  l1Cache.clear()
  const db = await openCacheDB()
  if (!db) return
  await new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export function _getL1CacheSizeForTest() {
  return l1Cache.size
}
