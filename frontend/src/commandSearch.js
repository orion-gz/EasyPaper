import { parseCommandQuery, commandArgumentError } from './commandArguments.js'
import { fetchLibrary } from './library.js'
import { compareDocsByLastRead, hasReadActivity } from './readPages.js'
import { icon } from './icons.js'
import { searchWorkspaceAPI } from './api.js'
import { isMinimalUi } from './minimalUi.js'
import { t, loadFeatureNamespaces } from './i18n.js'
import { readerFeatureEnabled, onReaderPreferences } from './readerPreferences.js'

export function installCommandSearch({ shell, mount, mode, runtime, navigate, actions, toast }) {
  const button = document.createElement('button'); button.type = 'button'; button.id = 'reader-command-search'; button.className = 'icon-btn'
  const dialog = document.createElement('dialog'); dialog.id = 'reader-command-dialog'
  const input = document.createElement('input'); input.type = 'search'; input.maxLength = 200
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'reader-command-results'); input.setAttribute('aria-autocomplete', 'list')
  const list = document.createElement('div'); list.id = 'reader-command-results'; list.setAttribute('role', 'listbox')
  const status = document.createElement('p'); status.setAttribute('role', 'status')
  const searchBar = document.createElement('div'); searchBar.className = 'reader-command-bar'
  const searchIcon = document.createElement('span'); searchIcon.className = 'reader-command-icon'; searchIcon.setAttribute('aria-hidden', 'true'); searchIcon.innerHTML = icon('search', 24)
  const escapeHint = document.createElement('kbd'); escapeHint.textContent = 'esc'; escapeHint.setAttribute('aria-hidden', 'true')
  const help = document.createElement('p'); help.id = 'reader-command-help'
  input.setAttribute('aria-describedby', help.id)
  searchBar.append(searchIcon, input, escapeHint)
  dialog.append(searchBar, help, status, list); document.body.append(dialog); mount?.append(button)
  let previous; let items = []; let selected = 0; let controller; let revision = 0; let timer
  function resetResults() { items = []; selected = 0; list.replaceChildren(); input.removeAttribute('aria-activedescendant') }
  function close() { resetResults(); revision++; controller?.abort(); clearTimeout(timer); dialog.close(); previous?.focus?.({ preventScroll: true }) }
  const running = new Set()
  let readerContext
  function setQuery(value) { input.value = value; input.focus(); clearTimeout(timer); void search() }
  function commands(argument = '') {
    const reader = runtime()?.ready ? runtime() : null
    const readerState = reader?.commandState() || {}
    const readerCommand = (id, text, extra = {}) => ({ id, text, ...extra, run: () => reader.executeCommand(id, argument, readerContext) })
    const openSettings = category => document.dispatchEvent(new CustomEvent('easypaper:open-settings', { detail: { category } }))
    const settings = [
      ['general', t('settings:categoryGeneral'), 'language appearance theme'],
      ['translation', t('settings:categoryTranslation'), 'translate language'],
      ['viewer', t('settings:categoryViewer'), 'reader zoom'],
      ['shortcuts', t('settings:categoryShortcuts'), 'keyboard hotkeys'],
      ['automation', t('settings:categoryAutomation'), 'generation'],
      ['model', t('settings:categoryModel'), 'models ai provider'],
      ['account', t('settings:categoryAccount'), 'password security'],
      ['data-system', t('settings:categoryDataSystem'), 'export import backup cache'],
      ['info', t('settings:categoryInfo'), 'about update version'],
    ].map(([id, text, keywords]) => ({ id, text, keywords, global: true, run: () => openSettings(`tab-${id}`) }))
    const pages = ['dashboard', 'library', 'history', 'chats', 'notes']
      .filter(page => !isMinimalUi() || page === 'library')
      .map(page => ({ id: page, text: t(`navigation:${page}`), global: true, run: () => document.querySelector(`.sidebar-nav-item[data-page="${page}"]`)?.click() }))
    return [
      { id: 'focus', text: t('viewer:comfort.focusReading'), feature: 'focusReading', run: () => reader.toggleFocusReading() },
      { id: 'translate', text: t('viewer:comfort.translationCommand'), run: () => reader.toggleTranslation() },
      { id: 'find', text: t('viewer:comfort.findCommand'), run: () => reader.find() },
      { id: 'settings', text: t('viewer:comfort.settingsCommand'), global: true, run: () => openSettings('tab-general') },
      { id: 'theme', text: t('navigation:theme'), usage: '/theme [light|dark]', global: true, run: () => actions.theme(argument.toLowerCase()) },
      { id: 'logout', text: t('navigation:logout'), keywords: 'sign out', global: true, run: () => document.getElementById('sidebar-logout-btn')?.click() },
      { id: 'open', text: t('viewer:commands.open'), usage: '/open [query]', global: true, keepOpen: true, run: () => setQuery('/open ') },
      { id: 'recent', text: t('viewer:commands.recent'), global: true, keepOpen: true, run: () => setQuery('/recent ') },
      { id: 'help', text: t('viewer:commands.help'), global: true, keepOpen: true, run: () => setQuery('/') },
      { id: 'upload', text: t('viewer:commands.upload'), global: true, run: actions.upload },
      { id: 'import-url', text: t('viewer:commands.importUrl'), global: true, run: actions.importUrl },
      { id: 'tasks', text: t('viewer:commands.tasks'), global: true, disabled: !readerFeatureEnabled('taskProgress') ? t('viewer:comfort.featureDisabled') : '', run: () => document.getElementById('reader-tasks')?.click() },
      { id: 'sidebar', text: t('viewer:commands.sidebar'), global: true, disabled: isMinimalUi() ? t('viewer:commands.minimalUnavailable') : '', run: actions.sidebar },
      { id: 'fullscreen', text: t('navigation:tabs.fullscreen'), global: true, run: actions.fullscreen },
      { id: 'close-tab', text: t('viewer:commands.closeTab'), global: true, disabled: !actions.canClose() ? t('viewer:commands.cannotClose') : '', run: actions.closeTab },
      { id: 'reopen-tab', text: t('viewer:commands.reopenTab'), global: true, disabled: !actions.canReopen() ? t('viewer:commands.noClosedTab') : '', run: actions.reopenTab },
      readerCommand('next-page', t('viewer:commands.nextPage'), { disabled: readerState.page >= readerState.totalPages ? t('viewer:commands.lastPage') : '' }),
      readerCommand('previous-page', t('viewer:commands.previousPage'), { disabled: readerState.page <= 1 ? t('viewer:commands.firstPage') : '' }),
      readerCommand('page', t('viewer:commands.page'), { usage: '/page <number>' }),
      readerCommand('zoom', t('viewer:commands.zoom'), { usage: '/zoom <50–300>' }),
      readerCommand('zoom-in', t('viewer:commands.zoomIn'), { disabled: readerState.zoom >= 3 ? t('viewer:commands.zoomLimit') : '' }),
      readerCommand('zoom-out', t('viewer:commands.zoomOut'), { disabled: readerState.zoom <= 0.5 ? t('viewer:commands.zoomLimit') : '' }),
      readerCommand('fit-width', t('navigation:tabs.fitWidth')),
      readerCommand('outline', t('navigation:tabs.outline')),
      readerCommand('bookmark', t('viewer:commands.bookmark')),
      readerCommand('memo', t('viewer:commands.memo')),
      readerCommand('ask', t('viewer:commands.ask'), { usage: '/ask [question]', disabled: readerState.chatBusy ? t('viewer:commands.chatBusy') : '' }),
      readerCommand('new-chat', t('viewer:commands.newChat'), { disabled: readerState.chatBusy ? t('viewer:commands.chatBusy') : '' }),
      readerCommand('summarize', t('viewer:commands.summarize'), { disabled: readerState.chatBusy ? t('viewer:commands.chatBusy') : '' }),
      readerCommand('copy-citation', t('viewer:commands.copyCitation')),
      ...settings, ...pages,
    ].map(command => ({ ...command, kind: 'command', disabled: running.has(command.id) ? t('viewer:commands.running') : !command.global && !reader ? t('viewer:comfort.readerRequired') : command.feature && !readerFeatureEnabled(command.feature) ? t('viewer:comfort.featureDisabled') : command.disabled || (commandArgumentError(command.id, argument, readerState.totalPages || 0) ? t('viewer:commands.usage', { usage: command.usage }) : '') }))
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
    if (item.run) {
      const current = commands(item.argument || '').find(command => command.id === item.id)
      if (!current || current.disabled) { void search(); return }
      if (!item.keepOpen) close()
      running.add(item.id)
      try { Promise.resolve(current.run()).catch(error => toast(error?.message || t('viewer:commands.failed'), 'error')).finally(() => running.delete(item.id)) }
      catch (error) { running.delete(item.id); toast(error?.message || t('viewer:commands.failed'), 'error') }
      return
    }
    close()
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
      const detail = document.createElement('p'); detail.textContent = item.kind === 'command' ? `${item.usage || `/${item.id}`}${item.disabled ? ` · ${item.disabled}` : ''}` : item.text
      option.append(title, detail); option.addEventListener('click', () => execute(index)); list.append(option)
    })
    status.textContent = items.length ? '' : t('viewer:comfort.searchEmpty'); select(0)
  }
  async function search() {
    const token = ++revision; controller?.abort(); controller = new AbortController()
    const query = input.value.trim()
    status.textContent = t('viewer:comfort.searchLoading')
    try {
      await loadFeatureNamespaces('settings')
      if (token !== revision || !dialog.open) return
      const parsed = parseCommandQuery(input.value)
      if (parsed && ['open', 'recent'].includes(parsed.name) && parsed.hasArgument) {
        const result = await fetchLibrary({ documentMode: mode() })
        if (token !== revision || !dialog.open) return
        const docs = (result.documents || []).filter(doc => parsed.name !== 'recent' || hasReadActivity(doc.metadata))
        if (parsed.name === 'recent') docs.sort(compareDocsByLastRead)
        const needle = parsed.argument.toLocaleLowerCase()
        render(docs.filter(doc => `${doc.filename || ''} ${doc.metadata?.title || ''}`.toLocaleLowerCase().includes(needle)).slice(0, 50).map(doc => ({ kind: 'document', doc_id: doc.id, title: doc.metadata?.title || doc.filename, text: doc.filename || '' })))
        return
      }
      const all = commands(parsed?.argument)
      const exact = parsed && all.find(item => item.id === parsed.name)
      let available = exact ? [exact] : all.filter(item => `${item.id} ${item.text} ${item.keywords || ''}`.toLocaleLowerCase().includes(query.replace(/^\//, '').trim().toLocaleLowerCase()))
      if (parsed) {
        available = available.map(item => {
          const argument = exact ? parsed.argument : ''
          const invalid = commandArgumentError(item.id, argument, runtime()?.commandState().totalPages || 0)
            || (argument && !['page', 'zoom', 'theme', 'ask'].includes(item.id))
          return { ...item, argument, disabled: item.disabled || (invalid ? t('viewer:commands.usage', { usage: item.usage || `/${item.id}` }) : '') }
        })
        render(available); return
      }
      const result = await searchWorkspaceAPI(query, mode(), controller.signal)
      if (token === revision && dialog.open) render([...(result.results || []), ...(!query ? available : [])])
    } catch (error) { if (token === revision && error.name !== 'AbortError') { render([]); status.textContent = t('viewer:comfort.searchError') } }
  }
  function open() {
    if (shell.hidden || !readerFeatureEnabled('commandSearch')) return
    resetResults(); readerContext = runtime()?.captureCommandContext(); previous = document.activeElement; input.value = ''; dialog.showModal(); input.focus(); void search()
  }
  const handleShortcut = event => {
    if (event.isComposing || event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || (event.code !== 'KeyK' && event.key.toLowerCase() !== 'k') || !readerFeatureEnabled('commandSearch') || shell.hidden) return
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
    button.hidden = !readerFeatureEnabled('commandSearch'); button.innerHTML = icon('search', 18); button.title = `${t('viewer:comfort.commandSearch')} (Ctrl/Cmd+K)`; button.setAttribute('aria-label', t('viewer:comfort.commandSearch')); button.setAttribute('aria-keyshortcuts', 'Control+K Meta+K')
    help.textContent = t('viewer:comfort.commandHint')
    input.placeholder = t('viewer:comfort.searchHint'); input.setAttribute('aria-label', input.placeholder); dialog.setAttribute('aria-label', t('viewer:comfort.commandSearch'))
    if (button.hidden && dialog.open) close()
  }
  new MutationObserver(() => { if (shell.hidden && dialog.open) close() }).observe(shell, { attributes: true, attributeFilter: ['hidden'] })
  document.addEventListener('easypaper:locale-changed', sync)
  onReaderPreferences(sync); sync()
  return { handleShortcut }
}
