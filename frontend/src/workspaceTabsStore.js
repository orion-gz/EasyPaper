// Persist only navigation and reading preferences, never document/chat contents.
export const WORKSPACE_PAGES = ['dashboard', 'library', 'chats', 'notes', 'history', 'graph']
export const tabKey = (kind, target) => `${kind}:${target}`
export const workspaceStorageKey = (origin, user, mode) =>
  `easypaper_workspace_v1:${encodeURIComponent(origin)}:${encodeURIComponent(user)}:${mode}`

export function sanitizeReading(value = {}) {
  return {
    page: Math.max(1, Math.floor(Number(value.page) || 1)),
    offset: Math.max(0, Math.min(1, Number(value.offset) || 0)),
    zoom: Math.max(0.5, Math.min(3, Number(value.zoom) || 1.5)),
    readingMode: ['original', 'translation', 'parallel'].includes(value.readingMode) ? value.readingMode : 'original',
    panel: ['chat', 'notes', 'annotations'].includes(value.panel) ? value.panel : 'chat',
    panelOpen: value.panelOpen !== false,
    outlineOpen: value.outlineOpen !== false,
    navigation: value.navigation === 'thumbnails' ? 'thumbnails' : 'outline',
    panelWidth: Math.max(300, Math.min(480, Number(value.panelWidth) || 360)),
  }
}

export function createTabsStore({ storage, key, mode = 'research', onStorageError = () => {} }) {
  let tabs = []
  let activeTabId = null
  const listeners = new Set()
  function save() {
    try {
      storage.setItem(key, JSON.stringify({ version: 1, activeTabId, tabs: tabs.map(({ id, kind, target, title, reading, route }) => ({ id, kind, target, title, reading, route })) }))
    } catch (error) { onStorageError(error) }
  }
  function notify(change) { save(); for (const listener of listeners) listener(change) }
  function allowed(kind, target) {
    return kind === 'document' || (kind === 'page' && WORKSPACE_PAGES.includes(target) && !(mode === 'general' && target === 'graph'))
  }
  const api = {
    get tabs() { return tabs },
    get activeTabId() { return activeTabId },
    get active() { return tabs.find(tab => tab.id === activeTabId) },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    restoreWorkspace() {
      try {
        const saved = JSON.parse(storage.getItem(key))
        if (saved?.version === 1 && Array.isArray(saved.tabs)) {
          const seen = new Set()
          tabs = saved.tabs.filter(tab => {
            if (!tab || typeof tab.target !== 'string' || !tab.target || !allowed(tab.kind, tab.target)) return false
            const id = tabKey(tab.kind, tab.target)
            if (seen.has(id)) return false
            seen.add(id)
            return true
          }).map(tab => ({ id: tabKey(tab.kind, tab.target), kind: tab.kind, target: tab.target,
            title: typeof tab.title === 'string' ? tab.title : tab.target,
            reading: tab.kind === 'document' ? sanitizeReading(tab.reading) : undefined,
            route: typeof tab.route === 'string' && /^#(?:viewer\?|chat\?|compare\?|dashboard|library|chats|notes|history|graph)/.test(tab.route) ? tab.route : undefined,
          }))
          activeTabId = tabs.some(tab => tab.id === saved.activeTabId) ? saved.activeTabId : tabs[0]?.id
        }
      } catch { tabs = [] }
      if (!tabs.length) api.openTab('page', 'dashboard', 'Dashboard')
      return api.active
    },
    openTab(kind, target, title = target) {
      if (!allowed(kind, target)) throw new Error('Unsupported workspace tab')
      const id = tabKey(kind, target)
      let tab = tabs.find(item => item.id === id)
      if (!tab) {
        tab = { id, kind, target, title }
        const index = tabs.findIndex(item => item.id === activeTabId)
        tabs.splice(index + 1, 0, tab)
      } else if (title) tab.title = title
      activeTabId = id
      tab.status = undefined
      notify()
      return tab
    },
    activateTab(id) {
      const tab = tabs.find(item => item.id === id)
      if (!tab) return null
      activeTabId = id
      if (tab.status === 'complete') tab.status = undefined
      notify()
      return tab
    },
    closeTab(id) {
      const index = tabs.findIndex(tab => tab.id === id)
      if (index < 0) return api.active
      tabs.splice(index, 1)
      if (activeTabId === id) activeTabId = (tabs[index] || tabs[index - 1])?.id || null
      if (!tabs.length) return api.openTab('page', 'dashboard', 'Dashboard')
      notify()
      return api.active
    },
    reorderTabs(id, beforeId) {
      if (id === beforeId) return
      const index = tabs.findIndex(tab => tab.id === id)
      if (index < 0) return
      const [tab] = tabs.splice(index, 1)
      const destination = tabs.findIndex(item => item.id === beforeId)
      tabs.splice(destination < 0 ? tabs.length : destination, 0, tab)
      notify()
    },
    update(id, patch) {
      const tab = tabs.find(item => item.id === id)
      if (!tab) return
      const normalized = { ...patch, ...(patch.reading ? { reading: sanitizeReading(patch.reading) } : {}) }
      const changed = Object.keys(normalized).filter(key => JSON.stringify(tab[key]) !== JSON.stringify(normalized[key]))
      if (!changed.length) return
      Object.assign(tab, normalized)
      notify(changed.every(key => key === 'reading') ? 'reading' : 'tabs')
    },
    save,
  }
  return api
}
