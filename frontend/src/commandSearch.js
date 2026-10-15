import { icon } from './icons.js'
import { searchWorkspaceAPI } from './api.js'
import { t } from './i18n.js'
import { readerFeatureEnabled, onReaderPreferences } from './readerPreferences.js'

export function installCommandSearch({ shell, mount, mode, runtime, navigate }) {
  const button = document.createElement('button'); button.type = 'button'; button.id = 'reader-command-search'; button.className = 'icon-btn'
  const dialog = document.createElement('dialog'); dialog.id = 'reader-command-dialog'
  const input = document.createElement('input'); input.type = 'search'; input.maxLength = 200
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'reader-command-results'); input.setAttribute('aria-autocomplete', 'list')
  const list = document.createElement('div'); list.id = 'reader-command-results'; list.setAttribute('role', 'listbox')
  const status = document.createElement('p'); status.setAttribute('role', 'status')
  dialog.append(input, status, list); document.body.append(dialog); mount?.append(button)
  let previous; let items = []; let selected = 0; let controller; let revision = 0; let timer
  function resetResults() { items = []; selected = 0; list.replaceChildren(); input.removeAttribute('aria-activedescendant') }
  function close() { resetResults(); revision++; controller?.abort(); clearTimeout(timer); dialog.close(); previous?.focus?.({ preventScroll: true }) }
  function commands() {
    const reader = runtime()
    return [
      { text: t('viewer:comfort.focusReading'), feature: 'focusReading', run: () => reader.toggleFocusReading() },
      { text: t('viewer:comfort.translationCommand'), run: () => reader.toggleTranslation() },
      { text: t('viewer:comfort.findCommand'), run: () => reader.find() },
      { text: t('viewer:comfort.settingsCommand'), global: true, run: () => document.getElementById('sidebar-settings-btn')?.click() },
    ].map(command => ({ ...command, kind: 'command', disabled: !command.global && !reader ? t('viewer:comfort.readerRequired') : command.feature && !readerFeatureEnabled(command.feature) ? t('viewer:comfort.featureDisabled') : '' }))
  }
  function select(index) {
    selected = index
    const options = [...list.children]
    options.forEach((option, i) => option.setAttribute('aria-selected', String(i === selected)))
    if (options[selected]) { input.setAttribute('aria-activedescendant', options[selected].id); options[selected].scrollIntoView({ block: 'nearest' }) }
    else input.removeAttribute('aria-activedescendant')
  }
  function execute(index) {
    const item = items[index]
    if (!item || item.disabled) return
    close()
    if (item.run) { item.run(); return }
    const params = new URLSearchParams({ id: item.doc_id })
    if (item.kind === 'memo') { params.set('page', item.page); if (item.memo_id) params.set('memoId', item.memo_id) }
    if (item.kind === 'question') { params.set('chat', '1'); params.set('question', item.question) }
    navigate(`#viewer?${params}`)
  }
  function render(next) {
    items = next; list.replaceChildren()
    const labels = { document: t('viewer:comfort.documentResult'), memo: t('viewer:comfort.memoResult'), question: t('viewer:comfort.questionResult'), command: t('viewer:comfort.commandResult') }
    items.forEach((item, index) => {
      const option = document.createElement('div'); option.id = `reader-command-${index}`; option.setAttribute('role', 'option')
      option.setAttribute('aria-disabled', String(Boolean(item.disabled)))
      const title = document.createElement('strong'); title.textContent = `${labels[item.kind]} · ${item.title || item.text}`
      const detail = document.createElement('p'); detail.textContent = item.disabled || (item.title ? item.text : '')
      option.append(title, detail); option.addEventListener('click', () => execute(index)); list.append(option)
    })
    status.textContent = items.length ? '' : t('viewer:comfort.searchEmpty'); select(0)
  }
  async function search() {
    const token = ++revision; controller?.abort(); controller = new AbortController()
    const query = input.value.trim()
    const available = commands().filter(item => item.text.toLocaleLowerCase().includes(query.replace(/^>/, '').trim().toLocaleLowerCase()))
    if (query.startsWith('>')) { render(available); return }
    status.textContent = t('viewer:comfort.searchLoading')
    try {
      const result = await searchWorkspaceAPI(query, mode(), controller.signal)
      if (token === revision && dialog.open) render([...(result.results || []), ...(!query ? available : [])])
    } catch (error) { if (token === revision && error.name !== 'AbortError') { render([]); status.textContent = t('viewer:comfort.searchError') } }
  }
  function open() {
    if (shell.hidden || !readerFeatureEnabled('commandSearch')) return
    resetResults(); previous = document.activeElement; input.value = ''; dialog.showModal(); input.focus(); void search()
  }
  const handleShortcut = event => {
    if (event.isComposing || event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k' || !readerFeatureEnabled('commandSearch') || shell.hidden) return
    event.preventDefault(); event.stopPropagation(); if (dialog.open) close(); else open()
  }
  button.addEventListener('click', open)
  document.addEventListener('keydown', handleShortcut)
  input.addEventListener('input', () => { items = []; list.replaceChildren(); input.removeAttribute('aria-activedescendant'); status.textContent = t('viewer:comfort.searchLoading'); revision++; controller?.abort(); clearTimeout(timer); timer = setTimeout(search, 200) })
  input.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (items.length) select((selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length) }
    if (event.key === 'Enter') { event.preventDefault(); execute(selected) }
  })
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close() } })
  const sync = () => {
    button.hidden = !readerFeatureEnabled('commandSearch'); button.innerHTML = icon('search', 18); button.title = t('viewer:comfort.commandSearch'); button.setAttribute('aria-label', button.title)
    input.placeholder = t('viewer:comfort.searchHint'); input.setAttribute('aria-label', input.placeholder); dialog.setAttribute('aria-label', button.title)
    if (button.hidden && dialog.open) close()
  }
  new MutationObserver(() => { if (shell.hidden && dialog.open) close() }).observe(shell, { attributes: true, attributeFilter: ['hidden'] })
  document.addEventListener('easypaper:locale-changed', sync)
  onReaderPreferences(sync); sync()
  return { handleShortcut }
}
