import { t } from './i18n.js'
import { icon } from './icons.js'

// Tools live inside the document runtime, so queries and pointer state never
// leak into another document. PDF text is read sequentially without canvases.
export function installReaderTools(adapter, { scroll, toolbar, floating, changed }) {
  let fit = true
  let active = true
  let disposed = false
  let fitting = false
  let fitTimer
  let queryTimer
  let searchController
  let revision = 0
  let results = []
  let searching = false
  let limited = false
  let selected = -1
  let query = ''
  let pointerDown = false
  let locateRevision = 0
  let deferredFit = false
  const texts = new Map()
  const button = (id, label, content, parent, action) => {
    const element = document.createElement('button')
    element.id = id
    element.type = 'button'
    element.className = 'floating-nav-btn'
    element.setAttribute('aria-label', label)
    element.title = label
    element.innerHTML = content
    element.addEventListener('click', action)
    parent.append(element)
    return element
  }
  const fitButton = button('document-fit-width', t('navigation:tabs.fitWidth'), '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M3 4v16M21 4v16M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3"/></svg>', floating, () => {
    fit = true; scheduleFit(); changed()
  })
  fitButton.dataset.i18nAriaLabel = fitButton.dataset.i18nTitle = 'navigation:tabs.fitWidth'
  const tools = document.createElement('div')
  tools.className = 'document-pointer-tools'
  floating.prepend(tools)
  for (const [name, label, glyph] of [
    ['highlight', t('navigation:tabs.highlight'), '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'],
    ['underline', t('navigation:tabs.underline'), '<path d="M6 3v7a6 6 0 0 0 12 0V3"/><path d="M4 21h16"/>'],
    ['memo', t('navigation:tabs.memo'), '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'],
  ]) {
    const tool = button(`document-${name}-tool`, label, `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`, tools, () => adapter.annotateHoveredSentence(name))
    tool.dataset.i18nAriaLabel = tool.dataset.i18nTitle = `navigation:tabs.${name}`
  }

  function isInteracting() {
    const selection = window.getSelection()
    const focusOverlay = document.querySelector('.focus-mode-layer:not(.hidden)')
    if (focusOverlay && fit) deferredFit = true
    return Boolean(focusOverlay) || pointerDown || scroll.querySelector('.floating-memo-textarea') || document.activeElement?.closest('.floating-memo') || (selection && !selection.isCollapsed && scroll.contains(selection.anchorNode))
  }
  async function applyFit() {
    if (!fit || !active || disposed || fitting || !scroll.clientWidth) return
    // Rebuilding PDF text layers must not interrupt selection or memo editing.
    if (isInteracting()) return
    fitting = true
    try {
      const width = await adapter.pageWidth()
      if (!fit || !active || disposed || !width || isInteracting()) return
      const scrollStyle = getComputedStyle(scroll)
      const pair = scroll.querySelector('.page-pair')
      const pairStyle = pair ? getComputedStyle(pair) : null
      const translation = pair?.querySelector('.trans-page-block')
      const parallel = translation && getComputedStyle(translation).display !== 'none' && pairStyle.flexDirection !== 'column'
      const horizontal = style => style ? ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0) : 0
      const available = scroll.clientWidth - horizontal(scrollStyle) - horizontal(pairStyle) - 6 - (parallel ? parseFloat(pairStyle?.gap) || 18 : 0)
      const zoom = Math.max(0.5, Math.min(3, available / (width * (parallel ? 2 : 1))))
      if (Math.abs(adapter.state.zoom - zoom) > 0.015) await adapter.zoom(zoom)
    } catch (error) { console.warn('Document fit failed:', error) }
    finally { fitting = false; fitButton.setAttribute('aria-pressed', String(fit)); changed() }
  }
  function scheduleFit() { clearTimeout(fitTimer); fitTimer = setTimeout(applyFit, 100) }
  function manualZoom(event) {
    if (event.type === 'click' && !event.target.closest('#zoom-in-btn, #zoom-out-btn')) return
    if (event.type === 'change' && event.target.id !== 'setting-default-zoom') return
    if (event.type === 'wheel' && !event.ctrlKey) return
    if (event.type === 'touchstart' && event.touches.length < 2) return
    fit = false; clearTimeout(fitTimer); fitButton.setAttribute('aria-pressed', 'false'); changed()
  }
  document.addEventListener('click', manualZoom, true)
  document.addEventListener('change', manualZoom, true)
  scroll.addEventListener('wheel', manualZoom, { capture: true, passive: true })
  scroll.addEventListener('touchstart', manualZoom, { capture: true, passive: true })
  const pointerStart = () => { pointerDown = true; clearTimeout(fitTimer) }
  const pointerEnd = () => { pointerDown = false }
  document.addEventListener('pointerdown', pointerStart, true)
  document.addEventListener('pointerup', pointerEnd, true)
  document.addEventListener('pointercancel', pointerEnd, true)
  const focusObserver = new MutationObserver(() => {
    if (!deferredFit || !fit || document.querySelector('.focus-mode-layer:not(.hidden)')) return
    deferredFit = false
    scheduleFit()
  })
  focusObserver.observe(document.body, { childList: true })
  const resize = new ResizeObserver(scheduleFit)
  resize.observe(scroll)

  const search = document.createElement('form')
  search.id = 'document-search'
  search.className = 'document-search'
  search.hidden = true
  const input = document.createElement('input')
  input.type = 'search'
  input.setAttribute('aria-label', t('navigation:tabs.find'))
  input.dataset.i18nAriaLabel = 'navigation:tabs.find'
  const count = document.createElement('output')
  count.setAttribute('aria-live', 'polite')
  const snippet = document.createElement('div')
  snippet.className = 'document-search-snippet'
  search.append(input, count)
  button('document-search-previous', t('navigation:tabs.previousMatch'), '↑', search, () => move(-1)).dataset.i18nAriaLabel = 'navigation:tabs.previousMatch'
  button('document-search-next', t('navigation:tabs.nextMatch'), '↓', search, () => move(1)).dataset.i18nAriaLabel = 'navigation:tabs.nextMatch'
  button('document-search-close', t('navigation:tabs.closeSearch'), '×', search, () => toggle(false)).dataset.i18nAriaLabel = 'navigation:tabs.closeSearch'
  search.append(snippet)
  document.getElementById('viewer-screen').append(search)
  const findButton = button('document-find', t('navigation:tabs.find'), icon('search', 16), toolbar, () => toggle(search.hidden))
  findButton.className = 'icon-btn'
  findButton.dataset.i18nAriaLabel = findButton.dataset.i18nTitle = 'navigation:tabs.find'
  findButton.setAttribute('aria-controls', search.id)
  findButton.setAttribute('aria-expanded', 'false')
  function toggle(open) {
    search.hidden = !open
    findButton.setAttribute('aria-expanded', String(open))
    if (open) { input.focus(); input.select(); if (input.value) void runSearch() }
    else { searchController?.abort(); ++revision; ++locateRevision; clearTimeout(queryTimer); findButton.focus(); CSS.highlights?.delete('document-find') }
  }
  function showResult() {
    count.value = results.length ? `${selected + 1} / ${limited ? '≥' : ''}${results.length}` : t('navigation:tabs.noMatches')
    snippet.replaceChildren()
    const result = results[selected]
    if (!result) return
    const text = texts.get(result.page) || ''
    const mark = document.createElement('mark')
    mark.textContent = text.slice(result.offset, result.offset + query.length)
    snippet.append(`${result.page}: …${text.slice(Math.max(0, result.offset - 35), result.offset)}`, mark, `${text.slice(result.offset + query.length, result.offset + query.length + 65)}…`)
    adapter.goToPage(result.page)
    void highlightResult(result, ++locateRevision)
  }
  async function highlightResult(result, token) {
    if (!CSS.highlights || typeof Highlight === 'undefined') return
    CSS.highlights.delete('document-find')
    for (let attempt = 0; attempt < 30; attempt++) {
      if (token !== locateRevision || search.hidden || disposed || !active) return
      const root = scroll.querySelector(`.pdf-page-wrapper[data-page="${result.page}"] .textLayer, .article-unit[data-unit-index="${result.page}"]`)
      if (root?.textContent) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const nodes = []
        let text = ''
        while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: text.length }); text += walker.currentNode.textContent }
        let start = -1
        for (let i = 0; i < result.occurrence; i++) start = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), start + 1)
        if (start >= 0) {
          const end = start + query.length
          const first = nodes.find(item => start >= item.start && start < item.start + item.node.length)
          const last = nodes.find(item => end > item.start && end <= item.start + item.node.length)
          if (first && last) {
            const range = document.createRange()
            range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start)
            CSS.highlights.set('document-find', new Highlight(range))
            first.node.parentElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            return
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  function move(direction) {
    if (!results.length) return
    selected = (selected + direction + results.length) % results.length
    showResult()
  }
  async function runSearch() {
    searchController?.abort()
    searchController = new AbortController()
    const token = ++revision
    query = input.value.trim()
    results = []; selected = -1; snippet.replaceChildren()
    if (!query) { searching = false; count.value = ''; return }
    searching = true; limited = false
    count.value = t('navigation:tabs.searching')
    const needle = query.toLocaleLowerCase()
    try {
      const found = []
      for (let page = 1; page <= adapter.state.totalPages; page++) {
        if (token !== revision || disposed) return
        if (!texts.has(page)) texts.set(page, await adapter.pageText(page, searchController.signal))
        const haystack = texts.get(page).toLocaleLowerCase()
        let occurrence = 0
        for (let offset = haystack.indexOf(needle); offset !== -1; offset = haystack.indexOf(needle, offset + needle.length)) {
          found.push({ page, offset, occurrence: ++occurrence })
          if (found.length >= 10000) { limited = true; break }
        }
        if (limited) break
        // Yield between pages, keeping navigation responsive for large documents.
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      if (token !== revision || disposed) return
      searching = false; results = found; selected = found.length ? 0 : -1; showResult()
    } catch { if (token === revision) { searching = false; count.value = t('navigation:tabs.searchFailed') } }
  }
  input.addEventListener('input', () => { searchController?.abort(); ++revision; ++locateRevision; CSS.highlights?.delete('document-find'); clearTimeout(queryTimer); queryTimer = setTimeout(runSearch, 180) })
  search.addEventListener('submit', event => { event.preventDefault(); move(1) })
  function keydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); toggle(true) }
    if (event.key === 'Escape' && !search.hidden) { event.preventDefault(); toggle(false) }
    if (event.key === 'Enter' && event.target === input && event.shiftKey) { event.preventDefault(); move(-1) }
  }
  document.addEventListener('keydown', keydown)
  return {
    openFind: () => toggle(true),
    fit: () => fit,
    restore(value) { fit = value; fitButton.setAttribute('aria-pressed', String(fit)) },
    fitNow: applyFit,
    refresh: scheduleFit,
    setActive(value) {
      active = value
      if (!value) { pointerDown = false; ++locateRevision; ++revision; searchController?.abort(); clearTimeout(queryTimer) }
      else {
        scheduleFit()
        if (!search.hidden && (searching || query !== input.value.trim())) void runSearch()
        else if (!search.hidden && results[selected]) void highlightResult(results[selected], ++locateRevision)
      }
    },
    destroy() { searchController?.abort(); disposed = true; ++revision; clearTimeout(fitTimer); clearTimeout(queryTimer); resize.disconnect(); focusObserver.disconnect(); document.removeEventListener('pointerdown', pointerStart, true); document.removeEventListener('pointerup', pointerEnd, true); document.removeEventListener('pointercancel', pointerEnd, true); document.removeEventListener('change', manualZoom, true); document.removeEventListener('keydown', keydown); document.removeEventListener('click', manualZoom, true); texts.clear() },
  }
}
