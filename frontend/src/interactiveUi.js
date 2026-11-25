import autoAnimate from '@formkit/auto-animate'
import { animate } from 'motion'
import gsap from 'gsap'
import { Flip } from 'gsap/Flip'
import { computePosition, offset, flip, shift } from '@floating-ui/dom'

gsap.registerPlugin(Flip)

const autoAnimatedElements = new WeakMap()
const slidingIndicators = new WeakMap()

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

/**
 * Mounts @formkit/auto-animate once on any dynamic list, grid, tree, or feed container.
 */
export function enableAutoAnimate(container, options = {}) {
  if (!container || !(container instanceof HTMLElement)) return null
  if (autoAnimatedElements.has(container)) return autoAnimatedElements.get(container)
  const controller = autoAnimate(container, {
    duration: prefersReducedMotion() ? 0 : (options.duration ?? 180),
    easing: options.easing ?? 'cubic-bezier(0.16, 1, 0.3, 1)',
    disrespectUserMotionPreference: false,
  })
  autoAnimatedElements.set(container, controller)
  return controller
}

/**
 * Mounts auto-animate on multiple selectors within a root container.
 */
export function enableAutoAnimateAll(selectors, root = document, options = {}) {
  if (!root) return
  const list = Array.isArray(selectors) ? selectors : String(selectors).split(',').map(s => s.trim()).filter(Boolean)
  for (const selector of list) {
    root.querySelectorAll(selector).forEach(el => enableAutoAnimate(el, options))
  }
}

function findActiveControl(container, itemSelector, activePredicate) {
  const items = [...container.querySelectorAll(itemSelector)].filter(
    el => el instanceof HTMLElement && !el.hidden && !el.classList.contains('hidden') && el.offsetWidth > 0
  )
  return items.find(activePredicate) || null
}

/**
 * Binds a shared-element GSAP Flip sliding indicator pill or underline to a tab/segment bar.
 * Resilient to innerHTML re-renders by tracking previous bounds and re-attaching the indicator.
 */
export function bindSlidingIndicator(container, {
  itemSelector = 'button, [role="tab"]',
  variant = 'pill',
  activePredicate = el =>
    el.classList.contains('active') ||
    el.getAttribute('aria-selected') === 'true' ||
    el.getAttribute('aria-pressed') === 'true',
} = {}) {
  if (!container || !(container instanceof HTMLElement)) return null
  if (slidingIndicators.has(container)) {
    const existing = slidingIndicators.get(container)
    existing.sync(true)
    return existing
  }

  container.classList.add('ui-sliding-host')
  const indicator = document.createElement('span')
  indicator.className = `ui-sliding-indicator ui-sliding-${variant}`
  indicator.setAttribute('aria-hidden', 'true')
  container.prepend(indicator)

  let initialized = false
  let lastBounds = null
  let syncing = false

  const applyBounds = (bounds) => {
    indicator.style.opacity = '1'
    indicator.style.width = `${bounds.w}px`
    indicator.style.height = variant === 'underline' ? '2px' : `${bounds.h}px`
    indicator.style.transform = variant === 'underline'
      ? `translate3d(${bounds.x}px, ${bounds.y + bounds.h - 2}px, 0)`
      : `translate3d(${bounds.x}px, ${bounds.y}px, 0)`
  }

  const sync = (shouldAnimate = true) => {
    if (syncing) return
    syncing = true
    try {
      if (indicator.parentElement !== container) {
        container.prepend(indicator)
      }
      const target = findActiveControl(container, itemSelector, activePredicate)
      if (!target) {
        indicator.style.opacity = '0'
        lastBounds = null
        return
      }
      const hostRect = container.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      if (!hostRect.width || !targetRect.width) {
        indicator.style.opacity = '0'
        return
      }
      const scale = Number(document.documentElement.style.zoom) || 1
      const nextBounds = {
        x: (targetRect.left - hostRect.left + container.scrollLeft) / scale,
        y: (targetRect.top - hostRect.top + container.scrollTop) / scale,
        w: targetRect.width / scale,
        h: targetRect.height / scale,
      }

      const moved = Boolean(
        lastBounds &&
        (Math.abs(nextBounds.x - lastBounds.x) > 1 ||
          Math.abs(nextBounds.y - lastBounds.y) > 1 ||
          Math.abs(nextBounds.w - lastBounds.w) > 1)
      )
      const canAnimate = initialized && shouldAnimate && !prefersReducedMotion() && moved

      if (canAnimate && lastBounds) {
        applyBounds(lastBounds)
        const flipState = Flip.getState(indicator)
        applyBounds(nextBounds)
        Flip.from(flipState, {
          duration: 0.22,
          ease: 'power3.out',
          overwrite: true,
        })
      } else {
        applyBounds(nextBounds)
      }

      initialized = true
      lastBounds = nextBounds
    } finally {
      syncing = false
    }
  }

  const mutationObserver = new MutationObserver(mutations => {
    const relevant = mutations.some(m => m.target !== indicator && !(m.addedNodes.length === 1 && m.addedNodes[0] === indicator))
    if (relevant) requestAnimationFrame(() => sync(true))
  })
  mutationObserver.observe(container, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'aria-selected', 'aria-pressed', 'hidden'],
  })

  const resizeObserver = new ResizeObserver(() => sync(false))
  resizeObserver.observe(container)

  requestAnimationFrame(() => sync(false))

  const handle = {
    sync,
    destroy() {
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      indicator.remove()
      slidingIndicators.delete(container)
    },
  }
  slidingIndicators.set(container, handle)
  return handle
}

/**
 * Positions a floating menu using @floating-ui/dom and animates its entrance with Motion.
 */
export async function openFloatingElement(referenceEl, floatingEl, {
  placement = 'bottom-end',
  offsetPx = 6,
} = {}) {
  if (!referenceEl || !floatingEl) return
  const { x, y } = await computePosition(referenceEl, floatingEl, {
    placement,
    middleware: [offset(offsetPx), flip(), shift({ padding: 8 })],
  })
  Object.assign(floatingEl.style, {
    left: `${Math.round(x)}px`,
    top: `${Math.round(y)}px`,
    right: 'auto',
    bottom: 'auto',
  })
  if (!prefersReducedMotion()) {
    animate(
      floatingEl,
      { opacity: [0, 1], transform: ['scale(0.97) translateY(-3px)', 'scale(1) translateY(0)'] },
      { duration: 0.15, easing: [0.16, 1, 0.3, 1] }
    )
  }
}

/**
 * Animates a subtle tactile pulse for copy/save feedback buttons.
 */
export function pulseActionFeedback(buttonEl) {
  if (!buttonEl || prefersReducedMotion()) return
  animate(
    buttonEl,
    { transform: ['scale(0.93)', 'scale(1)'] },
    { duration: 0.18, easing: [0.16, 1, 0.3, 1] }
  )
}

let spotlightInstalled = false
export function installProximitySpotlight(doc = globalThis.document) {
  if (spotlightInstalled || !doc) return
  spotlightInstalled = true
  doc.addEventListener('pointermove', event => {
    if (prefersReducedMotion() || doc.body?.dataset.uiStyle === 'editorial') return
    const card = event.target instanceof Element
      ? event.target.closest('.doc-card, .dash-stat-card, .aic-card, .notes-doc-item')
      : null
    if (!card) return
    const rect = card.getBoundingClientRect()
    card.style.setProperty('--ui-mx', `${event.clientX - rect.left}px`)
    card.style.setProperty('--ui-my', `${event.clientY - rect.top}px`)
  }, { passive: true })
}
