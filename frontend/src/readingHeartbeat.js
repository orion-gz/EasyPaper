// A reader may be visible while keyboard focus remains on the workspace tab bar.
export function isReadingWindowActive(win = window) {
  const doc = win.document
  if (doc.body?.dataset.workspaceInactive === 'true' || doc.visibilityState !== 'visible') return false
  try {
    if (win.parent !== win) {
      return !win.frameElement?.hidden && win.parent.document.visibilityState === 'visible' && win.parent.document.hasFocus()
    }
  } catch { return false }
  return doc.hasFocus()
}

// Settle the previous context before changing documents/categories or hiding it.
// This also preserves visits shorter than the periodic heartbeat interval.
export function createReadingClock({ now = () => Date.now(), record }) {
  let previous = null
  let since = now()
  return {
    update(context) {
      const at = now()
      if (previous) {
        const ms = Math.max(0, Math.min(at, previous.until) - since)
        if (ms) for (const docId of previous.docIds) record(docId, previous.category, ms)
      }
      since = at
      previous = context
    },
  }
}

// One key per record avoids read/modify/write races across browser windows.
// The shell owns delivery so removing a document iframe cannot cancel its retry.
export function createReadingOutbox({ storage, username, send, onSaved = () => {}, onRename = () => {}, uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}` }) {
  let prefix = `easypaper_reading_time:${encodeURIComponent(username)}:`
  const memory = new Map()
  const inFlight = new Map()
  function persist(entry) {
    memory.set(entry.requestId, entry)
    try { storage.setItem(prefix + entry.requestId, JSON.stringify(entry)) } catch {}
  }
  function entries() {
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (!key?.startsWith(prefix)) continue
        try {
          const item = JSON.parse(storage.getItem(key))
          if (item?.requestId && item.docId && Number.isInteger(item.seconds) && item.seconds > 0 && item.seconds <= 120) memory.set(item.requestId, item)
        } catch {}
      }
    } catch {}
    return [...memory.values()]
  }
  return {
    get username() { return username },
    rename(nextUsername) {
      const pending = entries()
      const oldPrefix = prefix
      username = nextUsername
      onRename(nextUsername)
      prefix = `easypaper_reading_time:${encodeURIComponent(username)}:`
      for (const entry of pending) {
        persist(entry)
        if (oldPrefix !== prefix) { try { storage.removeItem(oldPrefix + entry.requestId) } catch {} }
      }
    },
    record(docId, category, seconds) {
      for (let remaining = seconds; remaining > 0;) {
        const amount = Math.min(120, remaining)
        persist({ requestId: uuid(), docId, category, seconds: amount, day: new Date().toISOString().slice(0, 10) })
        remaining -= amount
      }
    },
    flush({ keepalive = false } = {}) {
      return Promise.all(entries().map(entry => {
        if (inFlight.has(entry.requestId)) return inFlight.get(entry.requestId)
        const pending = Promise.resolve().then(() => send(entry.docId, entry.seconds, entry.category, { keepalive, requestId: entry.requestId, day: entry.day }))
          .then(result => {
            if (result === true || result === 'discard') {
              memory.delete(entry.requestId)
              try { storage.removeItem(prefix + entry.requestId) } catch {}
              if (result === true) onSaved()
            }
          }).catch(() => {}).finally(() => inFlight.delete(entry.requestId))
        inFlight.set(entry.requestId, pending)
        return pending
      }))
    },
  }
}
