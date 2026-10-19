// Captures belong to the viewer, not virtualized PDF page elements.
export function createCaptureOverlayManager({ host, t, goToPage, restoreFocus }) {
  const panels = new Map()
  const limit = 5
  // Fixed-position CSS values are unscaled; pointer/viewport measurements include root zoom.
  const uiScale = () => Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1
  const viewport = () => ({ width: window.innerWidth / uiScale(), height: window.innerHeight / uiScale() })
  const fit = panel => {
    const { width, height } = viewport()
    panel.style.setProperty('--capture-viewport-width', `${width}px`)
    panel.style.setProperty('--capture-viewport-height', `${height}px`)
    panel.style.left = `${Math.max(8, Math.min(parseFloat(panel.style.left) || 8, width - panel.offsetWidth - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(parseFloat(panel.style.top) || 8, height - panel.offsetHeight - 8))}px`
  }
  const observer = new ResizeObserver(entries => entries.forEach(({ target }) => fit(target)))
  const remove = panel => {
    const url = panels.get(panel)
    if (!url) return
    observer.unobserve(panel)
    panels.delete(panel)
    panel.remove()
    URL.revokeObjectURL(url)
  }
  const onResize = () => panels.forEach((_, panel) => fit(panel))
  window.addEventListener('resize', onResize)
  const scaleObserver = new MutationObserver(onResize)
  scaleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  const bringToFront = panel => {
    const url = panels.get(panel)
    if (!url) return
    panels.delete(panel)
    panels.set(panel, url)
    let index = 210
    panels.forEach((_, item) => { item.style.zIndex = String(index++) })
  }
  return {
    get full() { return panels.size >= limit },
    clear() { [...panels.keys()].forEach(remove) },
    add(blob, page) {
      if (panels.size >= limit) return false
      const panel = document.createElement('section')
      panel.className = 'capture-overlay'
      panel.setAttribute('aria-label', t('viewer:capture.title', { page }))
      panel.style.left = `${Math.max(8, viewport().width - 400 - panels.size * 24)}px`
      panel.style.top = `${80 + panels.size * 28}px`
      const header = document.createElement('div')
      header.className = 'capture-overlay-header'
      const button = (label, text, action) => {
        const el = document.createElement('button')
        el.type = 'button'
        el.title = label
        el.setAttribute('aria-label', label)
        el.textContent = text
        if (action) el.addEventListener('click', action)
        header.appendChild(el)
        return el
      }
      const drag = button(t('viewer:capture.move'), t('viewer:capture.title', { page }))
      drag.className = 'capture-overlay-drag'
      button(t('viewer:capture.source', { page }), `↗ ${page}`, () => goToPage(page))
      const collapse = button(t('viewer:capture.collapse'), '−', () => {
        const collapsed = panel.classList.toggle('collapsed')
        collapse.setAttribute('aria-expanded', String(!collapsed))
        const label = collapsed ? t('viewer:capture.expand') : t('viewer:capture.collapse')
        collapse.setAttribute('aria-label', label)
        collapse.title = label
        collapse.textContent = collapsed ? '+' : '−'
      })
      collapse.setAttribute('aria-expanded', 'true')
      button(t('viewer:capture.close'), '×', () => { remove(panel); restoreFocus() })
      const content = document.createElement('div')
      content.className = 'capture-overlay-content'
      content.tabIndex = 0
      content.setAttribute('role', 'region')
      content.setAttribute('aria-label', t('viewer:capture.content', { page }))
      content.addEventListener('keydown', event => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.stopPropagation()
      })
      const img = document.createElement('img')
      img.alt = t('viewer:capture.title', { page })
      img.draggable = false
      const url = URL.createObjectURL(blob)
      img.src = url
      content.appendChild(img)
      const resize = document.createElement('button')
      resize.type = 'button'
      resize.className = 'capture-overlay-resize'
      resize.setAttribute('aria-label', t('viewer:capture.resize'))
      resize.title = t('viewer:capture.resize')
      const setSize = (width, height) => {
        panel.style.width = `${Math.max(280, Math.min(width, viewport().width - 16))}px`
        panel.style.height = `${Math.max(100, Math.min(height, viewport().height - 16))}px`
        fit(panel)
      }
      let resizeOrigin = null
      resize.addEventListener('pointerdown', event => {
        if (event.button !== 0) return
        event.preventDefault()
        resizeOrigin = { x: event.clientX, y: event.clientY, width: panel.offsetWidth, height: panel.offsetHeight, scale: uiScale() }
        resize.setPointerCapture(event.pointerId)
      })
      resize.addEventListener('pointermove', event => {
        if (resizeOrigin) setSize(resizeOrigin.width + (event.clientX - resizeOrigin.x) / resizeOrigin.scale, resizeOrigin.height + (event.clientY - resizeOrigin.y) / resizeOrigin.scale)
      })
      resize.addEventListener('lostpointercapture', () => { resizeOrigin = null })
      resize.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const step = event.shiftKey ? 20 : 4
        setSize(panel.offsetWidth + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
          panel.offsetHeight + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0))
      })
      panel.append(header, content, resize)
      panels.set(panel, url)
      host.appendChild(panel)
      panel.addEventListener('pointerdown', () => bringToFront(panel), true)
      panel.addEventListener('focusin', () => bringToFront(panel))
      bringToFront(panel)
      observer.observe(panel)
      fit(panel)
      let origin = null
      drag.addEventListener('pointerdown', event => {
        if (event.button !== 0) return
        event.preventDefault()
        origin = { x: event.clientX, y: event.clientY, left: parseFloat(panel.style.left), top: parseFloat(panel.style.top), scale: uiScale() }
        drag.setPointerCapture(event.pointerId)
      })
      drag.addEventListener('pointermove', event => {
        if (!origin) return
        panel.style.left = `${origin.left + (event.clientX - origin.x) / origin.scale}px`
        panel.style.top = `${origin.top + (event.clientY - origin.y) / origin.scale}px`
        fit(panel)
      })
      drag.addEventListener('lostpointercapture', () => { origin = null })
      drag.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const step = event.shiftKey ? 20 : 4
        panel.style.left = `${parseFloat(panel.style.left) + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)}px`
        panel.style.top = `${parseFloat(panel.style.top) + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)}px`
        fit(panel)
      })
      drag.focus()
      return true
    },
  }
}
