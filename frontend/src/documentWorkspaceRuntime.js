import { findReadingAnchor } from './readingAnchor.js'
import { installFocusReading } from './focusReading.js'
import { createReadingTrail } from './readingTrail.js'
import { readerFeatureEnabled, onReaderPreferences } from './readerPreferences.js'
import { applyTheme, THEME_TOKEN_NAMES } from './themes/themeEngine.js'
import { installReaderTools } from './documentReaderTools.js'
import { sanitizeReading } from './workspaceTabsStore.js'
import { t, changeLocale, getLocale } from './i18n.js'
import { icon } from './icons.js'
import './styles/workspace-tabs.css'

export const isDocumentRuntime = window.parent !== window && new URLSearchParams(location.search).get('documentRuntime') === '1'
export function notifyWorkspace(type, payload) {
  if (isDocumentRuntime) window.parent.postMessage({ channel: 'easypaper-document', type, payload }, location.origin)
}

export function installDocumentRuntime(adapter) {
  const $ = id => document.getElementById(id)
  document.body.classList.add('document-workspace-runtime')
  const viewer = $('viewer-screen')
  viewer.classList.add('document-workspace-loading')
  const scroll = $('viewer-scroll-container')
  scroll.tabIndex = 0
  scroll.setAttribute('role', 'region')
  scroll.setAttribute('aria-label', t('navigation:tabs.content'))
  scroll.dataset.i18nAriaLabel = 'navigation:tabs.content'
  const sidebar = $('chat-sidebar')
  const outline = $('outline-sidebar')
  viewer.append(sidebar, $('chat-resizer'))
  let active = true
  let panel = 'chat'
  let navigation = 'outline'
  let desiredOpen = { panel: false, outline: false }
  let restoring = false
  let generation = 0
  let error = false
  let lastStatus = ''
  let lastSnapshot = ''
  let suspendedSnapshot = null
  let snapshotTimer
  let readerTools
  const trail = createReadingTrail()
  let returning = false
  const returnButton = document.createElement('button')
  returnButton.type = 'button'; returnButton.id = 'reader-return'; returnButton.hidden = true
  const syncReturn = () => {
    returnButton.hidden = !readerFeatureEnabled('referenceReturn') || !trail.last
    if (trail.last) returnButton.textContent = t('viewer:comfort.returnPage', { page: trail.last.page })
  }
  const stopReturnPreferences = onReaderPreferences(() => {
    if (!readerFeatureEnabled('referenceReturn')) trail.clear()
    syncReturn()
  })
  returnButton.addEventListener('click', async () => {
    if (returning || !readerFeatureEnabled('referenceReturn')) return
    const previous = trail.pop()
    if (!previous) return
    returning = true; returnButton.disabled = true
    try { await runtime.restore(previous, { force: true }) }
    finally { returning = false; returnButton.disabled = false; syncReturn(); scroll.focus({ preventScroll: true }) }
  })
  let refreshing = false
  const resumeNotice = document.createElement('button')
  resumeNotice.type = 'button'; resumeNotice.id = 'reader-resume-notice'; resumeNotice.hidden = true
  let resumeTimer
  resumeNotice.addEventListener('click', () => { adapter.goToPage(1); resumeNotice.hidden = true })
  onReaderPreferences(() => { if (!readerFeatureEnabled('restoreReading')) resumeNotice.hidden = true })
  const initialDefaultZoom = localStorage.getItem('easypaper_default_zoom') || '1.5'

  const tabs = document.createElement('div')
  tabs.className = 'document-panel-tabs'
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', t('navigation:tabs.tools'))
  const list = document.createElement('div')
  list.id = 'document-resource-list'
  list.className = 'document-resource-list'
  list.setAttribute('role', 'tabpanel')
  list.hidden = true
  sidebar.prepend(tabs)
  sidebar.append(list)
  function showResources() {
    list.replaceChildren()
    const resources = panel === 'notes' ? adapter.memos() : adapter.annotations()
    let count = 0
    for (const [pageKey, items] of Object.entries(resources || {})) {
      const page = Number(pageKey.replace(/^(page|section)_/, ''))
      if (!Array.isArray(items) || !Number.isInteger(page)) continue
      for (const item of items) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'document-resource'
        const label = document.createElement('small')
        label.textContent = t('viewer:pageLabel', { page })
        const text = document.createElement('span')
        text.textContent = item.content || item.sentenceText || item.text || item.quote || t('navigation:tabs.annotation')
        button.append(label, text)
        button.addEventListener('click', () => adapter.navigateAnnotation({ page, memoId: panel === 'notes' ? item.id : null, kind: item.type || null, startOffset: item.startOffset ?? item.start_offset ?? null, endOffset: item.endOffset ?? item.end_offset ?? null, quote: panel === 'notes' && item.id ? null : item.type ? null : item.sentenceText || item.text || '', occurrence: 1 }))
        list.append(button)
        count++
      }
    }
    if (!count) {
      const empty = document.createElement('p')
      empty.className = 'document-resources-empty'
      empty.textContent = panel === 'notes' ? t('navigation:tabs.noNotes') : t('navigation:tabs.noAnnotations')
      list.append(empty)
    }
  }
  function setPanel(next) {
    panel = next
    sidebar.dataset.toolPanel = next
    tabs.querySelectorAll('[role="tab"]').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.panel === panel))
      button.tabIndex = button.dataset.panel === panel ? 0 : -1
    })
    list.hidden = panel === 'chat'
    if (panel !== 'chat') showResources()
    publishSnapshot()
  }
  for (const [name, label] of [['chat', t('navigation:tabs.chat')], ['notes', t('navigation:tabs.notes')], ['annotations', t('navigation:tabs.annotations')]]) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.panel = name
    button.dataset.i18n = `navigation:tabs.${name}`
    button.id = `document-tool-${name}`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-controls', name === 'chat' ? 'chat-messages' : list.id)
    button.textContent = label
    button.addEventListener('click', () => setPanel(name))
    tabs.append(button)
  }
  tabs.addEventListener('keydown', event => {
    const buttons = [...tabs.querySelectorAll('button')]
    const index = buttons.indexOf(document.activeElement)
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].click(); buttons[next].focus()
  })

  const outlineTabs = document.createElement('div')
  outlineTabs.className = 'document-outline-tabs'
  const thumbnails = document.createElement('div')
  thumbnails.id = 'document-thumbnails'
  thumbnails.className = 'document-thumbnails'
  thumbnails.hidden = true
  outline.append(thumbnails)
  outline.querySelector('.outline-title').replaceWith(outlineTabs)
  let thumbnailObserver
  function setNavigation(next) {
    navigation = next
    $('outline-content').hidden = next !== 'outline'
    thumbnails.hidden = next !== 'thumbnails'
    outlineTabs.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.navigation === next)))
    if (next === 'thumbnails' && !thumbnails.childElementCount) {
      thumbnailObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.target.dataset.loaded) continue
          entry.target.dataset.loaded = 'true'
          adapter.thumbnail(Number(entry.target.dataset.page), entry.target.querySelector('canvas')).catch(() => { delete entry.target.dataset.loaded })
        }
      }, { root: thumbnails, rootMargin: '160px' })
      for (let page = 1; page <= adapter.state.totalPages; page++) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.page = page
        button.setAttribute('aria-label', t('viewer:pageLabel', { page }))
        const canvas = document.createElement('canvas')
        const label = document.createElement('span')
        label.textContent = String(page)
        button.append(label, canvas)
        button.addEventListener('click', () => adapter.goToPage(page))
        thumbnails.append(button)
        thumbnailObserver.observe(button)
      }
    }
    publishSnapshot()
  }
  for (const name of ['outline', 'thumbnails']) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.navigation = name
    button.dataset.i18n = `navigation:tabs.${name}`
    button.textContent = { outline: t('navigation:tabs.outline'), thumbnails: t('navigation:tabs.thumbnails') }[name]
    button.addEventListener('click', () => setNavigation(name))
    outlineTabs.append(button)
  }
  $('back-btn').remove()
  const floating = $('floating-scroll-nav')
  floating.append($('viewer-topbar').querySelector('.page-display'))
  const zoomGroup = $('viewer-topbar').querySelector('.view-group')
  floating.append(zoomGroup, $('viewer-focus-toggle'))
  const fullscreen = document.createElement('button')
  fullscreen.type = 'button'
  fullscreen.className = 'floating-nav-btn'
  fullscreen.dataset.i18nAriaLabel = 'navigation:tabs.fullscreen'
  fullscreen.setAttribute('aria-label', t('navigation:tabs.fullscreen'))
  fullscreen.innerHTML = icon('expand', 16)
  fullscreen.addEventListener('click', async () => {
    try {
      const host = window.parent.document
      if (host.fullscreenElement) await host.exitFullscreen()
      else await host.getElementById('workspace-tab-panel').requestFullscreen()
    } catch { adapter.toast(t('navigation:tabs.fullscreenUnavailable'), 'warning') }
  })
  floating.append(fullscreen, resumeNotice, returnButton)
  readerTools = installReaderTools(adapter, { scroll, toolbar: $('viewer-topbar').querySelector('.topbar-right'), floating, changed: publishSnapshot })
  const refreshButton = document.createElement('button')
  refreshButton.type = 'button'
  refreshButton.id = 'viewer-refresh-btn'
  refreshButton.className = 'icon-btn'
  refreshButton.innerHTML = icon('refreshCw', 16)
  refreshButton.dataset.i18nAriaLabel = refreshButton.dataset.i18nTitle = 'navigation:tabs.refresh'
  refreshButton.setAttribute('aria-label', t('navigation:tabs.refresh'))
  refreshButton.title = t('navigation:tabs.refresh')
  refreshButton.addEventListener('click', () => notifyWorkspace('refresh'))
  $('viewer-topbar').querySelector('.topbar-right').prepend(refreshButton)
  const refreshResources = () => { if (active && panel !== 'chat') showResources() }
  document.addEventListener('easypaper:resources-changed', refreshResources)
  const refreshStorage = event => { if (event.key?.includes(adapter.state.sessionId)) refreshResources() }
  window.addEventListener('storage', refreshStorage)

  function snapshot() {
    if (!active && suspendedSnapshot) return suspendedSnapshot
    const viewportTop = scroll.getBoundingClientRect().top
    const pages = scroll.firstElementChild?.matches('.page-pair')
      ? scroll.children : scroll.querySelectorAll('.page-pair, .article-unit')
    const pair = findReadingAnchor(pages, viewportTop)
    const page = pair ? Number(pair.dataset.page ?? pair.dataset.unitIndex) || adapter.state.currentPage : adapter.state.currentPage
    const offset = pair ? Math.max(0, Math.min(1, (viewportTop - pair.getBoundingClientRect().top) / pair.getBoundingClientRect().height)) : 0
    return sanitizeReading({ page, offset, translationCollapsed: adapter.translationCollapsed?.(), fitWidth: readerTools?.fit() ?? false, zoom: adapter.state.zoom, panel, panelOpen: !sidebar.classList.contains('hidden'), navigation, panelWidth: parseFloat(sidebar.style.width) || 360 })
  }
  function publishSnapshot() {
    if (restoring || refreshing || !window.__easypaperDocument?.ready || !active) return
    clearTimeout(snapshotTimer)
    snapshotTimer = setTimeout(() => {
      const value = snapshot()
      const serialized = JSON.stringify(value)
      if (serialized !== lastSnapshot) { lastSnapshot = serialized; notifyWorkspace('snapshot', value) }
    }, 200)
  }
  scroll.addEventListener('scroll', publishSnapshot, { passive: true })
  document.addEventListener('click', publishSnapshot)
  document.addEventListener('input', publishSnapshot)
  let previousOpen = { panel: false, outline: false }
  const updateLayout = () => {
    const narrow = window.parent.innerWidth < 1100
    const panelWidth = sidebar.classList.contains('hidden') || narrow ? 0 : sidebar.offsetWidth + 14
    const outlineWidth = outline.classList.contains('hidden') || narrow ? 0 : 220
    viewer.style.setProperty('--document-panel-space', `${panelWidth}px`)
    viewer.style.setProperty('--document-outline-space', `${outlineWidth}px`)
    viewer.style.setProperty('--document-panel-width', `${sidebar.offsetWidth || 360}px`)
    readerTools?.refresh()
  }
  const panelResize = new ResizeObserver(updateLayout)
  panelResize.observe(sidebar)
  const panelObserver = new MutationObserver(() => {
    updateLayout()
    if (!restoring && active) {
      desiredOpen = { panel: !sidebar.classList.contains('hidden'), outline: !outline.classList.contains('hidden') }
      if (window.parent.innerWidth < 1100 && desiredOpen.panel && desiredOpen.outline) {
        const openedOutline = !previousOpen.outline
        desiredOpen = { panel: !openedOutline, outline: openedOutline }
        adapter.setPanels(desiredOpen)
      }
      previousOpen = { ...desiredOpen }
    }
    publishSnapshot()
  })
  panelObserver.observe(sidebar, { attributes: true, attributeFilter: ['class', 'style'] })
  panelObserver.observe(outline, { attributes: true, attributeFilter: ['class'] })
  document.addEventListener('focusin', event => {
    // Background stream completion must never steal focus from another tab.
    if (!active && event.target instanceof HTMLElement) event.target.blur()
  })
  const syncViewport = () => {
    document.body.classList.toggle('document-narrow', window.parent.innerWidth < 1100)
    updateLayout()
    if (window.parent.innerWidth < 1100 && !sidebar.classList.contains('hidden') && !outline.classList.contains('hidden')) adapter.setPanels({ panel: true, outline: false })
  }
  window.addEventListener('resize', syncViewport)
  syncViewport()
  const focusReading = installFocusReading({
    floating, panels: () => ({ panel: !sidebar.classList.contains('hidden'), outline: !outline.classList.contains('hidden') }),
    translationCollapsed: adapter.translationCollapsed, setTranslationCollapsed: adapter.setTranslationCollapsed,
    restorePanels: adapter.setPanels, changed: () => { updateLayout(); publishSnapshot() },
  })
  let lastTitle = adapter.state.title
  const statusTimer = setInterval(() => {
    if (adapter.state.title !== lastTitle) { lastTitle = adapter.state.title; notifyWorkspace('title', lastTitle) }
    const busy = runtime.busy()
    const failed = error || Boolean(document.querySelector('.trans-error')) || ['failed', 'partial_failed', 'error'].includes(adapter.state.translationTaskStatus)
    const next = JSON.stringify({ busy, error: failed })
    if (next !== lastStatus) { lastStatus = next; notifyWorkspace('status', { busy, error: failed }) }
    if (active) {
      publishSnapshot()
      for (const button of thumbnails.querySelectorAll('button')) button.classList.toggle('active', Number(button.dataset.page) === adapter.state.currentPage)
    }
  }, 750)
  // Task errors are reflected in the tab as well as the original error UI.
  const errors = new MutationObserver(() => { error = Boolean(document.querySelector('.chat-error-text')); })
  errors.observe($('chat-messages'), { childList: true, subtree: true })
  const runtime = {
    ready: true,
    toggleFocusReading: () => focusReading.toggle(),
    toggleTranslation: () => adapter.setTranslationCollapsed?.(!adapter.translationCollapsed?.()),
    attention: active => adapter.attention?.(active),
    finish: () => adapter.finish?.(),
    find: () => readerTools.openFind(),
    snapshot,
    rememberReference() {
      if (returning || !active || restoring || !readerFeatureEnabled('referenceReturn')) return
      trail.remember(snapshot()); syncReturn()
    },
    title: () => adapter.state.title || adapter.state.filename,
    busy: () => Boolean(adapter.state.easyEnglishGenerating || adapter.state.chatActiveStream || adapter.state.translatingPages?.size || ['queued', 'running', 'retry_wait'].includes(adapter.state.translationTaskStatus)),
    async flush() {
      document.activeElement?.blur?.()
      await adapter.flush()
      publishSnapshot()
    },
    async prepareRefresh() {
      if (refreshing) return null
      if (runtime.busy()) { adapter.toast(t('navigation:tabs.refreshBusy'), 'info'); return null }
      refreshing = true
      refreshButton.disabled = true
      refreshButton.setAttribute('aria-busy', 'true')
      clearTimeout(snapshotTimer)
      try {
        await runtime.flush()
        // A scroll translation or chat may have started while edits were saved.
        if (runtime.busy()) {
          runtime.cancelRefresh()
          adapter.toast(t('navigation:tabs.refreshBusy'), 'info')
          return null
        }
        const reading = snapshot()
        const defaultZoom = localStorage.getItem('easypaper_default_zoom') || '1.5'
        if (defaultZoom !== initialDefaultZoom) {
          reading.zoom = sanitizeReading({ zoom: defaultZoom }).zoom
          reading.fitWidth = false
        }
        const draft = {
          text: $('chat-input').value,
          quotedText: structuredClone(adapter.state.quotedText),
          quotedImage: adapter.state.quotedImage,
          quotedImagePage: adapter.state.quotedImagePage,
        }
        viewer.inert = true
        readerTools.setActive(false)
        return { reading, draft }
      } catch (error) {
        runtime.cancelRefresh()
        throw error
      }
    },
    cancelRefresh() {
      refreshing = false
      refreshButton.disabled = false
      refreshButton.removeAttribute('aria-busy')
      viewer.inert = false
      readerTools.setActive(active)
    },
    restoreDraft(draft) {
      if (!draft) return
      Object.assign(adapter.state, { quotedText: draft.quotedText, quotedImage: draft.quotedImage, quotedImagePage: draft.quotedImagePage })
      $('chat-input').value = draft.text || ''
      $('chat-input').dispatchEvent(new Event('input', { bubbles: true }))
      const quote = typeof draft.quotedText === 'string' ? draft.quotedText : draft.quotedText?.text
      $('chat-quote-text').textContent = quote || ''
      $('chat-quote-text').classList.toggle('hidden', Boolean(draft.quotedImage))
      if (draft.quotedImage) $('chat-quote-img').src = draft.quotedImage
      else $('chat-quote-img').removeAttribute('src')
      $('chat-quote-img').classList.toggle('hidden', !draft.quotedImage)
      $('chat-quote-area').classList.toggle('hidden', !quote && !draft.quotedImage)
    },
    activateChat() { setPanel('chat'); adapter.setPanels({ panel: true, outline: false }) },
    syncScale: scale => adapter.uiScale(scale),
    async syncAppearance(light, locale) {
      document.body.classList.toggle('light-theme', light)
      const host = window.parent.document
      const computed = host.defaultView.getComputedStyle(host.body)
      applyTheme(document.body, {
        id: host.body.dataset.themeId || '', scheme: light ? 'light' : 'dark',
        tokens: Object.fromEntries(THEME_TOKEN_NAMES.map(name => [name, computed.getPropertyValue(`--${name}`).trim()])),
      })
      if (getLocale() !== locale) await changeLocale(locale)
    },
    async setActive(next) {
      if (active === next) return
      if (!next) suspendedSnapshot = snapshot()
      active = next
      focusReading.setActive(next)
      if (!next) readerTools.setActive(false)
      document.body.dataset.workspaceInactive = String(!next)
      if (next) {
        const token = ++generation
        await adapter.resume()
        // A newer activation owns rendering; an old resume must not suspend it.
        if (token !== generation || !active) return
        readerTools.setActive(true)
        if (panel !== 'chat') showResources()
        thumbnails.querySelectorAll('button').forEach(button => thumbnailObserver?.observe(button))
      } else {
        ++generation
        thumbnailObserver?.disconnect()
        thumbnails.querySelectorAll('canvas').forEach(canvas => { canvas.width = 0; canvas.height = 0; delete canvas.parentElement.dataset.loaded })
        adapter.suspend()
      }
    },
    async restore(saved, { force = false } = {}) {
      if (!force && !readerFeatureEnabled('restoreReading')) saved = null
      restoring = true
      try {
        if (saved) {
          const value = sanitizeReading(saved)
          adapter.setTranslationCollapsed?.(value.translationCollapsed)
          readerTools.restore(value.fitWidth)
          if (Math.abs(adapter.state.zoom - value.zoom) > 0.001) await adapter.zoom(value.zoom)
          setPanel(value.panel)
          setNavigation(value.navigation)
          desiredOpen = { panel: value.panelOpen, outline: false }
          sidebar.style.width = `${value.panelWidth}px`
          adapter.setPanels(desiredOpen)
          updateLayout()
          value.page = Math.min(value.page, adapter.state.totalPages)
          await readerTools.fitNow()
          adapter.goToPage(value.page)
          const pair = scroll.querySelector(`.page-pair[data-page="${value.page}"], .article-unit[data-unit-index="${value.page}"]`)
          if (pair) scroll.scrollTop += pair.offsetHeight * value.offset
          const explicitPage = new URLSearchParams(location.hash.split('?')[1]).has('page')
          if (!force && !explicitPage && (value.page > 1 || value.offset > 0)) {
            resumeNotice.textContent = `${t('viewer:comfort.resumed', { page: value.page })} · ${t('viewer:comfort.startOver')}`
            resumeNotice.hidden = false
            clearTimeout(resumeTimer); resumeTimer = setTimeout(() => { resumeNotice.hidden = true }, 8000)
          }
        } else {
          readerTools.restore(true)
          setPanel('chat'); setNavigation('outline')
          if (!readerFeatureEnabled('restoreReading')) adapter.goToPage(1)
        }
        if (window.parent.innerWidth < 1100 && desiredOpen.panel) desiredOpen.outline = false
        adapter.setPanels(desiredOpen)
      } finally {
        updateLayout()
        if (!saved) await readerTools.fitNow()
        restoring = false
        viewer.classList.remove('document-workspace-loading')
      }
    },
    async navigate(hash) {
      const params = new URLSearchParams(hash.split('?')[1])
      if (params.get('chat') === '1') { setPanel('chat'); adapter.setPanels({ panel: true, outline: false }) }
      if (params.has('page')) await adapter.navigateHash(hash)
      if (params.has('question')) {
        setPanel('chat'); adapter.setPanels({ panel: true, outline: false })
        const index = Number(params.get('question'))
        if (Number.isInteger(index) && index >= 0) {
          const question = $('chat-messages').querySelectorAll('.chat-message.user')[index]
          question?.scrollIntoView({ block: 'center', behavior: 'instant' })
          if (question) { question.tabIndex = -1; question.focus({ preventScroll: true }) }
        }
      }
    },
  }
  window.__easypaperDocument = runtime
  window.addEventListener('pagehide', () => {
    focusReading.destroy(); stopReturnPreferences(); readerTools.destroy(); document.removeEventListener('easypaper:resources-changed', refreshResources); window.removeEventListener('storage', refreshStorage)
    clearInterval(statusTimer); clearTimeout(snapshotTimer); window.removeEventListener('resize', syncViewport)
    panelResize.disconnect(); panelObserver.disconnect(); errors.disconnect(); thumbnailObserver?.disconnect()
  }, { once: true })
  notifyWorkspace('ready')
  return runtime
}
