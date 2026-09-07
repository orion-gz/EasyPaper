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

export function isFocusKeyboardExcluded(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"], .chat-input-box')
}

export class FocusModeController {
  constructor({ root, resolvePair, listSentences, announce = () => {}, notifyFallback = () => {}, releaseDelay = 150 }) {
    Object.assign(this, { root, resolvePair, listSentences, announce, notifyFallback, releaseDelay })
    this.settings = normalizeFocusSettings(); this.current = null; this.pinned = false; this.slowFrames = 0; this.performanceFallback = false
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
    if (!pin && this.sameRef(ref, this.current)) return true
    this.current = ref; if (pin) this.pinned = true; this.scheduleRender(); this.announce(this.pinned ? 'focusPinned' : 'focusActive'); return true
  }
  leave() { if (!this.pinned && !this.releaseTimer) this.releaseTimer = setTimeout(() => this.clear(), this.releaseDelay) }
  cancelLeave() { clearTimeout(this.releaseTimer); this.releaseTimer = null }
  clear() {
    this.cancelLeave()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = null
    this.current = null; this.pinned = false; this.lastGeometry = null
    this.layer?.remove(); this.outlineLayer?.remove()
    this.layer = null; this.outlineLayer = null
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
    this.current = next; next.element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); this.scheduleRender(); this.announce('focusMoved'); return true
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
    const started = performance.now()
    const pair = this.resolvePair?.(this.current) || {}
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
    const geometry = JSON.stringify([rects, window.innerWidth, window.innerHeight, zoom, this.settings, this.performanceFallback])
    if (geometry === this.lastGeometry) { this.scheduleRender(); return }
    this.lastGeometry = geometry
    if (!this.layer) { this.layer = document.createElement('div'); this.layer.className = 'focus-mode-layer'; this.layer.setAttribute('aria-hidden', 'true'); this.outlineLayer = document.createElement('div'); this.outlineLayer.className = 'focus-mode-outline-layer'; this.outlineLayer.setAttribute('aria-hidden', 'true'); document.body.append(this.layer, this.outlineLayer) }
    for (const layer of [this.layer, this.outlineLayer]) {
      // Client rects use viewport pixels; cancel the application's root CSS zoom.
      layer.style.zoom = String(1 / zoom)
      for (const [name, value] of Object.entries(focusCssVariables(this.settings))) layer.style.setProperty(name, value)
    }
    this.layer.classList.toggle('focus-performance-fallback', this.performanceFallback)
    this.layer.style.maskImage = createFocusMask(rects, window.innerWidth, window.innerHeight); this.layer.style.webkitMaskImage = this.layer.style.maskImage
    this.outlineLayer.replaceChildren(...mergeClientRects(rects).map(rect => { const outline = document.createElement('i'); outline.className = 'focus-mode-outline'; Object.assign(outline.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }); return outline }))
    this.root?.classList.add('focus-mode-active')
    this.slowFrames = performance.now() - started > 20 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1)
    if (!this.performanceFallback && this.slowFrames >= 8) { this.performanceFallback = true; this.notifyFallback(); this.scheduleRender() }
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
