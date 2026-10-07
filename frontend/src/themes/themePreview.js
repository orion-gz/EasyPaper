import { icon } from '../icons.js'

// A static miniature of the workspace: no live document IDs, requests or controls.
export function renderThemePreview(host, { labels, t, mode, tab }) {
  const node = (tag, className, text = '') => {
    const element = document.createElement(tag)
    element.className = className
    element.textContent = text
    return element
  }
  const item = (name, text, className = '') => {
    const element = node('span', `theme-sample-item ${className}`)
    const glyph = node('span', 'theme-sample-icon')
    glyph.innerHTML = icon(name, 14, 'aria-hidden="true"')
    element.append(glyph, node('span', '', text))
    return element
  }
  const lines = () => {
    const element = node('div', 'theme-sample-lines')
    element.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 6; i++) element.append(node('i', ''))
    return element
  }
  const library = mode === 'research' ? t('navigation:researchLibrary') : t('navigation:generalLibrary')
  const search = mode === 'research' ? t('navigation:researchSearch') : t('navigation:generalSearch')
  const shell = node('div', 'theme-sample-body')
  const side = node('aside', 'theme-sample-sidebar')
  side.append(item('bookOpen', 'EasyPaper', 'theme-sample-brand'))
  const modes = node('div', 'theme-sample-modes')
  for (const value of ['research', 'general']) modes.append(node('span', value === mode ? 'selected' : '', labels[value]))
  side.append(modes)
  for (const [glyph, text, active] of [
    ['grid', mode === 'research' ? t('navigation:researchDashboard') : t('navigation:generalDashboard')],
    ['bookOpen', library, true], ['clock', t('navigation:history')],
    ['messageCircle', mode === 'research' ? t('navigation:chats') : t('navigation:generalChats')],
    ['fileText', mode === 'research' ? t('navigation:notes') : t('navigation:generalNotes')],
  ]) side.append(item(glyph, text, active ? 'selected' : ''))
  const footer = node('div', 'theme-sample-sidebar-footer')
  footer.append(item('settings', t('navigation:settings')), item('logOut', t('navigation:logout')))
  side.append(footer)
  const workspace = node('div', 'theme-sample-workspace')
  const top = node('div', 'theme-sample-topbar')
  top.append(item('bookOpen', library, tab === 'library' ? 'theme-sample-tab' : ''))
  if (tab === 'reader') top.append(item('fileText', labels.sampleTitle, 'theme-sample-tab'))
  top.append(item('search', '', 'theme-sample-top-search'))
  workspace.append(top)
  if (tab === 'library') {
    const content = node('div', 'theme-sample-library')
    content.append(node('h4', '', library), item('search', search, 'theme-sample-search'))
    const filters = node('div', 'theme-sample-filters')
    filters.append(item('bookOpen', library, 'selected'), item('star', ''), item('grid', ''), item('list', ''))
    content.append(filters)
    const cards = node('div', 'theme-sample-cards')
    for (let i = 0; i < 2; i++) {
      const card = node('article', 'theme-sample-card')
      const heading = node('div', 'theme-sample-card-heading')
      const thumbnail = node('div', 'theme-sample-thumbnail')
      thumbnail.append(node('b', '', 'PDF'), lines())
      const title = node('div', '')
      title.append(node('h4', '', labels.sampleTitle), node('small', '', 'PDF'))
      heading.append(thumbnail, title)
      const progress = node('div', 'theme-sample-progress')
      progress.append(node('i', ''), node('span', '', i ? '48%' : '100%'))
      const actions = node('div', 'theme-sample-card-footer')
      actions.append(item('bookOpen', labels.reader), item('moreVertical', ''))
      card.append(heading, node('small', 'theme-sample-meta', '2026.10.07 · 12p'), progress, actions)
      cards.append(card)
    }
    content.append(cards, node('span', 'theme-sample-add', '+'))
    workspace.append(content)
  } else {
    const viewer = node('div', 'theme-sample-viewer')
    const toolbar = node('div', 'theme-sample-toolbar')
    toolbar.append(item('fileText', labels.sampleTitle), item('search', ''), item('moreVertical', ''))
    const panels = node('div', 'theme-sample-panels')
    const pages = node('div', 'theme-sample-pages')
    for (const region of ['paper', 'translation']) {
      const page = node('article', `theme-sample-${region}`)
      page.append(node('small', 'theme-sample-page-label', region === 'paper' ? labels.original : labels.translation), node('h4', '', labels.sampleTitle), node('p', '', labels.sampleText), lines(), node('p', '', labels.sampleText), lines())
      pages.append(page)
    }
    const chat = node('section', 'theme-sample-chat')
    const tabs = node('div', 'theme-sample-chat-tabs')
    tabs.append(node('span', 'selected', t('navigation:tabs.chat')), node('span', '', t('navigation:tabs.notes')))
    chat.append(tabs, node('p', 'theme-sample-chat-user', labels.sampleChat), node('p', 'theme-sample-answer', labels.sampleText), item('arrowRight', labels.sampleInput, 'theme-sample-composer'))
    panels.append(pages, chat)
    viewer.append(toolbar, panels, node('div', 'theme-sample-page-controls', '‹   1 / 12   ›    −  100%  +'))
    workspace.append(viewer)
  }
  shell.append(side, workspace)
  host.replaceChildren(shell)
}
