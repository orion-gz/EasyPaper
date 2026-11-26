export const UI_STYLE_STORAGE_KEY = 'easypaper_ui_style_v1'
export const UI_STYLES = Object.freeze(['precision', 'editorial'])
export const DEFAULT_UI_STYLE = 'precision'

export function normalizeUiStyle(value) {
  return UI_STYLES.includes(value) ? value : DEFAULT_UI_STYLE
}

export function loadUiStyle(storage = globalThis.localStorage) {
  try {
    return normalizeUiStyle(storage?.getItem(UI_STYLE_STORAGE_KEY))
  } catch {
    return DEFAULT_UI_STYLE
  }
}

export function saveUiStyle(styleId, storage = globalThis.localStorage) {
  const normalized = normalizeUiStyle(styleId)
  storage?.setItem(UI_STYLE_STORAGE_KEY, normalized)
  if (typeof window !== 'undefined') {
    syncDocumentUiStyle(normalized)
    window.dispatchEvent(new CustomEvent('easypaper:ui-style-changed', { detail: { style: normalized } }))
  }
  return normalized
}

export function applyUiStyle(target, styleId) {
  if (!target) return normalizeUiStyle(styleId)
  const normalized = normalizeUiStyle(styleId)
  target.dataset.uiStyle = normalized
  if (target.ownerDocument && target === target.ownerDocument.body) {
    target.ownerDocument.documentElement.dataset.uiStyle = normalized
  }
  return normalized
}

export function syncDocumentUiStyle(styleId = loadUiStyle(), doc = globalThis.document) {
  if (!doc?.body) return normalizeUiStyle(styleId)
  const normalized = applyUiStyle(doc.body, styleId)
  doc.querySelectorAll?.('iframe.workspace-document-frame').forEach(frame => {
    try {
      const childBody = frame.contentDocument?.body
      if (childBody) applyUiStyle(childBody, normalized)
    } catch {
      // Ignore cross-context frames before load completes
    }
  })
  return normalized
}

const syncedDocs = new WeakMap()

export function initUiStyleSync(doc = globalThis.document) {
  if (!doc || typeof window === 'undefined') return () => {}
  if (syncedDocs.has(doc)) {
    syncDocumentUiStyle(loadUiStyle(), doc)
    return syncedDocs.get(doc)
  }
  const sync = () => syncDocumentUiStyle(loadUiStyle(), doc)
  sync()
  const onStorage = event => {
    if (event.key === null || event.key === UI_STYLE_STORAGE_KEY) sync()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('easypaper:ui-style-changed', sync)
  const cleanup = () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('easypaper:ui-style-changed', sync)
    syncedDocs.delete(doc)
  }
  syncedDocs.set(doc, cleanup)
  return cleanup
}
