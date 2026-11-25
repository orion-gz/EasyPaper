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
    duration: prefersReducedMotion() ? 0 : (options.duration ?? 190),
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
  for (const selector of selectors) {
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
 * Binds a shared-element GSAP Flip / smooth sliding indicator pill or underline to a tab/segment bar.
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
    existing.sync(false)
    return existing
  }

  container.classList.add('ui-sliding-host')
  const indicator = document.createElement('span')
  indicator.className = `ui-sliding-indicator ui-sliding-${variant}`
  indicator.setAttribute('aria-hidden', 'true')
  container.prepend(indicator)

  let initialized = false
  let lastTarget = null
  let syncing = false

  const sync = (shouldAnimate = true) => {
    if (syncing) return
    syncing = true
    try {
      const target = findActiveControl(container, itemSelector, activePredicate)
      if (!target) {
        indicator.style.opacity = '0'
        lastTarget = null
        return
      }
      const hostRect = container.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      if (!hostRect.width || !targetRect.width) {
        indicator.style.opacity = '0'
        return
      }
      const scale = Number(document.documentElement.style.zoom) || 1
      const x = (targetRect.left - hostRect.left + container.scrollLeft) / scale
      const y = (targetRect.top - hostRect.top + container.scrollTop) / scale
      const w = targetRect.width / scale
      const h = targetRect.height / scale

      const canAnimate = initialized && shouldAnimate && !prefersReducedMotion() && lastTarget && lastTarget !== target
      const flipState = canAnimate ? Flip.getState(indicator) : null

      indicator.style.opacity = '1'
      indicator.style.width = `${w}px`
      indicator.style.height = variant === 'underline' ? '2px' : `${h}px`
      indicator.style.transform = variant === 'underline'
        ? `translate3d(${x}px, ${y + h - 2}px, 0)`
        : `translate3d(${x}px, ${y}px, 0)`

      if (flipState) {
        Flip.from(flipState, {
          duration: 0.22,
          ease: 'power3.out',
          overwrite: true,
        })
      }
      initialized = true
      lastTarget = target
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
 * Animates a subtle blur-scale icon swap for copy/save feedback buttons.
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
