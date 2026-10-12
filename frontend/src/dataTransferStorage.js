const DOC_PREFIXES = [
  'easypaper_annotations_', 'easypaper_memos_all_hidden_', 'easypaper_memos_',
  'easypaper_chat_quote_images_', 'easypaper_suggested_questions_',
  'easypaper_annotation_sync_queue_annotations_', 'easypaper_annotation_sync_queue_memos_',
  'easypaper_annotation_sync_meta_annotations_', 'easypaper_annotation_sync_meta_memos_',
]

export function portableKey(key) {
  return (key.startsWith('easypaper_') || ['trans-pane-width', 'trans-pane-collapsed'].includes(key))
    && !/password|token|secret|api_key|credential|annotation_sync_client_id/.test(key.toLowerCase())
}

export function collectBrowserData(storage = localStorage) {
  return Object.fromEntries(Array.from({ length: storage.length }, (_, i) => storage.key(i))
    .filter(key => key && portableKey(key)).map(key => [key, storage.getItem(key)]))
}

const ID_FIELDS = new Set(['docId', 'doc_id', 'paperId', 'paper_id', 'sessionId', 'session_id',
  'requestId', 'target', 'activeTabId', 'id', 'folder_id', 'parent_id', 'doc_ids', 'docIds'])

function remap(value, ids, field = '') {
  if (Array.isArray(value)) return value.map(item => remap(item, ids, field))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [ids[key] || key, remap(item, ids, key)]))
  if (typeof value !== 'string') return value
  if (field === 'route' && /^#(?:viewer|chat|compare)\?/.test(value)) {
    const [hash, query] = value.split('?')
    const params = new URLSearchParams(query)
    for (const name of ['id', 'ids']) {
      if (params.has(name)) params.set(name, params.get(name).split(',').map(id => ids[id] || id).join(','))
    }
    return `${hash}?${params}`
  }
  if (!ID_FIELDS.has(field)) return value
  if (ids[value]) return ids[value]
  if (value.startsWith('document:') && ids[value.slice(9)]) return `document:${ids[value.slice(9)]}`
  return value
}

export function prepareBrowserRestore(data, ids, username, origin) {
  const result = {}
  for (const [originalKey, raw] of Object.entries(data)) {
    if (!portableKey(originalKey) || typeof raw !== 'string') continue
    let key = originalKey
    const prefix = DOC_PREFIXES.find(prefix => key.startsWith(prefix))
    if (prefix) {
      const id = ids[key.slice(prefix.length)]
      if (!id) continue
      key = prefix + id
    } else if (key.startsWith('easypaper_workspace_v1:')) {
      const mode = key.split(':').at(-1)
      if (!['research', 'general'].includes(mode)) continue
      key = `easypaper_workspace_v1:${encodeURIComponent(origin)}:${encodeURIComponent(username)}:${mode}`
    } else if (key.startsWith('easypaper_reading_time:')) {
      const requestId = ids[key.split(':').at(-1)] || globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
      key = `easypaper_reading_time:${encodeURIComponent(username)}:${requestId}`
    }
    let value = raw
    try {
      let parsed = remap(JSON.parse(raw), ids, key === 'easypaper_library_favorites' ? 'docIds' : '')
      if (key.startsWith('easypaper_reading_time:')) parsed.requestId = key.split(':').at(-1)
      if (key === 'easypaper_reading_heartbeat_offline_queue') parsed = parsed.filter(item => {
        const payload = item.payload || item
        return Object.values(ids).includes(payload.paperId) && Object.values(ids).includes(payload.sessionId)
      })
      if (key === 'easypaper_library_favorites') parsed = parsed.filter(id => Object.values(ids).includes(id))
      value = JSON.stringify(parsed)
    } catch { /* Plain string settings are valid. */ }
    result[key] = value
  }
  return result
}

export function restoreBrowserData(data, storage = localStorage) {
  const previous = new Map()
  try {
    for (const [key, value] of Object.entries(data)) {
      previous.set(key, storage.getItem(key))
      if (key === 'easypaper_library_favorites') {
        const existing = JSON.parse(storage.getItem(key) || '[]')
        storage.setItem(key, JSON.stringify([...new Set([...existing, ...JSON.parse(value)])]))
      } else if (key === 'easypaper_reading_heartbeat_offline_queue') {
        const items = [...JSON.parse(storage.getItem(key) || '[]'), ...JSON.parse(value)]
        const unique = new Map(items.map(item => {
          const payload = item.payload || item
          return [`${payload.sessionId}:${payload.version}:${item.type || 'heartbeat'}`, item]
        }))
        storage.setItem(key, JSON.stringify([...unique.values()]))
      } else storage.setItem(key, value)
    }
  } catch (error) {
    // Free every touched slot before restoring larger original values. Otherwise
    // new entries can consume the space needed by the rollback itself.
    for (const key of previous.keys()) storage.removeItem(key)
    for (const [key, value] of previous) {
      if (value !== null) storage.setItem(key, value)
    }
    throw error
  }
}

