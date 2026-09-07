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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${holes}</svg>`
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
    this.settings = normalizeFocusSettings(); this.current = null; this.pinned = false; this.exclusions = new Set(); this.slowFrames = 0; this.performanceFallback = false
    this.onKeyDown = event => this.handleKeyDown(event); this.onViewportChange = () => this.scheduleRender()
    document.addEventListener('keydown', this.onKeyDown); window.addEventListener('resize', this.onViewportChange); root?.addEventListener('scroll', this.onViewportChange, { passive: true })
  }
  applySettings(settings) { this.settings = normalizeFocusSettings(settings); if (!this.settings.enabled) this.clear(); else if (this.current) this.scheduleRender() }
  sameRef(a, b) { return !!a && !!b && a.pageNum === b.pageNum && a.sentenceIdx === b.sentenceIdx }
  focus(ref, { pin = false } = {}) {
    if (!this.settings.enabled || !ref) return false
    this.cancelLeave()
    if (pin && this.pinned && this.sameRef(ref, this.current)) { this.clear(); return true }
    this.current = ref; if (pin) this.pinned = true; this.scheduleRender(); this.announce(this.pinned ? 'focusPinned' : 'focusActive'); return true
  }
  leave() { this.cancelLeave(); if (!this.pinned) this.releaseTimer = setTimeout(() => this.clear(), this.releaseDelay) }
  cancelLeave() { clearTimeout(this.releaseTimer); this.releaseTimer = null }
  clear() { this.cancelLeave(); this.current = null; this.pinned = false; this.layer?.remove(); this.outlineLayer?.remove(); this.layer = null; this.outlineLayer = null; document.querySelectorAll('.focus-mode-target').forEach(element => element.classList.remove('focus-mode-target')); this.root?.classList.remove('focus-mode-active') }
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
  registerExclusion(element) { if (element) this.exclusions.add(element); this.scheduleRender(); return () => { this.exclusions.delete(element); this.scheduleRender() } }
  scheduleRender() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => { this.raf = null; this.render() }) }
  render() {
    if (!this.current || !this.settings.enabled) return
    const started = performance.now(); const pair = this.resolvePair?.(this.current) || {}; const rects = [...(pair.sourceRects || []), ...(pair.translationRects || [])]
    for (const element of this.exclusions) if (element?.isConnected) rects.push(...element.getClientRects())
    if (!rects.length) { this.clear(); return }
    if (!this.layer) { this.layer = document.createElement('div'); this.layer.className = 'focus-mode-layer'; this.layer.setAttribute('aria-hidden', 'true'); this.outlineLayer = document.createElement('div'); this.outlineLayer.className = 'focus-mode-outline-layer'; this.outlineLayer.setAttribute('aria-hidden', 'true'); document.body.append(this.layer, this.outlineLayer) }
    for (const [name, value] of Object.entries(focusCssVariables(this.settings))) { this.layer.style.setProperty(name, value); this.outlineLayer.style.setProperty(name, value); this.root?.style.setProperty(name, value) }
    this.layer.classList.toggle('focus-performance-fallback', this.performanceFallback)
    this.layer.style.maskImage = createFocusMask(rects, window.innerWidth, window.innerHeight); this.layer.style.webkitMaskImage = this.layer.style.maskImage
    document.querySelectorAll('.focus-mode-target').forEach(element => element.classList.remove('focus-mode-target')); if (!this.performanceFallback) for (const element of pair.elements || []) element.classList.add('focus-mode-target'); this.outlineLayer.replaceChildren(...mergeClientRects(rects).map(rect => { const outline = document.createElement('i'); outline.className = 'focus-mode-outline'; Object.assign(outline.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }); return outline }))
    this.root?.classList.add('focus-mode-active')
    this.slowFrames = performance.now() - started > 20 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1)
    if (!this.performanceFallback && this.slowFrames >= 8) { this.performanceFallback = true; this.notifyFallback(); this.scheduleRender() }
  }
  destroy() { this.clear(); if (this.raf) cancelAnimationFrame(this.raf); document.removeEventListener('keydown', this.onKeyDown); window.removeEventListener('resize', this.onViewportChange); this.root?.removeEventListener('scroll', this.onViewportChange); this.exclusions.clear() }
}
