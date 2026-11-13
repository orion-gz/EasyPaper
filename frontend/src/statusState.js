import { icon } from './icons.js'

// Text stays a text node so translated messages and server errors remain safe.
export function setStatusState(element, message, kind = 'empty', { action, skeleton = false } = {}) {
  element.replaceChildren()
  element.classList.add('status-inline')
  element.dataset.state = kind
  element.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  element.setAttribute('aria-atomic', 'true')
  if (!message) return
  const glyph = document.createElement('span')
  glyph.setAttribute('aria-hidden', 'true')
  glyph.innerHTML = icon(kind === 'error' ? 'alertTriangle' : kind === 'loading' ? 'refreshCw' : 'search', 18)
  const text = document.createElement('span')
  text.textContent = message
  element.append(glyph, text)
  if (kind === 'loading' && skeleton) {
    const placeholder = document.createElement('span')
    placeholder.className = 'status-skeleton'
    placeholder.setAttribute('aria-hidden', 'true')
    element.append(placeholder)
  }
  if (action) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'status-action'; button.textContent = action.label
    button.addEventListener('click', action.run)
    element.append(button)
  }
}
