import {
  fetchLibraryAnnotations, fetchLibraryMemos,
  patchLibraryAnnotations, patchLibraryMemos,
} from './library.js'

const RESOURCE_CONFIG = {
  annotations: {
    storagePrefix: 'easypaper_annotations_',
    fetchSnapshot: fetchLibraryAnnotations,
    patchMutations: patchLibraryAnnotations,
  },
  memos: {
    storagePrefix: 'easypaper_memos_',
    fetchSnapshot: fetchLibraryMemos,
    patchMutations: patchLibraryMemos,
  },
}

const CLIENT_ID_KEY = 'easypaper_annotation_sync_client_id'
const QUEUE_PREFIX = 'easypaper_annotation_sync_queue_'
const META_PREFIX = 'easypaper_annotation_sync_meta_'

function randomId(prefix = '') {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  return `${prefix}${value}`
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

function comparableItem(item) {
  const value = { ...item }
  delete value.version
  return value
}

export function itemFingerprint(resource, pageKey, item) {
  const value = { ...comparableItem(item) }
  delete value.id
  delete value.conflict_of
  return JSON.stringify(stableValue([resource, pageKey, value]))
}

function parse(storage, key, fallback) {
  try {
    const value = JSON.parse(storage.getItem(key))
    return value ?? fallback
  } catch {
    return fallback
  }
}

function resourceKey(resource, docId) {
  return `${RESOURCE_CONFIG[resource].storagePrefix}${docId}`
}

function queueKey(resource, docId) {
  return `${QUEUE_PREFIX}${resource}_${docId}`
}

function metaKey(resource, docId) {
  return `${META_PREFIX}${resource}_${docId}`
}

export function getSyncClientId(storage = localStorage) {
  let clientId = storage.getItem(CLIENT_ID_KEY)
  if (!clientId) {
    clientId = randomId('client_')
    storage.setItem(CLIENT_ID_KEY, clientId)
  }
  return clientId
}

function flatten(data) {
  const result = new Map()
  Object.entries(data || {}).forEach(([pageKey, items]) => {
    ;(items || []).forEach(item => {
      if (item?.id) result.set(item.id, { pageKey, item })
    })
  })
  return result
}

export function normalizeResourceData(resource, data, referenceData = {}) {
  const references = new Map()
  Object.entries(referenceData || {}).forEach(([pageKey, items]) => {
    ;(items || []).forEach(item => {
      if (!item?.id) return
      const key = itemFingerprint(resource, pageKey, item)
      if (!references.has(key)) references.set(key, [])
      references.get(key).push(item.id)
    })
  })
  const used = new Set()
  let changed = false
  const normalized = {}
  Object.entries(data || {}).forEach(([pageKey, items]) => {
    if (!Array.isArray(items)) return
    normalized[pageKey] = items.filter(item => item && typeof item === 'object').map(item => {
      if (item.id) {
        used.add(item.id)
        return { ...item }
      }
      const candidates = references.get(itemFingerprint(resource, pageKey, item)) || []
      const matched = candidates.find(id => !used.has(id))
      const id = matched || randomId(resource === 'memos' ? 'memo_' : 'annotation_')
      used.add(id)
      changed = true
      return { ...item, id }
    })
  })
  return { data: normalized, changed }
}

export function ensureLocalResourceIds(resource, docId, data, storage = localStorage) {
  const normalized = normalizeResourceData(resource, data)
  if (normalized.changed) {
    storage.setItem(resourceKey(resource, docId), JSON.stringify(normalized.data))
  }
  return normalized.data
}

function readQueue(resource, docId, storage) {
  return parse(storage, queueKey(resource, docId), [])
}

function writeQueue(resource, docId, queue, storage) {
  if (queue.length) storage.setItem(queueKey(resource, docId), JSON.stringify(queue))
  else storage.removeItem(queueKey(resource, docId))
}

function enqueue(queue, mutation) {
  const index = queue.findIndex(entry => entry.item_id === mutation.item_id)
  if (index < 0) return [...queue, mutation]
  const existing = queue[index]
  if (existing.operation === 'upsert' && existing.base_version === 0 && mutation.operation === 'delete') {
    return queue.filter((_, itemIndex) => itemIndex !== index)
  }
  const next = queue.slice()
  next[index] = { ...mutation, base_version: existing.base_version }
  return next
}

export function recordLocalResourceChange(resource, docId, nextData, storage = localStorage) {
  const key = resourceKey(resource, docId)
  const previousRaw = parse(storage, key, {})
  const previous = normalizeResourceData(resource, previousRaw).data
  const normalized = normalizeResourceData(resource, nextData, previous).data
  const before = flatten(previous)
  const after = flatten(normalized)
  const meta = parse(storage, metaKey(resource, docId), { item_versions: {} })
  let queue = readQueue(resource, docId, storage)

  after.forEach(({ pageKey, item }, itemId) => {
    const old = before.get(itemId)
    if (old && JSON.stringify(stableValue(comparableItem(old.item))) === JSON.stringify(stableValue(comparableItem(item)))
        && old.pageKey === pageKey) return
    queue = enqueue(queue, {
      mutation_id: randomId('mutation_'), operation: 'upsert', item_id: itemId,
      page_key: pageKey, base_version: Number(meta.item_versions?.[itemId] || 0), item,
    })
  })
  before.forEach(({ pageKey }, itemId) => {
    if (after.has(itemId)) return
    queue = enqueue(queue, {
      mutation_id: randomId('mutation_'), operation: 'delete', item_id: itemId,
      page_key: pageKey, base_version: Number(meta.item_versions?.[itemId] || 0),
    })
  })
  storage.setItem(key, JSON.stringify(normalized))
  writeQueue(resource, docId, queue, storage)
  return normalized
}

function overlayPending(snapshotData, queue) {
  const data = Object.fromEntries(Object.entries(snapshotData || {}).map(([key, items]) => [key, [...items]]))
  queue.forEach(mutation => {
    Object.keys(data).forEach(pageKey => {
      data[pageKey] = data[pageKey].filter(item => item.id !== mutation.item_id)
      if (!data[pageKey].length) delete data[pageKey]
    })
    if (mutation.operation === 'upsert') {
      data[mutation.page_key] ||= []
      data[mutation.page_key].push(mutation.item)
    }
  })
  return data
}

function seedUpgradeQueue(resource, localData, snapshot, queue) {
  const local = flatten(localData)
  const server = flatten(snapshot.data)
  const tombstones = snapshot.tombstones || {}
  let next = queue
  local.forEach(({ pageKey, item }, itemId) => {
    if (tombstones[itemId]) return
    const remote = server.get(itemId)
    if (remote && JSON.stringify(stableValue(comparableItem(remote.item))) === JSON.stringify(stableValue(comparableItem(item)))) return
    if (next.some(entry => entry.item_id === itemId)) return
    next = enqueue(next, {
      mutation_id: randomId('mutation_'), operation: 'upsert', item_id: itemId,
      page_key: pageKey, base_version: 0, item,
    })
  })
  return next
}

function requireSnapshot(value) {
  if (!value || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) {
    throw new Error('Invalid annotation sync snapshot')
  }
  return value
}

export async function syncResource(resource, docId, options = {}) {
  const storage = options.storage || localStorage
  const config = options.config || RESOURCE_CONFIG[resource]
  const key = resourceKey(resource, docId)
  const localRaw = parse(storage, key, {})
  const snapshot = requireSnapshot(await config.fetchSnapshot(docId))
  const normalized = normalizeResourceData(resource, localRaw, snapshot.data || {})
  let local = normalized.data
  const tombstones = snapshot.tombstones || {}
  Object.keys(local).forEach(pageKey => {
    local[pageKey] = local[pageKey].filter(item => !tombstones[item.id])
    if (!local[pageKey].length) delete local[pageKey]
  })
  let queue = readQueue(resource, docId, storage)
  const meta = parse(storage, metaKey(resource, docId), null)
  if (!meta) queue = seedUpgradeQueue(resource, local, snapshot, queue)
  writeQueue(resource, docId, queue, storage)

  let latest = snapshot
  const sentIds = new Set(queue.map(item => item.mutation_id))
  if (queue.length) {
    latest = requireSnapshot(await config.patchMutations(docId, {
      client_id: getSyncClientId(storage), mutations: queue,
    }, { keepalive: options.keepalive === true }))
    queue = readQueue(resource, docId, storage).filter(item => !sentIds.has(item.mutation_id))
    writeQueue(resource, docId, queue, storage)
  }
  const merged = overlayPending(latest.data || {}, queue)
  storage.setItem(key, JSON.stringify(merged))
  storage.setItem(metaKey(resource, docId), JSON.stringify({
    revision: latest.revision || 0,
    item_versions: latest.item_versions || {},
    tombstones: latest.tombstones || {},
  }))
  return {
    data: merged,
    snapshot: latest,
    conflicts: (latest.results || []).filter(result => result.conflict_copy || result.delete_conflict_preserved),
  }
}

export async function syncDocumentAnnotations(docId, options = {}) {
  const [annotations, memos] = await Promise.all([
    syncResource('annotations', docId, options),
    syncResource('memos', docId, options),
  ])
  return { annotations, memos }
}

export function hasPendingAnnotationSync(docId, storage = localStorage) {
  return ['annotations', 'memos'].some(resource => readQueue(resource, docId, storage).length > 0)
}
