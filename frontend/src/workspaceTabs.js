import { createTabsStore, tabKey, WORKSPACE_PAGES, workspaceStorageKey } from './workspaceTabsStore.js'
import { t } from './i18n.js'
import { icon } from './icons.js'
import './styles/workspace-tabs.css'

// The legacy reader's DOM IDs and module globals are scoped to one same-origin
// browsing context per document. The host owns navigation, auth and persistence.
export function createWorkspaceTabs(adapter) {
  const $ = id => document.getElementById(id)
  const shell = document.createElement('div')
  shell.id = 'tab-workspace'
  const main = document.createElement('div')
  main.className = 'tab-workspace-main'
  const topnav = document.querySelector('.workspace-topnav')
  const sidebar = $('app-sidebar')
  sidebar.querySelector('[data-page=notes]')?.after(sidebar.querySelector('[data-page=history]'))
  if (window.innerWidth < 1440 && localStorage.getItem('easypaper_sidebar_collapsed') === null) {
    sidebar.classList.add('collapsed')
    document.body.classList.add('sidebar-collapsed')
  }
  const library = $('library-screen')
  const compare = $('compare-screen')
  const outlet = document.createElement('div')
  outlet.id = 'workspace-tab-panel'
  outlet.setAttribute('role', 'tabpanel')
  outlet.tabIndex = -1
  $('workspace-page-title').hidden = true
  const controls = document.createElement('div')
  controls.className = 'workspace-tab-controls'
  const tablist = document.createElement('div')
  tablist.className = 'workspace-tab-list'
  tablist.setAttribute('role', 'tablist')
  tablist.setAttribute('aria-label', t('navigation:tabs.label'))
  controls.append(tablist)
  topnav.prepend(controls)
  shell.append(sidebar, main)
  main.append(topnav, outlet)
  document.body.append(shell)
  outlet.append(library, compare, $('chat-drawer'))
  const tabResize = new ResizeObserver(() => {
    if (!shell.hidden) tablist.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  tabResize.observe(tablist)
  shell.hidden = true
  document.body.classList.add('has-tab-workspace')

  let store
  let scope
  let generation = 0
  let saveWarningShown = false
  let transition = Promise.resolve()
  let frames = new Map()
  let pageScroll = new Map()
  let initializedPages = new Set()
  const scopes = new Map()
  const allFrames = () => [...scopes.values()].flatMap(value => [...value.frames])
  let visibleId = null
  function syncScale() {
    const scale = Number(document.documentElement.style.zoom) || 1
    shell.style.setProperty('--workspace-ui-scale', scale)
    for (const [, record] of allFrames()) {
      const runtime = record.frame.contentWindow?.__easypaperDocument
      runtime?.syncScale(scale)
      runtime?.syncAppearance(document.body.classList.contains('light-theme'), adapter.locale())
    }
  }
  const scaleObserver = new MutationObserver(syncScale)
  scaleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  syncScale()
  const icons = { dashboard: 'home', library: 'bookOpen', chats: 'messageCircle', notes: 'fileText', history: 'clock', graph: 'network' }
  function title(tab) { return tab.kind === 'page' ? adapter.pageLabel(tab.target) : tab.title }
  function report(error) { adapter.toast(error?.message || t('navigation:tabs.loadError'), 'error') }
  function enqueue(action) {
    const result = transition.then(action)
    transition = result.catch(report)
    return result
  }
  function snapshotFrames() {
    for (const [id, record] of allFrames()) {
      const runtime = record.frame.contentWindow?.__easypaperDocument
      if (runtime?.ready) record.store.update(id, { reading: runtime.snapshot(), title: runtime.title() })
    }
  }
  function flushFrame(record, runtime) {
    // Keep the iframe alive until all saves finish when the tab is closed.
    const pending = Promise.all([record.pendingFlush, runtime.flush()])
    record.pendingFlush = pending
    const clear = () => { if (record.pendingFlush === pending) record.pendingFlush = null }
    pending.then(clear, error => { clear(); report(error) })
    return pending
  }
  async function leaveCurrent() {
    const record = frames.get(visibleId)
    if (record) {
      const runtime = record.frame.contentWindow?.__easypaperDocument
      if (runtime?.ready) {
        flushFrame(record, runtime)
        store.update(visibleId, { reading: runtime.snapshot(), title: runtime.title() })
        await runtime.setActive(false)
      }
      record.frame.hidden = true
    } else if (visibleId) {
      const page = document.querySelector('.workspace-page.active')
      if (page) pageScroll.set(visibleId, page.scrollTop)
      Promise.resolve(adapter.flushPage()).catch(report)
    }
  }
  function render() {
    const focusedId = tablist.contains(document.activeElement) ? document.activeElement.closest('[data-tab-id]')?.dataset.tabId : null
    tablist.replaceChildren()
    for (const [index, tab] of store.tabs.entries()) {
      const item = document.createElement('div')
      item.className = 'workspace-tab' + (tab.id === store.activeTabId ? ' active' : '')
      item.dataset.tabId = tab.id
      item.draggable = true
      const button = document.createElement('button')
      button.type = 'button'
      button.id = `workspace-tab-${encodeURIComponent(tab.id)}`
      button.setAttribute('role', 'tab')
      if (index < 9) button.setAttribute('aria-keyshortcuts', `Control+${index + 1} Meta+${index + 1}`)
      button.setAttribute('aria-selected', String(tab.id === store.activeTabId))
      button.setAttribute('aria-controls', outlet.id)
      button.tabIndex = tab.id === store.activeTabId ? 0 : -1
      button.title = title(tab)
      button.innerHTML = icon(tab.kind === 'document' ? 'fileText' : icons[tab.target], 16)
      const label = document.createElement('span')
      label.className = 'workspace-tab-title'
      label.textContent = title(tab)
      button.append(label)
      if (tab.status) {
        const status = document.createElement('span')
        status.className = `workspace-tab-status ${tab.status}`
        status.setAttribute('aria-label', { busy: t('navigation:tabs.busy'), complete: t('navigation:tabs.complete'), error: t('navigation:tabs.error') }[tab.status])
        status.textContent = tab.status === 'busy' ? '◌' : tab.status === 'error' ? '!' : '•'
        button.append(status)
      }
      button.addEventListener('click', () => enqueue(() => activate(tab.id)))
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'workspace-tab-close'
      close.textContent = '×'
      close.setAttribute('aria-label', t('navigation:tabs.close', { title: title(tab) }))
      if (tab.id === store.activeTabId) close.setAttribute('aria-keyshortcuts', 'Control+W Meta+W')
      close.addEventListener('click', () => enqueue(() => closeTab(tab.id)))
      item.append(button, close)
      item.addEventListener('dragstart', event => event.dataTransfer.setData('text/x-easypaper-tab', tab.id))
      item.addEventListener('dragover', event => event.preventDefault())
      item.addEventListener('drop', event => {
        event.preventDefault()
        store.reorderTabs(event.dataTransfer.getData('text/x-easypaper-tab'), tab.id)
      })
      tablist.append(item)
    }
    if (store.active) outlet.setAttribute('aria-labelledby', `workspace-tab-${encodeURIComponent(store.activeTabId)}`)
    const active = tablist.querySelector('[aria-selected="true"]')
    if (focusedId) tablist.querySelector(`[data-tab-id="${CSS.escape(focusedId)}"] [role="tab"]`)?.focus({ preventScroll: true })
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    sidebar.querySelectorAll('[data-page]').forEach(button => {
      button.classList.toggle('active', button.dataset.page === (store.active?.kind === 'document' ? 'library' : store.active?.target))
    })
  }
  function writeHistory(tab, push) {
    const hash = tab.route || (tab.kind === 'document' ? `#viewer?id=${encodeURIComponent(tab.target)}` : `#${tab.target}`)
    if (push && location.hash !== hash) history.pushState({ screen: tab.kind === 'document' ? 'viewer' : 'library', page: tab.target, docId: tab.kind === 'document' ? tab.target : undefined }, '', hash)
  }
  function makeFrame(tab) {
    const existing = frames.get(tab.id)
    if (existing) return existing
    const frame = document.createElement('iframe')
    frame.className = 'workspace-document-frame'
    frame.dataset.documentId = tab.target
    frame.title = title(tab)
    frame.hidden = true
    const record = { frame, busy: false, closed: false, status: null, store, ownerFrames: frames }
    frames.set(tab.id, record)
    const url = new URL(location.href)
    url.searchParams.set('documentRuntime', '1')
    url.searchParams.set('workspaceMode', adapter.mode())
    url.hash = tab.route || `#viewer?id=${encodeURIComponent(tab.target)}`
    // Keyboard events inside a document iframe do not bubble to the host.
    frame.addEventListener('load', () => {
      frame.contentDocument?.addEventListener('keydown', event => {
        if (record.closed || record.store !== store || visibleId !== tab.id) return
        handleTabShortcut(event)
      })
    })
    frame.src = url.href
    outlet.append(frame)
    return record
  }
  async function activate(id, { push = true, route } = {}) {
    const tab = store.tabs.find(item => item.id === id)
    if (!tab) return
    if (visibleId !== id) await leaveCurrent()
    store.activateTab(id)
    if (route) store.update(id, { route })
    const token = ++generation
    visibleId = id
    library.classList.remove('active')
    compare.classList.remove('active')
    adapter.hideChatDrawer()
    for (const record of frames.values()) record.frame.hidden = true
    if (tab.kind === 'document') {
      const record = makeFrame(tab)
      record.closed = false
      record.frame.hidden = false
      const runtime = record.frame.contentWindow?.__easypaperDocument
      if (runtime?.ready) {
        // PDF resumption belongs to this document, not the navigation queue.
        runtime.setActive(true).then(async () => {
          if (token !== generation || record.closed) return
          if (route) await runtime.navigate(route)
        }).catch(report)
      }
    } else {
      library.classList.add('active')
      const restored = initializedPages.has(tab.id) && document.getElementById(`page-${tab.target}`)?.dataset.renderedMode === adapter.mode()
      const ownerStore = store
      const ownerPages = initializedPages
      const mode = adapter.mode()
      const isCurrent = () => token === generation && ownerStore === store && !shell.hidden
      // Loading must never occupy the navigation queue. Only the current
      // activation may restore scroll or open a route-specific overlay.
      Promise.resolve(adapter.showPage(tab.target, restored, isCurrent)).then(async () => {
        if (!isCurrent()) return
        ownerPages.add(tab.id)
        const page = document.getElementById(`page-${tab.target}`)
        if (page) {
          page.dataset.renderedMode = mode
          page.scrollTop = pageScroll.get(tab.id) || 0
        }
        if (tab.route?.startsWith('#chat?')) await adapter.openChat(new URLSearchParams(tab.route.split('?')[1]).get('id'), isCurrent)
        if (isCurrent() && tab.route?.startsWith('#compare?')) await adapter.openCompare(tab.route, isCurrent)
      }).catch(error => { if (isCurrent()) report(error) })
    }
    writeHistory(tab, push)
    render()
  }
  async function closeTab(id) {
    const active = store.activeTabId === id
    const record = frames.get(id)
    const runtime = record?.frame.contentWindow?.__easypaperDocument
    if (active) await leaveCurrent()
    else if (runtime?.ready) flushFrame(record, runtime)
    store.closeTab(id)
    if (record) {
      record.closed = true
      record.frame.hidden = true
      const release = () => {
        if (record.closed && !record.pendingFlush && !runtime?.busy()) {
          record.frame.remove()
          record.ownerFrames.delete(id)
        }
      }
      if (record.pendingFlush) record.pendingFlush.then(release, release)
      else release()
    }
    if (active) { visibleId = null; await activate(store.activeTabId) }
    render()
    tablist.querySelector('[aria-selected="true"]')?.focus()
  }
  tablist.addEventListener('keydown', event => {
    const item = event.target.closest('[data-tab-id]')
    if (!item) return
    const index = store.tabs.findIndex(tab => tab.id === item.dataset.tabId)
    let next
    if (event.key === 'ArrowRight') next = (index + 1) % store.tabs.length
    if (event.key === 'ArrowLeft') next = (index + store.tabs.length - 1) % store.tabs.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = store.tabs.length - 1
    if (event.key === 'Delete') { event.preventDefault(); enqueue(() => closeTab(item.dataset.tabId)); return }
    if (next !== undefined) {
      event.preventDefault()
      if (event.altKey) {
        if (event.key === 'ArrowLeft' && index === 0 || event.key === 'ArrowRight' && index === store.tabs.length - 1) return
        const destination = event.key === 'ArrowRight' ? index + 2 : next
        store.reorderTabs(item.dataset.tabId, store.tabs[destination]?.id)
      }
      else enqueue(async () => { await activate(store.tabs[next].id); tablist.querySelector('[aria-selected="true"]')?.focus() })
    }
  })
  function handleTabShortcut(event) {
    if (event.defaultPrevented || event.isComposing
      || event.ctrlKey === event.metaKey || event.altKey || shell.hidden || !store?.tabs.length) return
    const sourceDocument = event.target?.ownerDocument || document
    const modalSelector = '.modal-overlay:not(.hidden), dialog[open]'
    if (document.querySelector(modalSelector) || sourceDocument.querySelector(modalSelector)) return
    const key = event.key.toLowerCase()
    if (!event.shiftKey && key === 'w') {
      event.preventDefault()
      if (!event.repeat) enqueue(() => closeTab(store.activeTabId))
      return
    }
    if (!event.shiftKey && key === 'b') {
      event.preventDefault()
      if (!event.repeat) adapter.toggleSidebar()
      return
    }
    if (event.shiftKey && key === 'm') {
      event.preventDefault()
      if (!event.repeat) adapter.toggleMode()
      return
    }
    const cycling = event.key === 'Tab'
    const index = !event.shiftKey && /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1
    if (!cycling && !store.tabs[index]) return
    event.preventDefault()
    const direction = event.shiftKey ? -1 : 1
    enqueue(async () => {
      if (shell.hidden || !store?.tabs.length) return
      const current = store.tabs.findIndex(tab => tab.id === store.activeTabId)
      const target = store.tabs[cycling ? (current + direction + store.tabs.length) % store.tabs.length : index]
      if (!target) return
      if (target.id !== store.activeTabId) await activate(target.id)
      tablist.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true })
    })
  }
  document.addEventListener('keydown', handleTabShortcut)
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f' || shell.hidden) return
    const runtime = frames.get(visibleId)?.frame.contentWindow?.__easypaperDocument
    if (runtime?.ready) { event.preventDefault(); runtime.find?.() }
  })
  document.addEventListener('easypaper:locale-changed', () => store && render())
  const appearance = new MutationObserver(() => {
    for (const record of frames.values()) record.frame.contentWindow?.__easypaperDocument?.syncAppearance?.(document.body.classList.contains('light-theme'), adapter.locale())
  })
  appearance.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  document.addEventListener('easypaper:locale-changed', () => {
    for (const [, record] of allFrames()) record.frame.contentWindow?.__easypaperDocument?.syncAppearance?.(document.body.classList.contains('light-theme'), adapter.locale())
  })
  window.addEventListener('pagehide', snapshotFrames)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) snapshotFrames()
    const runtime = frames.get(visibleId)?.frame.contentWindow?.__easypaperDocument
    runtime?.setActive(!document.hidden)
  })
  // Only trusted child runtimes can publish status or request navigation.
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.channel !== 'easypaper-document') return
    const entry = allFrames().find(([, record]) => record.frame.contentWindow === event.source)
    if (!entry) return
    const [id, record] = entry
    const { type, payload } = event.data
    if (type === 'navigate') { api.route(payload, { push: true }); return }
    if (type === 'auth-expired') { adapter.authExpired(); return }
    if (type === 'refresh') {
      enqueue(async () => {
        if (record.closed || record.store !== store || id !== visibleId) return
        const runtime = record.frame.contentWindow?.__easypaperDocument
        if (!runtime?.ready) return
        const context = await runtime.prepareRefresh()
        if (!context) return
        try {
          // Drafts and quotes stay in memory; only reading preferences are persisted.
          record.refreshContext = context
          record.store.update(id, { reading: context.reading })
          record.frame.contentWindow.location.reload()
        } catch (error) {
          delete record.refreshContext
          runtime.cancelRefresh()
          throw error
        }
      })
      return
    }
    if (type === 'title') {
      record.frame.title = String(payload || '')
      record.store.update(id, { title: record.frame.title })
    }
    if (type === 'ready') {
      const runtime = record.frame.contentWindow.__easypaperDocument
      runtime.syncScale(Number(document.documentElement.style.zoom) || 1)
      const tab = record.store.tabs.find(tab => tab.id === id)
      const refreshContext = record.refreshContext
      runtime.restore(refreshContext?.reading || tab?.reading).then(async () => {
        if (refreshContext) runtime.restoreDraft(refreshContext.draft)
        else await runtime.navigate(tab?.route || '')
        delete record.refreshContext
        await runtime.setActive(record.store === store && id === visibleId && !document.hidden)
        await runtime.syncAppearance?.(document.body.classList.contains('light-theme'), adapter.locale())
        if (refreshContext && record.store === store && id === visibleId && !document.hidden) {
          record.frame.contentDocument?.getElementById('viewer-refresh-btn')?.focus({ preventScroll: true })
        }
      }).catch(report)
      if (tab) record.store.update(id, { title: runtime.title() })
    }
    if (type === 'snapshot') record.store.update(id, { reading: payload })
    if (type === 'status') {
      const finished = record.busy && !payload.busy
      record.busy = payload.busy
      const unviewed = record.store !== store || id !== visibleId
      const status = payload.error ? 'error' : payload.busy ? 'busy' : unviewed && (finished || record.status === 'complete') ? 'complete' : undefined
      if (record.status !== status) { record.status = status; record.store.update(id, { status }) }
      if (record.closed && !record.pendingFlush && !payload.busy) { record.frame.remove(); record.ownerFrames.delete(id) }
    }
    if (type === 'unavailable') enqueue(async () => {
      adapter.toast(t('navigation:tabs.unavailable'), 'warning')
      if (record.store === store) await closeTab(id)
      else { record.store.closeTab(id); record.frame.remove(); record.ownerFrames.delete(id) }
    })
  })
  const api = {
    async start(user, mode) {
      const nextScope = workspaceStorageKey(location.origin, user, mode)
      if (scope !== nextScope) {
        if (store) { await leaveCurrent(); snapshotFrames() }
        for (const record of frames.values()) record.frame.hidden = true
        scope = nextScope
        visibleId = null
        const previous = scopes.get(scope)
        if (previous) {
          ;({ store, frames, initializedPages, pageScroll } = previous)
        } else {
          frames = new Map()
          initializedPages = new Set()
          pageScroll = new Map()
          store = createTabsStore({ storage: localStorage, key: scope, mode, onStorageError: () => {
            if (!saveWarningShown) { saveWarningShown = true; adapter.toast(t('navigation:tabs.storageError'), 'warning') }
          } })
          store.restoreWorkspace()
          store.subscribe(change => { if (change !== 'reading') render() })
          scopes.set(scope, { store, frames, initializedPages, pageScroll })
        }
      }
      shell.hidden = false
      render()
      const hash = location.hash
      if (hash && hash !== '#') await api.route(hash, { push: false })
      else await enqueue(() => activate(store.activeTabId, { push: true }))
    },
    openPage(page, { pushState = true } = {}) {
      return enqueue(async () => {
        if (!WORKSPACE_PAGES.includes(page) || (adapter.mode() === 'general' && page === 'graph')) page = 'dashboard'
        await leaveCurrent()
        const tab = store.openTab('page', page, adapter.pageLabel(page))
        // Explicit sidebar navigation returns to the page root.
        store.update(tab.id, { route: `#${page}` })
        visibleId = null
        await activate(tab.id, { push: pushState })
      })
    },
    openDocument(doc, push = true, route) {
      return enqueue(async () => {
        await leaveCurrent()
        const tab = store.openTab('document', doc.id, doc.metadata?.title || doc.filename || doc.id)
        if (route) store.update(tab.id, { route })
        visibleId = null
        await activate(tab.id, { push, route })
      })
    },
    route(hash, { push = false } = {}) {
      if (typeof hash !== 'string' || !hash.startsWith('#')) return Promise.resolve()
      const [path, query] = hash.slice(1).split('?')
      const params = new URLSearchParams(query)
      if (path === 'viewer' && params.get('id')) {
        const id = params.get('id')
        return api.openDocument({ id, filename: store.tabs.find(tab => tab.id === tabKey('document', id))?.title || t('navigation:tabs.loading') }, push, hash)
      }
      if (path === 'chat' || path === 'compare') {
        return enqueue(async () => {
          await leaveCurrent()
          const tab = store.openTab('page', 'chats', adapter.pageLabel('chats'))
          store.update(tab.id, { route: hash })
          visibleId = null
          await activate(tab.id, { push })
        })
      }
      const subview = params.get('subview') || params.get('view') || (path === 'heatmap' ? 'heatmap' : null)
      if (subview) { sessionStorage.setItem('easypaper_graph_subview', subview); initializedPages.delete('page:graph') }
      return api.openPage(path === 'heatmap' ? 'graph' : path, { pushState: push })
    },
    hide() {
      ++generation
      snapshotFrames()
      for (const [, record] of allFrames()) record.frame.remove()
      scopes.clear()
      frames.clear()
      shell.hidden = true
      visibleId = null
      scope = null
    },
    invalidate() { initializedPages.clear() },
    get active() { return store?.active },
  }
  return api
}
