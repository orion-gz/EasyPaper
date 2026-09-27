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
  let drag = null
  let locateRevision = 0
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
  const selectButton = button('document-select-tool', t('navigation:tabs.selectTool'), '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M5 3v17l5-5 4 7 3-2-4-7 7-1Z"/></svg>', tools, () => setPan(false))
  const panButton = button('document-pan-tool', t('navigation:tabs.panTool'), '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M8 12V5a2 2 0 0 1 4 0v7-9a2 2 0 0 1 4 0v9-6a2 2 0 0 1 4 0v10c0 4-2 6-6 6h-2c-2 0-3-1-4-3l-4-6a2 2 0 0 1 3-2l1 1Z"/></svg>', tools, () => setPan(true))
  selectButton.dataset.i18nAriaLabel = 'navigation:tabs.selectTool'
  panButton.dataset.i18nAriaLabel = 'navigation:tabs.panTool'
  function setPan(value) {
    scroll.classList.toggle('document-pan-mode', value)
    panButton.setAttribute('aria-pressed', String(value))
    selectButton.setAttribute('aria-pressed', String(!value))
    endDrag()
  }
  function endDrag() {
    if (drag && scroll.hasPointerCapture(drag.id)) scroll.releasePointerCapture(drag.id)
    drag = null
    scroll.classList.remove('document-panning')
  }
  scroll.addEventListener('pointerdown', event => {
    if (!scroll.classList.contains('document-pan-mode') || event.button !== 0 || event.target.closest('button, input, textarea, select, a')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: scroll.scrollLeft, top: scroll.scrollTop }
    scroll.setPointerCapture(event.pointerId)
    scroll.classList.add('document-panning')
  }, true)
  scroll.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return
    const scale = scroll.getBoundingClientRect().width / scroll.offsetWidth || 1
    scroll.scrollLeft = drag.left + (drag.x - event.clientX) / scale
    scroll.scrollTop = drag.top + (drag.y - event.clientY) / scale
  })
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) scroll.addEventListener(event, endDrag)
  setPan(false)

  function isInteracting() {
    const selection = window.getSelection()
    return pointerDown || scroll.querySelector('.floating-memo-textarea') || document.activeElement?.closest('.floating-memo') || (selection && !selection.isCollapsed && scroll.contains(selection.anchorNode))
  }
  async function applyFit() {
    if (!fit || !active || disposed || fitting || !scroll.clientWidth) return
    // Rebuilding PDF text layers must not interrupt selection or memo editing.
    if (isInteracting()) return
    fitting = true
    try {
      const width = await adapter.pageWidth()
      if (!fit || !active || disposed || !width || isInteracting()) return
      const parallel = document.getElementById('viewer-screen').dataset.readingMode === 'parallel'
      const scrollStyle = getComputedStyle(scroll)
      const pair = scroll.querySelector('.page-pair')
      const pairStyle = pair ? getComputedStyle(pair) : null
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
      active = value; endDrag()
      if (!value) { pointerDown = false; ++locateRevision; ++revision; searchController?.abort(); clearTimeout(queryTimer) }
      else {
        scheduleFit()
        if (!search.hidden && (searching || query !== input.value.trim())) void runSearch()
        else if (!search.hidden && results[selected]) void highlightResult(results[selected], ++locateRevision)
      }
    },
    destroy() { searchController?.abort(); disposed = true; ++revision; clearTimeout(fitTimer); clearTimeout(queryTimer); resize.disconnect(); document.removeEventListener('pointerdown', pointerStart, true); document.removeEventListener('pointerup', pointerEnd, true); document.removeEventListener('pointercancel', pointerEnd, true); document.removeEventListener('change', manualZoom, true); document.removeEventListener('keydown', keydown); document.removeEventListener('click', manualZoom, true); texts.clear() },
  }
}
