import { icon } from './icons.js'

// Text stays a text node so translated messages and server errors remain safe.
export function setStatusState(element, message, kind = 'empty') {
  element.replaceChildren()
  element.classList.add('status-inline')
  element.dataset.state = kind
  if (!message) return
  const glyph = document.createElement('span')
  glyph.setAttribute('aria-hidden', 'true')
  glyph.innerHTML = icon(kind === 'error' ? 'alertTriangle' : kind === 'loading' ? 'refreshCw' : 'search', 18)
  const text = document.createElement('span')
  text.textContent = message
  element.append(glyph, text)
}
