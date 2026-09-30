import { getEasyEnglishAPI, generateEasyEnglishAPI } from './api.js'
import { t } from './i18n.js'
import './styles/easy-english.css'
import { exactSentenceOffsets, clipSourceRect, visibleSourceBounds } from './easyEnglishMatching.js'

function textRanges(root, sentences) {
  if (!root) return []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest('.article-memo,script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  const nodes = []
  let text = '', node
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: text.length, end: text.length + node.length })
    text += node.textContent
    if (node.parentElement?.nextElementSibling?.tagName === 'BR') text += '\n'
  }
  return exactSentenceOffsets(text, sentences).map(offset => {
    if (!offset) return null
    // A cross-element Range can include entire intermediate PDF spans.
    // Measure only the selected characters in each text node.
    return nodes.filter(item => item.end > offset.start && item.start < offset.end).map(item => {
      const range = document.createRange()
      range.setStart(item.node, Math.max(0, offset.start - item.start))
      range.setEnd(item.node, Math.min(item.node.length, offset.end - item.start))
      return range
    })
  })
}

export function createEasyEnglishController(adapter) {
  let identity = '', epoch = 0, timer, automatic = false
  const entries = new Map(), requests = new Set(), generations = new Set()
  const overlay = document.createElement('div')
  overlay.className = 'easy-english-overlay'
  overlay.setAttribute('aria-hidden', 'true')
  document.body.append(overlay)

  const context = () => adapter.context()
  const active = () => context().active && context().language === 'en'
  const panel = page => document.getElementById(`easy-english-content-${page}`)
  const visible = page => panel(page) && !panel(page).classList.contains('hidden')
  function clearHighlight() {
    overlay.replaceChildren()
    adapter.root.querySelectorAll('.easy-sentence-highlight').forEach(node => node.classList.remove('easy-sentence-highlight'))
  }
  function reset() {
    epoch++
    clearTimeout(timer)
    requests.forEach(request => request.abort())
    requests.clear()
    generations.clear()
    adapter.setBusy(false)
    entries.clear()
    automatic = false
    clearHighlight()
    adapter.root.querySelectorAll('.easy-english-content').forEach(host => render(Number(host.id.replace('easy-english-content-', ''))))
  }
  function sync() {
    const current = context()
    const next = `${current.sessionId}:${current.revision}:${current.language}`
    if (identity !== next) { reset(); identity = next }
    adapter.root.querySelectorAll('[data-tab="easy-english"]').forEach(button => {
      button.disabled = current.language !== 'en'
      button.title = current.language === 'en' ? '' : t('viewer:easyEnglish.englishOnly')
      if (button.disabled && button.classList.contains('active')) button.closest('.trans-tabs').querySelector('[data-tab="translation"]')?.click()
    })
    if (!active()) { clearHighlight(); clearTimeout(timer) }
    return current
  }
  function entry(page) {
    if (!entries.has(page)) entries.set(page, { result: null, loading: false, error: '', attempted: false })
    return entries.get(page)
  }
  function render(page) {
    const host = panel(page)
    if (!host) return
    const item = entry(page)
    host.replaceChildren()
    host.setAttribute('aria-busy', String(item.loading))
    const status = document.createElement('p')
    status.className = 'easy-english-status'
    status.setAttribute('role', item.error ? 'alert' : 'status')
    status.textContent = item.error || (item.loading ? t('viewer:easyEnglish.generating') : item.result ? t('viewer:easyEnglish.ready') : t('viewer:easyEnglish.empty'))
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'btn btn-secondary'
    button.textContent = item.result ? t('viewer:easyEnglish.regenerate') : item.error ? t('viewer:easyEnglish.retry') : t('viewer:easyEnglish.generate')
    button.disabled = item.loading || context().language !== 'en'
    button.addEventListener('click', () => run(page, { generate: true, regenerate: Boolean(item.result) }))
    host.append(status, button)
    if (!item.result) return
    if (!item.result.sentences.length) { status.textContent = t('viewer:easyEnglish.noText'); return }
    let paragraph = null, paragraphId = null
    for (const [index, pair] of item.result.sentences.entries()) {
      if (paragraphId !== pair.paragraph) {
        paragraph = document.createElement('p'); paragraph.className = 'easy-english-paragraph'
        host.append(paragraph); paragraphId = pair.paragraph
      }
      const span = document.createElement('span')
      span.className = 'easy-english-sentence'; span.tabIndex = 0; span.setAttribute('role', 'button')
      span.dataset.easyIndex = index; span.dataset.page = page; span.dataset.sourceSentenceId = pair.source_sentence_id
      span.textContent = pair.easy_sentences.join(' ')
      span.title = pair.source_text
      span.setAttribute('aria-label', t('viewer:easyEnglish.matchLabel', { text: span.textContent }))
      paragraph.append(span, document.createTextNode(' '))
    }
    const details = document.createElement('details')
    const summary = document.createElement('summary'); summary.textContent = t('viewer:easyEnglish.sourcePairs')
    details.append(summary)
    for (const pair of item.result.sentences) {
      const source = document.createElement('p'); source.textContent = pair.source_text
      const result = document.createElement('p'); result.textContent = pair.easy_sentences.join(' ')
      details.append(source, result)
    }
    host.append(details)
  }
  async function run(page, { generate = false, regenerate = false, automaticRequest = false } = {}) {
    const current = sync()
    if (!active() || !panel(page)) return
    const item = entry(page)
    if (item.loading) return
    const token = epoch, request = new AbortController()
    requests.add(request)
    item.loading = true; item.error = ''; render(page)
    try {
      let result = regenerate ? null : await getEasyEnglishAPI(current.sessionId, page, request.signal)
      if (token !== epoch) return
      if (!result && generate) {
        // Recheck after cache lookup: a background tab/page must not start paid work.
        if (!active() || (automaticRequest && (context().page !== page || context().mode !== 'auto'))) return
        item.attempted = true
        generations.add(request); adapter.setBusy(true)
        result = await generateEasyEnglishAPI(current.sessionId, page, regenerate, request.signal)
      }
      if (token === epoch && current.sessionId === context().sessionId) item.result = result || item.result
    } catch (error) {
      if (token === epoch && error.name !== 'AbortError') { item.error = error.message; item.attempted = true }
    } finally {
      requests.delete(request)
      generations.delete(request); adapter.setBusy(generations.size > 0)
      if (token === epoch) { item.loading = false; render(page) }
    }
  }
  function schedule() {
    sync()
    clearTimeout(timer)
    if (!active() || context().mode !== 'auto') return
    const page = context().page, item = entry(page)
    if (item.result || item.attempted) return
    timer = setTimeout(async () => {
      if (!active() || context().mode !== 'auto' || context().page !== page || automatic || !panel(page)) return
      automatic = true
      const autoEpoch = epoch
      try { await run(page, { generate: true, automaticRequest: true }) } finally {
        if (epoch === autoEpoch) { automatic = false; if (context().page !== page) schedule() }
      }
    }, 300)
  }
  function open(page) {
    sync(); clearHighlight(); render(page)
    void run(page).then(schedule)
  }
  function sourceRoot(page) { return adapter.sourceRoot(page) }
  function rects(page, index, ranges = null) {
    const pairs = entry(page).result?.sentences || []
    if (!pairs[index]) return []
    const mapped = adapter.sourceRects(page, pairs[index])
    if (mapped !== null) return mapped
    // Ranges are rebuilt because PDF text layers can be recycled and web annotations
    // can split text nodes. Never retain a Range into a detached document.
    const range = (ranges || textRanges(sourceRoot(page), pairs))[index]
    return range ? range.flatMap(part => [...part.getClientRects()]) : []
  }
  function showPair(page, index, reveal = false, fromSource = false) {
    clearHighlight()
    const host = panel(page)
    const target = host?.querySelector(`[data-easy-index="${index}"]`)
    if (!target || !visible(page)) return
    target.classList.add('easy-sentence-highlight')
    const boxes = rects(page, index)
    const bounds = visibleSourceBounds(sourceRoot(page))
    for (const rawRect of boxes) {
      const rect = clipSourceRect(rawRect, bounds)
      if (!rect) continue
      const box = document.createElement('div'); box.className = 'easy-source-highlight'
      Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
      overlay.append(box)
    }
    if (reveal) {
      if (fromSource) target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      else if (boxes.length) adapter.revealSource(page, boxes[0])
      else {
        host.querySelector('details').open = true
        host.querySelector('.easy-english-status').textContent = t('viewer:easyEnglish.locationMissing')
      }
    }
  }
  function pairAt(event) {
    const target = event.target.closest?.('.easy-english-sentence')
    if (target) return { page: Number(target.dataset.page), index: Number(target.dataset.easyIndex), source: false }
    const root = event.target.closest?.('.textLayer,.article-original')
    if (!root) return null
    const wrapper = root.closest('.pdf-page-wrapper,.article-unit')
    const page = Number(wrapper?.dataset.page || wrapper?.dataset.unitIndex)
    if (!visible(page)) return null
    const pairs = entry(page).result?.sentences || []
    const ranges = textRanges(sourceRoot(page), pairs)
    for (let index = 0; index < pairs.length; index++) {
      if (rects(page, index, ranges).some(rect => event.clientX >= rect.left && event.clientX <= rect.left + rect.width && event.clientY >= rect.top && event.clientY <= rect.top + rect.height)) return { page, index, source: true }
    }
    return null
  }
  for (const name of ['mousemove', 'mouseover', 'click']) {
    adapter.root.addEventListener(name, event => {
      if (!active()) return
      const pair = pairAt(event)
      if (!pair) {
        if (name === 'mousemove') clearHighlight()
        const wrapper = event.target.closest?.('.pdf-page-wrapper,.article-unit')
        const page = Number(wrapper?.dataset.page || wrapper?.dataset.unitIndex)
        if (visible(page) && event.target.closest?.('.textLayer,.article-original')) event.stopImmediatePropagation()
        return
      }
      // The existing translation matcher must not highlight a different sentence.
      event.stopImmediatePropagation()
      showPair(pair.page, pair.index, name === 'click', pair.source)
    }, true)
  }
  adapter.root.addEventListener('keydown', event => {
    const span = event.target.closest?.('.easy-english-sentence')
    if (!span || !['Enter', ' '].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    showPair(Number(span.dataset.page), Number(span.dataset.easyIndex), true)
  }, true)
  adapter.root.addEventListener('focusin', event => {
    const span = event.target.closest?.('.easy-english-sentence')
    if (span) showPair(Number(span.dataset.page), Number(span.dataset.easyIndex))
  })
  adapter.root.addEventListener('scroll', clearHighlight, true)
  adapter.root.addEventListener('mouseleave', clearHighlight)
  window.addEventListener('resize', clearHighlight)
  document.addEventListener('visibilitychange', schedule)
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-workspace-inactive'] })
  window.addEventListener('storage', event => {
    if (event.key === 'easypaper_easy_english_model_revision') { reset(); schedule() }
    else if (event.key?.includes('easy_english_mode')) schedule()
  })
  return { open, schedule, reset, clearHighlight, attach: page => { sync(); render(page); queueMicrotask(schedule) } }
}
