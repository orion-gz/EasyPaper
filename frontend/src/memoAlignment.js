import { getMemoLayoutPreferences } from './readerPreferenceStore.js'

export function compareMemoAnchors(a, b, ranges = []) {
  const position = memo => {
    if (Number.isFinite(memo.charStart) && memo.charStart >= 0) return memo.charStart
    const range = ranges.find(item => (item.originalSentenceIdx ?? item.sentenceIdx) === memo.sentenceIdx)
    if (range) return range.charStart
    return memo.sentenceIdx >= 0 ? memo.sentenceIdx : Infinity
  }
  const delta = position(a) - position(b)
  return (Number.isNaN(delta) ? 0 : delta) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id))
}

export function stackMemoCards(items, gap = 12) {
  let top = 0
  return items.map(item => {
    const result = { ...item, top }
    top += item.height + gap
    return result
  })
}

const controllers = new WeakMap()
export function releaseMemoAlignment(wrapper, options) {
  controllers.get(wrapper)?.destroy(options)
  controllers.delete(wrapper)
}

export function installMemoAlignment(wrapper, memos, ranges, updateConnector) {
  releaseMemoAlignment(wrapper)
  const pair = wrapper.closest('.page-pair')
  if (!pair) return
  const lanes = {}
  let frame = 0
  const schedule = () => { if (!frame) frame = requestAnimationFrame(layout) }
  const cards = [...wrapper.querySelectorAll('.floating-memo')]
  memos = cards.map(card => card._memoData || memos.find(memo => memo.id === card.dataset.id)).filter(Boolean)
  const byId = new Map(memos.map(memo => [memo.id, memo]))
  function layout() {
    frame = 0
    if (!wrapper.isConnected) { releaseMemoAlignment(wrapper); return }
    const focused = cards.some(card => card.contains(document.activeElement)) ? document.activeElement : null
    const prefs = getMemoLayoutPreferences()
    const paperHeight = wrapper.querySelector('.pdf-page-inner')?.offsetHeight || wrapper.offsetHeight
    const sentenceRanges = typeof ranges === 'function' ? ranges() : ranges
    const groups = { left: [], right: [] }
    for (const card of cards) {
      const memo = byId.get(card.dataset.id)
      if (memo?.alignment === 'left' || memo?.alignment === 'right') groups[memo.alignment].push(card)
      else if (card.parentElement !== wrapper) wrapper.append(card)
      card.querySelectorAll('[data-memo-align]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.memoAlign === memo?.alignment))
      })
    }
    const widths = {}
    const heights = {}
    for (const side of ['left', 'right']) {
      const group = groups[side].sort((a, b) => compareMemoAnchors(byId.get(a.dataset.id), byId.get(b.dataset.id), sentenceRanges))
      if (!lanes[side]) {
        const lane = document.createElement('div')
        lane.className = `memo-margin-lane memo-margin-${side}`
        lane.addEventListener('scroll', connectors)
        wrapper.append(lane)
        lanes[side] = lane
      }
      const lane = lanes[side]
      lane.hidden = !group.length
      group.forEach((card, index) => {
        if (lane.children[index] !== card) lane.insertBefore(card, lane.children[index] || null)
      })
      widths[side] = group.length ? Math.max(...group.map(card => card.offsetWidth)) + (prefs.overflow === 'scroll' ? 12 : 0) : 0
      const positions = stackMemoCards(group.map(card => ({ card, height: card.offsetHeight })))
      heights[side] = positions.length ? positions.at(-1).top + positions.at(-1).height : 0
      lane.hidden = !group.length
      lane.style.width = `${widths[side]}px`
      lane.style.height = `${prefs.overflow === 'scroll' ? paperHeight : heights[side]}px`
      lane.classList.toggle('memo-margin-scroll', prefs.overflow === 'scroll')
      for (const { card, top } of positions) {
        card.style.top = `${top}px`
        card.style.left = `${side === 'left' ? widths[side] - card.offsetWidth - (prefs.overflow === 'scroll' ? 12 : 0) : 0}px`
      }
    }
    const free = cards.filter(card => !['left', 'right'].includes(byId.get(card.dataset.id)?.alignment))
    const leftEdge = Math.min(0, ...free.map(card => card.offsetLeft - 16))
    const rightEdge = Math.max(wrapper.offsetWidth, ...free.map(card => card.offsetLeft + card.offsetWidth + 16))
    const between = prefs.rightPosition === 'between'
    pair.classList.toggle('has-aligned-memos', Boolean(widths.left || widths.right))
    pair.style.paddingLeft = widths.left ? `${28 + widths.left + 16 - leftEdge}px` : ''
    pair.style.paddingRight = widths.right && !between ? `${28 + widths.right + 16 + Math.max(0, rightEdge - wrapper.offsetWidth)}px` : ''
    pair.style.columnGap = widths.right && between ? `${Math.max(40, widths.right + 32 + rightEdge - wrapper.offsetWidth)}px` : ''
    pair.style.paddingBottom = prefs.overflow === 'expand' && (widths.left || widths.right)
      ? `${28 + Math.max(0, heights.left - paperHeight, heights.right - paperHeight)}px` : ''
    lanes.left.style.left = `${leftEdge - widths.left - 16}px`
    const translation = pair.querySelector('.trans-page-block')
    const scale = wrapper.getBoundingClientRect().width / Math.max(1, wrapper.offsetWidth) || 1
    const transRight = translation && translation.offsetWidth && !between
      ? (translation.getBoundingClientRect().right - wrapper.getBoundingClientRect().left) / scale : wrapper.offsetWidth
    lanes.right.style.left = `${Math.max(rightEdge, transRight) + 16}px`
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
    connectors()
  }
  function connectors() { for (const memo of memos) updateConnector(wrapper, memo) }
  const observer = new ResizeObserver(schedule)
  observer.observe(wrapper)
  const translation = pair.querySelector('.trans-page-block')
  if (translation) observer.observe(translation)
  for (const card of cards) observer.observe(card)
  window.addEventListener('easypaper:reader-preferences', schedule)
  window.addEventListener('storage', schedule)
  window.addEventListener('resize', schedule)
  const lifecycle = new MutationObserver(() => {
    if (!wrapper.isConnected) releaseMemoAlignment(wrapper)
  })
  if (pair.parentElement) lifecycle.observe(pair.parentElement, { childList: true })
  controllers.set(wrapper, { destroy({ preserveSpace = false } = {}) {
    lifecycle.disconnect()
    delete wrapper._scheduleMemoAlignment
    cancelAnimationFrame(frame)
    observer.disconnect()
    window.removeEventListener('easypaper:reader-preferences', schedule)
    window.removeEventListener('storage', schedule)
    window.removeEventListener('resize', schedule)
    for (const lane of Object.values(lanes)) { for (const card of [...lane.children]) wrapper.append(card); lane.remove() }
    // Evicted PDF pages retain their full footprint until their cards remount.
    if (!preserveSpace) {
      pair.classList.remove('has-aligned-memos')
      for (const name of ['paddingLeft', 'paddingRight', 'paddingBottom', 'columnGap']) pair.style[name] = ''
    }
  } })
  wrapper._scheduleMemoAlignment = schedule
  schedule()
  return schedule
}
