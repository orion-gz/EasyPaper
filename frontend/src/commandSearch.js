import { setStatusState } from './statusState.js'
import { parseCommandQuery, commandArgumentError } from './commandArguments.js'
import { fetchLibrary } from './library.js'
import { compareDocsByLastRead, hasReadActivity } from './readPages.js'
import { icon } from './icons.js'
import { searchWorkspaceAPI } from './api.js'
import { isMinimalUi } from './minimalUi.js'
import { t, loadFeatureNamespaces } from './i18n.js'
import { readerFeatureEnabled, onReaderPreferences } from './readerPreferences.js'

const KIND_RANK = { document: 0, memo: 1, question: 2, command: 3 }
const PAGE_ICONS = { dashboard: 'home', library: 'bookOpen', history: 'clock', chats: 'messageCircle', notes: 'fileText' }

function itemIconName(item) {
  if (item.kind === 'document') return 'fileText'
  if (item.kind === 'memo') return 'edit3'
  if (item.kind === 'question') return 'messageCircle'
  if (PAGE_ICONS[item.id]) return PAGE_ICONS[item.id]
  if (['settings', 'general', 'translation', 'viewer', 'shortcuts', 'automation', 'model', 'account', 'data-system', 'info'].includes(item.id)) return 'settings'
  if (['upload', 'import-url'].includes(item.id)) return 'download'
  if (['find', 'open', 'recent'].includes(item.id)) return 'search'
  if (['ask', 'new-chat', 'summarize'].includes(item.id)) return 'messageCircle'
  if (item.id === 'logout') return 'logOut'
  return 'terminal'
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createHighlightedContent(text, needle) {
  const str = String(text || '')
  const frag = document.createDocumentFragment()
  if (!needle || needle.length > 80) {
    frag.append(document.createTextNode(str))
    return frag
  }
  const regex = new RegExp(escapeRegExp(needle), 'gi')
  let lastIndex = 0
  let matches = 0
  let match
  while ((match = regex.exec(str)) !== null && matches < 4) {
    if (match[0].length === 0) { regex.lastIndex++; continue }
    if (match.index > lastIndex) frag.append(document.createTextNode(str.slice(lastIndex, match.index)))
    const mark = document.createElement('mark')
    mark.className = 'reader-command-match'
    mark.textContent = match[0]
    frag.append(mark)
    lastIndex = match.index + match[0].length
    matches++
  }
  if (lastIndex < str.length) frag.append(document.createTextNode(str.slice(lastIndex)))
  return frag
}

export function installCommandSearch({ shell, mode, runtime, navigate, actions, toast }) {
  const dialog = document.createElement('dialog'); dialog.id = 'reader-command-dialog'
  const input = document.createElement('input'); input.type = 'search'; input.maxLength = 200
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', 'reader-command-results'); input.setAttribute('aria-autocomplete', 'list')
  const list = document.createElement('div'); list.id = 'reader-command-results'; list.setAttribute('role', 'listbox')
  const status = document.createElement('p'); status.className = 'reader-command-status'; status.setAttribute('role', 'status')
  const searchBar = document.createElement('div'); searchBar.className = 'reader-command-bar'
  const searchIcon = document.createElement('span'); searchIcon.className = 'reader-command-icon'; searchIcon.setAttribute('aria-hidden', 'true'); searchIcon.innerHTML = icon('search', 18)
  const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'reader-command-close'
  const escapeHint = document.createElement('kbd'); escapeHint.textContent = 'esc'; escapeHint.setAttribute('aria-hidden', 'true')
  const closeIcon = document.createElement('span'); closeIcon.className = 'reader-command-close-icon'; closeIcon.setAttribute('aria-hidden', 'true'); closeIcon.innerHTML = icon('x', 15)
  closeBtn.append(escapeHint, closeIcon)
  const help = document.createElement('p'); help.id = 'reader-command-help'
  const footer = document.createElement('div'); footer.className = 'reader-command-footer'; footer.setAttribute('aria-hidden', 'true')
  const navLabel = document.createElement('span'); const runLabel = document.createElement('span'); const closeLabel = document.createElement('span')
  const makeFooterHint = (keys, labelEl) => {
    const wrap = document.createElement('span'); wrap.className = 'reader-command-footer-item'
    keys.forEach(k => { const kbd = document.createElement('kbd'); kbd.textContent = k; wrap.append(kbd) })
    wrap.append(labelEl); return wrap
  }
  footer.append(makeFooterHint(['↑', '↓'], navLabel), makeFooterHint(['↵'], runLabel), makeFooterHint(['esc'], closeLabel))
  input.setAttribute('aria-describedby', help.id)
  searchBar.append(searchIcon, input, closeBtn)
  searchBar.addEventListener('click', event => { if (!event.target.closest('button') && event.target !== input) input.focus() })
  dialog.append(searchBar, help, status, list, footer); document.body.append(dialog)
  let previous; let innerPrevious; let items = []; let selected = 0; let controller; let revision = 0; let timer
  function resetResults() { items = []; selected = 0; list.replaceChildren(); input.removeAttribute('aria-activedescendant'); input.setAttribute('aria-expanded', 'false') }
  function close() {
    resetResults(); revision++; controller?.abort(); clearTimeout(timer); dialog.close()
    const target = innerPrevious?.isConnected ? innerPrevious : previous
    target?.focus?.({ preventScroll: true })
    innerPrevious = null
  }
  closeBtn.addEventListener('click', close)
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
    const options = [...list.querySelectorAll('[role="option"]')]
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
  function render(next, highlightNeedle = '') {
    const ordered = [...next].sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)))
    items = ordered; list.replaceChildren()
    input.setAttribute('aria-expanded', String(items.length > 0))
    const labels = { document: t('viewer:comfort.documentResult'), memo: t('viewer:comfort.memoResult'), question: t('viewer:comfort.questionResult'), command: t('viewer:comfort.commandResult') }
    const groups = new Map()
    items.forEach((item, index) => {
      let groupEl = groups.get(item.kind)
      if (!groupEl) {
        groupEl = document.createElement('div')
        groupEl.className = 'reader-command-group'
        groupEl.setAttribute('role', 'group')
        const groupHeadingId = `reader-command-group-${item.kind}`
        groupEl.setAttribute('aria-labelledby', groupHeadingId)
        const groupLabel = document.createElement('div')
        groupLabel.id = groupHeadingId
        groupLabel.className = 'reader-command-group-label'
        groupLabel.setAttribute('role', 'presentation')
        groupLabel.textContent = labels[item.kind] || item.kind
        groupEl.append(groupLabel)
        groups.set(item.kind, groupEl)
        list.append(groupEl)
      }

      const option = document.createElement('div'); option.id = `reader-command-${index}`; option.setAttribute('role', 'option')
      option.setAttribute('aria-disabled', String(Boolean(item.disabled)))

      const iconWrap = document.createElement('span')
      iconWrap.className = 'reader-command-item-icon'
      iconWrap.setAttribute('aria-hidden', 'true')
      iconWrap.innerHTML = icon(itemIconName(item), 14)

      const body = document.createElement('div')
      body.className = 'reader-command-item-body'
      const title = document.createElement('strong')
      title.className = 'reader-command-item-title'
      title.append(createHighlightedContent(item.title || item.text, highlightNeedle))

      const detail = document.createElement('p')
      detail.className = 'reader-command-item-detail'
      if (item.kind === 'command') {
        detail.textContent = item.disabled || ''
      } else {
        detail.append(createHighlightedContent(item.text || '', highlightNeedle))
      }
      body.append(title, detail)

      const meta = document.createElement('span')
      meta.className = 'reader-command-item-meta'
      if (item.kind === 'command') {
        const kbd = document.createElement('kbd')
        kbd.className = 'reader-command-slash'
        kbd.textContent = item.usage || `/${item.id}`
        meta.append(kbd)
      } else if (Number.isInteger(item.page) && item.page > 0) {
        const chip = document.createElement('span')
        chip.className = 'reader-command-page-chip'
        chip.textContent = t('viewer:pageLabel', { page: item.page })
        meta.append(chip)
      }

      option.append(iconWrap, body)
      if (meta.childNodes.length) option.append(meta)
      option.addEventListener('pointerenter', () => { if (selected !== index) select(index) })
      option.addEventListener('click', () => execute(index))
      groupEl.append(option)
    })
    setStatusState(status, items.length ? '' : t('viewer:comfort.searchEmpty'))
    const firstEnabled = items.findIndex(item => !item.disabled)
    select(firstEnabled >= 0 ? firstEnabled : 0)
  }
  async function search() {
    const token = ++revision; controller?.abort(); controller = new AbortController()
    const query = input.value.trim()
    setStatusState(status, t('viewer:comfort.searchLoading'), 'loading')
    try {
      await loadFeatureNamespaces('settings')
      if (token !== revision || !dialog.open) return
      const parsed = parseCommandQuery(input.value)
      const all = commands(parsed?.argument)
      const exactId = parsed && all.find(item => item.id === parsed.name)
      const localizedOpenRecent = parsed && !exactId && parsed.hasArgument && parsed.name
        ? all.find(item => ['open', 'recent'].includes(item.id) && item.text.toLocaleLowerCase().startsWith(parsed.name))
        : null
      const openCmdName = exactId && ['open', 'recent'].includes(exactId.id) ? exactId.id : localizedOpenRecent?.id
      if (parsed && openCmdName && parsed.hasArgument) {
        const result = await fetchLibrary({ documentMode: mode() })
        if (token !== revision || !dialog.open) return
        const docs = (result.documents || []).filter(doc => openCmdName !== 'recent' || hasReadActivity(doc.metadata))
        if (openCmdName === 'recent') docs.sort(compareDocsByLastRead)
        const needle = parsed.argument.toLocaleLowerCase()
        render(docs.filter(doc => `${doc.filename || ''} ${doc.metadata?.title || ''}`.toLocaleLowerCase().includes(needle)).slice(0, 50).map(doc => ({ kind: 'document', doc_id: doc.id, title: doc.metadata?.title || doc.filename, text: doc.filename || '' })), parsed.argument)
        return
      }
      const fullSlashQuery = query.replace(/^\//, '').trim()
      const fullSlashLower = fullSlashQuery.toLocaleLowerCase()
      const directMatches = exactId ? [exactId] : all.filter(item => `${item.id} ${item.text} ${item.keywords || ''}`.toLocaleLowerCase().includes(fullSlashLower))
      const localizedArgMatch = parsed && !exactId && directMatches.length === 0 && parsed.hasArgument && parsed.name
        ? all.find(item => ['page', 'zoom', 'theme', 'ask'].includes(item.id) && item.text.toLocaleLowerCase().startsWith(parsed.name))
        : null
      let available = localizedArgMatch ? [localizedArgMatch] : directMatches
      const matchedCommand = exactId || localizedArgMatch
      if (parsed) {
        available = available.map(item => {
          const argument = matchedCommand ? parsed.argument : ''
          const invalid = commandArgumentError(item.id, argument, runtime()?.commandState().totalPages || 0)
            || (argument && !['page', 'zoom', 'theme', 'ask'].includes(item.id))
          return { ...item, argument, disabled: item.disabled || (invalid ? t('viewer:commands.usage', { usage: item.usage || `/${item.id}` }) : '') }
        })
        render(available, matchedCommand ? '' : fullSlashQuery); return
      }
      const result = await searchWorkspaceAPI(query, mode(), controller.signal)
      if (token === revision && dialog.open) render([...(result.results || []), ...(!query ? available : [])], query)
    } catch (error) { if (token === revision && error.name !== 'AbortError') { render([]); setStatusState(status, t('viewer:comfort.searchError'), 'error', { action: { label: t('common:briefing.retry'), run: search } }) } }
  }
  function open() {
    if (shell.hidden || !readerFeatureEnabled('commandSearch')) return
    resetResults(); readerContext = runtime()?.captureCommandContext()
    previous = document.activeElement
    innerPrevious = previous?.tagName === 'IFRAME' ? previous.contentDocument?.activeElement : null
    input.value = ''; dialog.showModal(); input.focus(); void search()
  }
  const handleShortcut = event => {
    if (event.isComposing || event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || (event.code !== 'KeyK' && event.key.toLowerCase() !== 'k') || !readerFeatureEnabled('commandSearch') || shell.hidden) return
    event.preventDefault(); event.stopPropagation(); if (dialog.open) close(); else open()
  }
  document.addEventListener('keydown', handleShortcut)
  input.addEventListener('input', () => { items = []; list.replaceChildren(); input.removeAttribute('aria-activedescendant'); input.setAttribute('aria-expanded', 'false'); setStatusState(status, t('viewer:comfort.searchLoading'), 'loading'); revision++; controller?.abort(); clearTimeout(timer); timer = setTimeout(search, 200) })
  input.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (items.length) select((selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length); return }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Home' && items.length) { event.preventDefault(); select(0); return }
    if ((event.ctrlKey || event.metaKey) && event.key === 'End' && items.length) { event.preventDefault(); select(items.length - 1); return }
    if (event.key === 'Enter') { event.preventDefault(); execute(selected) }
  })
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close() } })
  const sync = () => {
    help.textContent = t('viewer:comfort.commandHint')
    navLabel.textContent = t('viewer:comfort.paletteNavigate')
    runLabel.textContent = t('viewer:comfort.paletteSelect')
    closeLabel.textContent = t('viewer:comfort.paletteClose')
    closeBtn.setAttribute('aria-label', closeLabel.textContent)
    closeBtn.title = closeLabel.textContent
    input.placeholder = t('viewer:comfort.searchHint'); input.setAttribute('aria-label', input.placeholder); dialog.setAttribute('aria-label', t('viewer:comfort.commandSearch'))
    if (!readerFeatureEnabled('commandSearch') && dialog.open) close()
  }
  new MutationObserver(() => { if (shell.hidden && dialog.open) close() }).observe(shell, { attributes: true, attributeFilter: ['hidden'] })
  document.addEventListener('easypaper:locale-changed', sync)
  onReaderPreferences(sync); sync()
  return { open, close, handleShortcut }
}
