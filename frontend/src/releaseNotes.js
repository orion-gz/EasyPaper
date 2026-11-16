import { Marked } from 'marked'
import DOMPurify from 'dompurify'

// Keep release-specific parsing independent of chat/memo marked extensions.
const markdown = new Marked({ gfm: true })
const calloutTitles = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }

function externalUrl(value) {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url : null
  } catch (_) {
    return null
  }
}

function linkCard(doc, url, label) {
  const card = doc.createElement('a')
  card.className = 'release-link-card'
  card.href = url.href
  const title = doc.createElement('strong')
  title.textContent = label || url.hostname
  const address = doc.createElement('span')
  address.textContent = url.href
  card.append(title, address)
  return card
}

export function renderReleaseNotes(container, body) {
  if (!container) return
  // Iframes are admitted only into an inert fragment, then replaced with links.
  // No embedded third-party page is ever mounted in the application.
  const fragment = DOMPurify.sanitize(markdown.parse(body || '세부 변경 내역이 제공되지 않았습니다.'), {
    RETURN_DOM_FRAGMENT: true,
    ADD_TAGS: ['iframe'],
  })
  const doc = container.ownerDocument

  fragment.querySelectorAll('iframe').forEach(frame => {
    const url = externalUrl(frame.getAttribute('src'))
    if (url) frame.replaceWith(linkCard(doc, url, frame.getAttribute('title')))
    else frame.remove()
  })

  fragment.querySelectorAll('blockquote').forEach(quote => {
    const first = quote.firstElementChild
    const text = first?.firstChild
    if (first?.tagName !== 'P' || text?.nodeType !== 3) return
    const match = text.textContent.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[+-])?[^\S\r\n]*([^\r\n]*)(?:\r?\n|$)/i)
    if (!match) return
    const type = match[1].toLowerCase()
    quote.classList.add('release-callout')
    quote.dataset.callout = type
    const title = doc.createElement('p')
    title.className = 'release-callout-title'
    title.textContent = match[2].trim() || calloutTitles[type]
    text.textContent = text.textContent.slice(match[0].length)
    quote.prepend(title)
    if (!first.textContent && !first.children.length) first.remove()
  })

  fragment.querySelectorAll('p').forEach(paragraph => {
    const link = paragraph.firstElementChild
    if (link?.tagName !== 'A' || paragraph.children.length !== 1 || link.querySelector('img')) return
    if (paragraph.textContent.trim() !== link.textContent.trim()) return
    const url = externalUrl(link.getAttribute('href'))
    // A bare URL on its own line is a card; named Markdown links remain inline.
    if (url && link.textContent.trim() === link.getAttribute('href')) {
      paragraph.replaceWith(linkCard(doc, url))
    }
  })

  fragment.querySelectorAll('a').forEach(link => {
    if (!externalUrl(link.getAttribute('href'))) return
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  })
  fragment.querySelectorAll('img').forEach(image => {
    image.loading = 'lazy'
  })

  container.replaceChildren(fragment)
  container.classList.add('release-notes-content')
}

export function installReleaseNotesLinks(container, openExternalUrl) {
  container?.addEventListener('click', event => {
    const link = event.target.closest?.('.release-notes-content a')
    if (!link || !container.contains(link)) return
    const url = externalUrl(link.getAttribute('href'))
    if (!url) return
    event.preventDefault()
    openExternalUrl(url.href)
  })
}
