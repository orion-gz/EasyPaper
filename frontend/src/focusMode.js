export const FOCUS_DEFAULTS = Object.freeze({ enabled: false, blurStrength: 6, dimOpacity: 20, scale: 104 })

export function normalizeFocusSettings(value = {}) {
  const number = (input, fallback, min, max, step = 1) => {
    const parsed = Number(input)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed / step) * step))
  }
  return {
    enabled: value.enabled === true,
    blurStrength: number(value.blurStrength, 6, 0, 16),
    dimOpacity: number(value.dimOpacity, 20, 0, 60, 5),
    scale: number(value.scale, 104, 100, 110),
  }
}

export function mergeClientRects(rects, gap = 3) {
  const values = Array.from(rects || [], rect => ({ left: rect.left, top: rect.top, right: rect.right ?? rect.left + rect.width, bottom: rect.bottom ?? rect.top + rect.height }))
    .filter(rect => [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)).sort((a, b) => a.top - b.top || a.left - b.left)
  const rows = []
  for (const rect of values) {
    const last = rows.at(-1)
    if (last && Math.abs(last.top - rect.top) <= gap && rect.left <= last.right + gap) {
      last.left = Math.min(last.left, rect.left); last.top = Math.min(last.top, rect.top)
      last.right = Math.max(last.right, rect.right); last.bottom = Math.max(last.bottom, rect.bottom)
    } else rows.push({ ...rect })
  }
  return rows.map(rect => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }))
}

export function createFocusMask(rects, width, height, padding = 4) {
  const holes = mergeClientRects(rects).map(rect => `<rect x="${Math.max(0, rect.left - padding)}" y="${Math.max(0, rect.top - padding)}" width="${rect.width + padding * 2}" height="${rect.height + padding * 2}" rx="5" fill="black"/>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><mask id="holes" maskUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="white"/>${holes}</mask></defs><rect width="100%" height="100%" fill="white" mask="url(#holes)"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

export function focusCssVariables(settings) {
  const value = normalizeFocusSettings(settings)
  return { '--focus-blur': `${value.blurStrength}px`, '--focus-dim': String(value.dimOpacity / 100), '--focus-scale': String(value.scale / 100) }
}

// Keep the sentence openings independent of CSS image-mask support.
export function createFocusBackdropRects(rects, width, height, padding = 4) {
  const holes = mergeClientRects(rects).map(rect => ({
    left: Math.max(0, rect.left - padding), right: Math.min(width, rect.right + padding),
    top: Math.max(0, rect.top - padding), bottom: Math.min(height, rect.bottom + padding),
  })).filter(rect => rect.left < rect.right && rect.top < rect.bottom)
  const rows = [...new Set([0, height, ...holes.flatMap(rect => [rect.top, rect.bottom])])].sort((a, b) => a - b)
  const regions = []
  for (let i = 1; i < rows.length; i++) {
    const top = rows[i - 1], bottom = rows[i]
    let left = 0
    const spans = holes.filter(rect => rect.top < bottom && rect.bottom > top).sort((a, b) => a.left - b.left)
    const add = right => { if (right > left) regions.push({ left, top, width: right - left, height: bottom - top }) }
    for (const span of spans) { add(span.left); left = Math.max(left, span.right) }
    add(width)
  }
  return regions
}

export function isFocusKeyboardExcluded(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"], .chat-input-box')
}

export function revealFocusTranslation(elements) {
  const first = elements?.[0]
  const pane = first?.closest('.trans-page-content')
  if (!pane || !pane.clientHeight) return
  const bounds = pane.getBoundingClientRect()
  const scale = bounds.height / pane.offsetHeight || 1
  const top = bounds.top + pane.clientTop * scale
  const bottom = top + pane.clientHeight * scale
  const rects = elements.flatMap(element => Array.from(element.getClientRects()))
  if (!rects.length) return
  const start = Math.min(...rects.map(rect => rect.top))
  const end = Math.max(...rects.map(rect => rect.bottom))
  // Scroll only the translation pane, so the source stays under the pointer.
  if (start < top || end > bottom) {
    const offset = end - start > bottom - top ? start - top : (start + end - top - bottom) / 2
    pane.scrollTop += offset / scale
  }
}

export function visibleFocusRects(element) {
  let rects = Array.from(element.getClientRects())
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const clipX = /auto|scroll|hidden|clip/.test(style.overflowX)
    const clipY = /auto|scroll|hidden|clip/.test(style.overflowY)
    if (!clipX && !clipY) continue
    const bounds = parent.getBoundingClientRect()
    const sx = bounds.width / parent.offsetWidth || 1, sy = bounds.height / parent.offsetHeight || 1
    const x = bounds.left + parent.clientLeft * sx, y = bounds.top + parent.clientTop * sy
    rects = rects.map(rect => {
      const left = clipX ? Math.max(rect.left, x) : rect.left
      const right = clipX ? Math.min(rect.right, x + parent.clientWidth * sx) : rect.right
      const top = clipY ? Math.max(rect.top, y) : rect.top
      const bottom = clipY ? Math.min(rect.bottom, y + parent.clientHeight * sy) : rect.bottom
      return { left, top, right, bottom, width: right - left, height: bottom - top }
    }).filter(rect => rect.width > 0 && rect.height > 0)
  }
  return rects
}

const SVG_NS = 'http://www.w3.org/2000/svg'
let filterId = 0
export function focusSvgCoordinateScale(zoom, userAgent) {
  // WebKit resolves SVG filter primitives on HTML in viewport pixels even
  // under CSS zoom; Blink/Gecko use the element's unzoomed CSS coordinates.
  const webkit = /AppleWebKit/.test(userAgent) && !/(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent)
  return webkit ? 1 : zoom
}
function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

// Filter SourceGraphic itself, not the browser's optional backdrop compositor.
// The original pixels inside each sentence are merged over the blurred pixels.
export function createSentenceFilter(id, rects, bounds, strength, zoom = 1) {
  const padding = Math.max(4, strength * 3) / zoom
  const filter = svgElement('filter', { id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', x: -padding, y: -padding, width: bounds.width / zoom + padding * 2, height: bounds.height / zoom + padding * 2, 'color-interpolation-filters': 'sRGB' })
  filter.append(svgElement('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: strength / zoom, result: 'blurred' }))
  rects.forEach((rect, index) => filter.append(svgElement('feFlood', {
    x: (rect.left - bounds.left - 4) / zoom, y: (rect.top - bounds.top - 4) / zoom,
    width: (rect.width + 8) / zoom, height: (rect.height + 8) / zoom,
    'flood-color': 'white', result: `hole${index}`,
  })))
  const holes = svgElement('feMerge', { result: 'holes' })
  rects.forEach((_, index) => holes.append(svgElement('feMergeNode', { in: `hole${index}` })))
  filter.append(holes, svgElement('feComposite', { in: 'blurred', in2: 'holes', operator: 'out', result: 'background' }), svgElement('feComposite', { in: 'SourceGraphic', in2: 'holes', operator: 'in', result: 'sentence' }))
  const output = svgElement('feMerge')
  output.append(svgElement('feMergeNode', { in: 'background' }), svgElement('feMergeNode', { in: 'sentence' }))
  filter.append(output)
  return filter
}

export class FocusModeController {
  constructor({ root, resolvePair, listSentences, announce = () => {}, notifyFallback = () => {}, releaseDelay = 150 }) {
    Object.assign(this, { root, resolvePair, listSentences, announce, notifyFallback, releaseDelay })
    this.settings = normalizeFocusSettings(); this.current = null; this.pinned = false
    this.filteredElements = new Map(); this.hiddenMemos = new Map()
    this.onKeyDown = event => this.handleKeyDown(event); this.onViewportChange = () => this.scheduleRender()
    this.onLeave = () => this.leave()
    this.onInteraction = event => {
      if (!event.target.closest?.('.textLayer, .trans-sentence')) this.clear()
    }
    this.onVisibility = () => { if (document.hidden) this.clear() }
    document.addEventListener('keydown', this.onKeyDown)
    document.addEventListener('pointerdown', this.onInteraction, true)
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('resize', this.onViewportChange)
    root?.addEventListener('mouseleave', this.onLeave)
    root?.addEventListener('scroll', this.onViewportChange, { passive: true, capture: true })
  }
  applySettings(settings) { this.settings = normalizeFocusSettings(settings); if (!this.settings.enabled) this.clear(); else if (this.current) this.scheduleRender() }
  sameRef(a, b) { return !!a && !!b && a.pageNum === b.pageNum && a.sentenceIdx === b.sentenceIdx }
  focus(ref, { pin = false } = {}) {
    if (!this.settings.enabled || !ref) return false
    this.cancelLeave()
    if (this.pinned && !pin) return true
    if (pin && this.pinned && this.sameRef(ref, this.current)) { this.clear(); return true }
    if (!pin && this.sameRef(ref, this.current)) {
      if (ref.revealTranslation && !this.current.revealTranslation) {
        this.current = ref; this.revealedTranslation = false; this.scheduleRender()
      }
      return true
    }
    this.current = ref; this.revealedTranslation = false; if (pin) this.pinned = true; this.scheduleRender(); this.announce(this.pinned ? 'focusPinned' : 'focusActive'); return true
  }
  leave() { if (!this.pinned && !this.releaseTimer) this.releaseTimer = setTimeout(() => this.clear(), this.releaseDelay) }
  cancelLeave() { clearTimeout(this.releaseTimer); this.releaseTimer = null }
  clear() {
    this.cancelLeave()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = null
    this.current = null; this.pinned = false; this.lastGeometry = null
    this.layer?.remove()
    this.layer = null
    for (const [element, original] of this.filteredElements) {
      element.style.setProperty('filter', original.value, original.priority)
      for (const [property, value] of Object.entries(original.overflow)) element.style.setProperty(property, value.value, value.priority)
    }
    this.filteredElements.clear()
    for (const [element, original] of this.hiddenMemos) element.style.setProperty('visibility', original.value, original.priority)
    this.hiddenMemos.clear()
    this.filterSvg?.remove(); this.filterSvg = null
    this.root?.classList.remove('focus-mode-active')
    this.root?.querySelectorAll('.trans-sentence[aria-pressed]').forEach(element => element.removeAttribute('aria-pressed'))
  }
  togglePin(ref) { return this.focus(ref, { pin: true }) }
  navigate(delta) {
    if (!this.pinned || !this.current) return false
    const sequence = this.listSentences?.() || []; const index = sequence.findIndex(ref => this.sameRef(ref, this.current))
    if (index < 0) return false
    const next = sequence[Math.max(0, Math.min(sequence.length - 1, index + delta))]
    if (!next || this.sameRef(next, this.current)) return true
    this.current = next; this.revealedTranslation = false; next.element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); this.scheduleRender(); this.announce('focusMoved'); return true
  }
  handleKeyDown(event) {
    if (!this.pinned || isFocusKeyboardExcluded(event.target)) return
    if (event.key === 'Escape') { event.preventDefault(); this.clear(); return }
    const delta = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0
    if (delta) { event.preventDefault(); this.navigate(delta) }
  }
  scheduleRender() {
    if (!this.current || !this.settings.enabled || this.raf) return
    this.raf = requestAnimationFrame(() => { this.raf = null; this.render() })
  }
  render() {
    if (!this.current || !this.settings.enabled) return
    let pair = this.resolvePair?.(this.current) || {}
    if (this.current.revealTranslation && !this.revealedTranslation && pair.elements?.length) {
      revealFocusTranslation(pair.elements)
      this.revealedTranslation = true
      pair = this.resolvePair(this.current)
    }
    const bounds = this.root.getBoundingClientRect()
    const rects = [...(pair.sourceRects || []), ...(pair.translationRects || [])].map(rect => {
      const left = Math.max(0, bounds.left, rect.left)
      const top = Math.max(0, bounds.top, rect.top)
      const right = Math.min(window.innerWidth, bounds.right, rect.right ?? rect.left + rect.width)
      const bottom = Math.min(window.innerHeight, bounds.bottom, rect.bottom ?? rect.top + rect.height)
      return { left, top, width: right - left, height: bottom - top }
    }).filter(rect => rect.width > 0 && rect.height > 0)
    if (this.root?.closest('#viewer-screen')?.classList.contains('active') === false) { this.clear(); return }
    // Only sentence pixels are revealed. Panels, popups and toolbars remain covered.
    // Rendering can temporarily disappear during PDF zoom; retain the pinned reference.
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1
    const memoRects = Array.from(document.querySelectorAll('.floating-memo')).map(element => ({ element, bounds: element.getBoundingClientRect() }))
    for (const { element, bounds: memo } of memoRects) {
      const overlaps = rects.some(rect => rect.left < memo.right && rect.left + rect.width > memo.left && rect.top < memo.bottom && rect.top + rect.height > memo.top)
      if (overlaps && !this.hiddenMemos.has(element)) {
        this.hiddenMemos.set(element, { value: element.style.getPropertyValue('visibility'), priority: element.style.getPropertyPriority('visibility') })
        element.style.setProperty('visibility', 'hidden', 'important')
      } else if (!overlaps && this.hiddenMemos.has(element)) {
        const original = this.hiddenMemos.get(element)
        element.style.setProperty('visibility', original.value, original.priority); this.hiddenMemos.delete(element)
      }
    }
    const targets = Array.from(document.body.children).filter(element => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName) && element !== this.layer)
      .filter(element => { const bounds = element.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 })
    const targetBounds = targets.map(element => element.getBoundingClientRect())
    const geometry = JSON.stringify([rects, window.innerWidth, window.innerHeight, zoom, this.settings, targetBounds.map(b => [b.left, b.top, b.width, b.height])])
    if (geometry === this.lastGeometry && targets.every(element => this.filteredElements.has(element))) { this.scheduleRender(); return }
    this.lastGeometry = geometry
    if (!this.filterSvg) {
      this.filterSvg = svgElement('svg', { width: 0, height: 0, 'aria-hidden': 'true' })
      this.filterSvg.style.position = 'absolute'; document.body.append(this.filterSvg)
    }
    this.filterSvg.replaceChildren()
    targets.forEach((element, index) => {
      if (!this.filteredElements.has(element)) {
        const computed = getComputedStyle(element)
        const original = { value: element.style.getPropertyValue('filter'), priority: element.style.getPropertyPriority('filter'), computed: computed.filter, overflow: {} }
        // Constrain the SVG source surface to its measured box. Offscreen
        // descendants otherwise expand the filter's paint/reference bounds.
        // Existing scroll/hidden overflow already clips and must stay intact.
        for (const property of ['overflow-x', 'overflow-y']) if (element.contains(this.root) && computed.getPropertyValue(property) === 'visible') {
          original.overflow[property] = { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) }
        }
        this.filteredElements.set(element, original)
        for (const property of Object.keys(original.overflow)) element.style.setProperty(property, 'hidden', 'important')
      }
      const original = this.filteredElements.get(element)
      const prefix = original.computed === 'none' ? '' : original.computed
      if (element.contains(this.root)) {
        const id = `focus-sentence-filter-${++filterId}`
        this.filterSvg.append(createSentenceFilter(id, rects, targetBounds[index], this.settings.blurStrength, focusSvgCoordinateScale(zoom, navigator.userAgent)))
        element.style.setProperty('filter', `${prefix} url("#${id}")`, 'important')
      } else {
        // Other UI has no sentence pixels to reveal. A pixel-based CSS filter
        // avoids out-of-bounds SVG cutouts on small floating panels.
        element.style.setProperty('filter', `${prefix} blur(${this.settings.blurStrength / zoom}px)`, 'important')
      }
    })
    if (!this.layer) { this.layer = document.createElement('div'); this.layer.className = 'focus-mode-layer'; this.layer.setAttribute('aria-hidden', 'true'); document.body.append(this.layer) }
    for (const layer of [this.layer]) {
      // Client rects use viewport pixels; cancel the application's root CSS zoom.
      layer.style.zoom = String(1 / zoom)
      for (const [name, value] of Object.entries(focusCssVariables(this.settings))) layer.style.setProperty(name, value)
    }
    this.layer.replaceChildren(...createFocusBackdropRects(rects, window.innerWidth, window.innerHeight).map(rect => {
      const backdrop = document.createElement('div')
      backdrop.className = 'focus-mode-backdrop'
      Object.assign(backdrop.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
      return backdrop
    }))
    this.root?.classList.add('focus-mode-active')
    this.scheduleRender()
  }
  destroy() {
    this.clear()
    document.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('pointerdown', this.onInteraction, true)
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('resize', this.onViewportChange)
    this.root?.removeEventListener('mouseleave', this.onLeave)
    this.root?.removeEventListener('scroll', this.onViewportChange, true)
  }
}
