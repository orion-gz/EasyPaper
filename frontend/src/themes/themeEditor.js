import { PRESETS, COLOR_GROUPS, EDITABLE_TOKENS, THEME_STORAGE_KEY, loadThemes, saveThemes, resolveTheme, applyTheme, deleteTheme, exportTheme, importTheme, contrast, isColor } from './themeEngine.js'
import { themeLabels } from './themeLabels.js'
import './themes.css'

export function createThemeEditor({ host, t, onApply }) {
  let labels = themeLabels(t), state = loadThemes(), mode = 'research', scheme = 'dark'
  let draft, selection, dirty = false, conflict = false, previewTab = 'library', pending = false
  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag)
    if (text) {
      node.textContent = text
      const key = Object.keys(labels).find(key => labels[key] === text)
      if (key) node.dataset.themeLabel = key
    }
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    return node
  }
  const button = (label, action, attrs) => {
    const node = el('button', label, { type: 'button', ...attrs })
    node.addEventListener('click', action)
    return node
  }
  const root = el('section', '', { class: 'theme-editor', 'aria-label': labels.title })
  host.closest('.form-group')?.classList.remove('settings-row', 'settings-row-stacked')
  host.replaceChildren(root)
  const settingsDialog = host.closest('.settings-dialog')
  const syncViewport = () => {
    if (!settingsDialog) return
    const scale = Number(document.documentElement.style.zoom) || 1
    settingsDialog.style.setProperty('--theme-viewport-height', `${window.innerHeight / scale - 32}px`)
    settingsDialog.style.setProperty('--theme-viewport-width', `${window.innerWidth / scale - 32}px`)
  }
  syncViewport()
  window.addEventListener('resize', syncViewport)
  new MutationObserver(syncViewport).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  const status = el('p', '', { role: 'status', class: 'theme-status' })
  const choices = el('div', '', { class: 'theme-targets' })
  const modeButtons = {}, schemeButtons = {}
  for (const value of ['research', 'general']) {
    modeButtons[value] = button(labels[value], () => guard(() => { mode = value; loadSelection() }), { 'data-theme-mode': value })
    choices.append(modeButtons[value])
  }
  for (const value of ['light', 'dark']) {
    schemeButtons[value] = button(labels[value], () => guard(() => { scheme = value; loadSelection() }), { 'data-theme-scheme': value })
    choices.append(schemeButtons[value])
  }
  const search = el('input', '', { type: 'search', placeholder: labels.search, 'aria-label': labels.search, 'data-theme-search': '' })
  const cards = el('div', '', { class: 'theme-presets', 'aria-label': labels.search })
  const nameLabel = el('label', labels.name)
  const nameInput = el('input', '', { type: 'text', maxlength: '80', 'data-theme-name': '' })
  nameLabel.append(nameInput)
  const usage = el('p', '', { class: 'theme-usage' })
  const actions = el('div', '', { class: 'theme-actions' })
  const layout = el('div', '', { class: 'theme-layout' })
  const fields = el('div', '', { class: 'theme-fields' })
  const previewWrap = el('div', '', { class: 'theme-preview-wrap' })
  const previewNav = el('div', '', { class: 'theme-actions' })
  for (const tab of ['library', 'reader']) previewNav.append(button(labels[tab], () => { previewTab = tab; renderPreview() }))
  const preview = el('div', '', { class: 'theme-preview', 'aria-label': labels.preview, 'data-theme-preview': '' })
  const warning = el('p', '', { class: 'theme-contrast', role: 'status', id: 'theme-contrast-warning' })
  previewWrap.append(el('strong', labels.preview), previewNav, preview, warning)
  layout.append(fields, previewWrap)
  root.append(el('h3', labels.title), choices, search, cards, nameLabel, usage, status, layout, actions)
  const choose = (message, options) => new Promise(resolve => {
    const dialog = el('dialog', '', { class: 'theme-dialog', 'aria-label': message })
    dialog.append(el('p', message))
    const finish = value => { dialog.close(); dialog.remove(); resolve(value) }
    for (const [key, label] of options) dialog.append(button(label, () => finish(key)))
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return
      const buttons = [...dialog.querySelectorAll('button')]
      const index = buttons.indexOf(document.activeElement)
      event.preventDefault()
      buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus()
    })
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel') })
    document.body.append(dialog)
    dialog.showModal()
  })
  async function guard(action) {
    if (pending) return
    if (dirty) {
      pending = true
      const answer = await choose(labels.unsaved, [['apply', labels.apply], ['discard', labels.discard], ['cancel', labels.continue]])
      pending = false
      if (answer === 'cancel' || (answer === 'apply' && !commit())) return
      if (answer === 'discard') { dirty = false; loadSelection() }
    }
    action()
  }
  function markDirty() { dirty = true; status.textContent = labels.draft; renderPreview() }
  function loadSelection(id) {
    selection = id || state.selections[mode][scheme]
    const existing = state.themes.find(theme => theme.id === selection)
    const preset = PRESETS.find(theme => theme.id === selection)
    draft = existing ? structuredClone(existing) : { id: selection, name: preset.name, scheme, basePresetId: selection, overrides: {} }
    nameInput.value = draft.name
    dirty = Boolean(id && id !== state.selections[mode][scheme])
    status.textContent = conflict ? labels.external : dirty ? labels.draft : ''
    renderCards(); renderFields(); renderPreview()
    for (const [value, node] of Object.entries(modeButtons)) node.setAttribute('aria-pressed', String(value === mode))
    for (const [value, node] of Object.entries(schemeButtons)) node.setAttribute('aria-pressed', String(value === scheme))
    const uses = []
    for (const [m, slots] of Object.entries(state.selections)) for (const [s, id] of Object.entries(slots)) if (id === selection) uses.push(`${labels[m]} / ${labels[s]}`)
    usage.textContent = uses.length ? `${labels.usedBy} ${uses.join(', ')}` : ''
    deleteButton.disabled = !existing
  }
  function renderCards() {
    cards.replaceChildren()
    const query = search.value.trim().toLowerCase()
    for (const theme of [...PRESETS, ...state.themes].filter(theme => theme.scheme === scheme && theme.name.toLowerCase().includes(query))) {
      const card = button(theme.name, () => guard(() => loadSelection(theme.id)), { class: 'theme-preset', 'aria-pressed': String(theme.id === selection), 'data-preset': theme.id })
      card.removeAttribute('data-theme-label')
      card.append(el('small', theme.basePresetId ? labels.custom : labels.builtIn, { class: 'theme-preset-kind' }))
      const colors = resolveTheme(theme.id, state).tokens
      const swatches = el('span', '', { class: 'theme-swatches', 'aria-hidden': 'true' })
      for (const key of ['bg-base', 'bg-elevated', 'text-primary', 'accent-mid']) {
        const dot = el('span'); dot.style.backgroundColor = colors[key]; swatches.append(dot)
      }
      card.prepend(swatches); cards.append(card)
    }
  }
  function renderFields(preserveInvalid = false) {
    const invalid = new Map(preserveInvalid ? [...fields.querySelectorAll('[aria-invalid="true"]')].map(input => [input.dataset.colorToken, input.value]) : [])
    const expanded = [...fields.querySelectorAll('details[open]')].map(node => node.dataset.group)
    fields.replaceChildren()
    for (const [group, keys] of Object.entries(COLOR_GROUPS)) {
      const details = el('details', '', { 'data-group': group }); details.open = expanded.includes(group); details.append(el('summary', labels[group]));
      for (const key of keys) {
        const row = el('div', '', { class: 'theme-color-row' })
        const label = labels['token.' + key]
        const picker = el('input', '', { type: 'color', 'aria-label': label, 'data-color-picker': key })
        const hex = el('input', '', { type: 'text', 'aria-label': label + ' HEX', maxlength: '9', 'data-color-token': key, 'aria-describedby': 'theme-contrast-warning' })
        const alpha = el('input', '', { type: 'range', min: '0', max: '100', 'aria-label': label + ' ' + labels.opacity })
        const sync = () => { const value = resolveTheme(selection, state, draft).tokens[key]; picker.value = value.slice(0, 7); hex.value = value; alpha.value = Math.round((value.length === 9 ? parseInt(value.slice(7), 16) : 255) / 255 * 100) }
        sync()
        if (invalid.has(key)) { hex.value = invalid.get(key); hex.setAttribute('aria-invalid', 'true') }
        picker.addEventListener('input', () => { draft.overrides[key] = picker.value + (Number(alpha.value) < 100 ? Math.round(Number(alpha.value) * 2.55).toString(16).padStart(2, '0') : ''); hex.value = draft.overrides[key]; hex.removeAttribute('aria-invalid'); markDirty() })
        hex.addEventListener('input', () => {
          const valid = isColor(hex.value); hex.setAttribute('aria-invalid', String(!valid))
          if (!valid) { dirty = true; status.textContent = labels.invalidTheme; return }
          draft.overrides[key] = hex.value.toLowerCase(); sync(); markDirty()
        })
        alpha.addEventListener('input', () => { draft.overrides[key] = picker.value + Math.round(Number(alpha.value) * 255 / 100).toString(16).padStart(2, '0'); hex.value = draft.overrides[key]; hex.removeAttribute('aria-invalid'); markDirty() })
        row.append(el('span', label), picker, hex, alpha, button('↺', () => { delete draft.overrides[key]; sync(); hex.removeAttribute('aria-invalid'); markDirty() }, { 'aria-label': labels.resetColor + ': ' + label }))
        details.append(row)
      }
      fields.append(details)
    }
  }
  function renderPreview() {
    const theme = resolveTheme(selection, state, draft)
    for (const input of fields.querySelectorAll('[data-color-token]')) {
      if (input === document.activeElement || input.getAttribute('aria-invalid') === 'true') continue
      const key = input.dataset.colorToken, value = theme.tokens[key]
      input.value = value
      const row = input.parentElement
      row.querySelector('[type=color]').value = value.slice(0, 7)
      row.querySelector('[type=range]').value = Math.round((value.length === 9 ? parseInt(value.slice(7), 16) : 255) / 255 * 100)
    }
    applyTheme(preview, theme)
    preview.replaceChildren()
    const top = el('div', 'EasyPaper', { class: 'theme-sample-topbar' })
    top.append(button(labels.library, () => {}, { class: 'theme-sample-tab', 'aria-pressed': 'true' }))
    const body = el('div', '', { class: 'theme-sample-body' })
    const side = el('aside', '', { class: 'theme-sample-sidebar' })
    side.append(el('strong', labels.library), button(labels.research, () => {}, { class: 'selected' }), button(labels.general, () => {}))
    const main = el('main', '', { class: 'theme-sample-viewer' })
    const card = el('article', '', { class: previewTab === 'library' ? 'theme-sample-card' : 'theme-sample-translation' })
    card.append(el('h4', labels.sampleTitle), el('p', labels.sampleText), button(labels.apply, () => {}, { class: 'theme-primary' }))
    if (previewTab === 'reader') {
      const original = el('article', '', { class: 'theme-sample-paper' })
      original.append(el('strong', labels.original), el('h4', labels.sampleTitle), el('p', labels.sampleText))
      main.append(original)
      card.prepend(el('strong', labels.translation))
    }
    main.append(card)
    if (previewTab === 'reader') {
      const chat = el('section', '', { class: 'theme-sample-chat' })
      chat.append(el('strong', labels.chat), el('p', labels.sampleInput, { class: 'theme-sample-chat-user' }), el('p', labels.sampleChat), el('input', '', { placeholder: labels.sampleInput, 'aria-label': labels.sampleInput }))
      main.append(chat)
    }
    const statuses = el('div', '', { class: 'theme-sample-status' })
    for (const key of ['success', 'warning', 'error', 'info']) { const span = el('span', labels['token.' + key]); span.style.color = `var(--${key})`; statuses.append(span) }
    main.append(statuses); body.append(side, main); preview.append(top, body)
    const pairs = [['text-primary', 'bg-base'], ['text-secondary', 'bg-base'], ['on-accent', 'accent-mid'], ...['sidebar', 'topbar', 'card', 'viewer', 'translation', 'chat'].map(r => [r + '-text', r + '-bg'])]
    const low = pairs.filter(([fg, bg]) => contrast(theme.tokens[fg], theme.tokens[bg], theme.tokens['bg-base']) < 4.5).map(([fg]) => fg)
    for (const input of fields.querySelectorAll('[data-color-token]')) {
      input.parentElement.classList.toggle('theme-low-contrast', low.includes(input.dataset.colorToken))
    }
    warning.textContent = low.length ? labels.contrast + ' ' + low.map(key => {
      const region = key.split('-')[0]
      return (labels[region] ? labels[region] + ' / ' : '') + labels['token.' + key]
    }).join(', ') : ''
  }
  function commit() {
    if (conflict) { status.textContent = labels.external; return false }
    if (!nameInput.value.trim() || nameInput.value.trim().length > 80) { status.textContent = labels.nameRequired; nameInput.focus(); return false }
    if (fields.querySelector('[aria-invalid="true"]')) { status.textContent = labels.invalidTheme; fields.querySelector('[aria-invalid="true"]').focus(); return false }
    const next = structuredClone(state)
    const preset = PRESETS.find(theme => theme.id === draft.id)
    const custom = !preset || Object.keys(draft.overrides).length || nameInput.value.trim() !== preset.name
    const saved = { ...draft, name: nameInput.value.trim() }
    if (custom) {
      if (preset) saved.id = crypto.randomUUID()
      next.themes = next.themes.filter(theme => theme.id !== saved.id)
      next.themes.push(saved)
    }
    next.selections[mode][scheme] = saved.id
    try { saveThemes(next) } catch { status.textContent = labels.saveError; return false }
    state = next; dirty = false; loadSelection(); status.textContent = labels.saved; onApply(state)
    return true
  }
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; markDirty() })
  search.addEventListener('input', renderCards)
  actions.append(button(labels.copy, () => { draft.id = crypto.randomUUID(); draft.name += ` (${labels.copySuffix})`; nameInput.value = draft.name; selection = draft.id; deleteButton.disabled = true; usage.textContent = ''; renderCards(); markDirty() }, { 'data-theme-copy': '' }))
  const deleteButton = button(labels.delete, async () => {
    const target = state.themes.find(theme => theme.id === draft.id)
    if (!target) return
    if (await choose(labels.deleteConfirm + ' ' + target.name + ' ' + usage.textContent, [['delete', labels.delete], ['cancel', labels.cancel]]) !== 'delete') return
    if (conflict) { status.textContent = labels.external; return }
    const next = deleteTheme(state, target.id)
    try { saveThemes(next) } catch { status.textContent = labels.saveError; return }
    state = next; dirty = false; loadSelection(); onApply(state)
  }, { 'data-theme-delete': '' })
  actions.append(deleteButton, button(labels.reset, () => { draft.overrides = {}; markDirty(); renderFields() }), button(labels.export, () => {
    const theme = resolveTheme(selection, state, draft)
    const url = URL.createObjectURL(new Blob([exportTheme(theme)], { type: 'application/json' }))
    const anchor = el('a', '', { href: url, download: 'easypaper-theme.json' }); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }))
  const file = el('input', '', { type: 'file', accept: '.json,application/json', hidden: '' })
  file.addEventListener('change', async () => {
    const selected = file.files[0]; file.value = ''; if (!selected) return
    if (selected.size > 100000) { status.textContent = labels.invalidTheme; return }
    try {
      const imported = importTheme(await selected.text())
      await guard(() => { scheme = imported.scheme; selection = imported.id; draft = imported; nameInput.value = imported.name; dirty = true; renderCards(); renderFields(); renderPreview(); status.textContent = labels.draft; deleteButton.disabled = true; for (const [s, node] of Object.entries(schemeButtons)) node.setAttribute('aria-pressed', String(s === scheme)) })
    } catch { status.textContent = labels.invalidTheme }
  })
  actions.append(button(labels.import, () => file.click()), file,
    button(labels.reload, () => guard(() => { state = loadThemes(); conflict = false; loadSelection() })),
    button(labels.apply, commit, { class: 'theme-apply', 'data-theme-apply': '' }))
  const source = el('a', labels.source, { href: '/theme-licenses/index.html', target: '_blank', rel: 'noopener' }); actions.append(source)
  window.addEventListener('storage', event => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
    if (dirty) { conflict = true; status.textContent = labels.external }
    else { state = loadThemes(); loadSelection() }
    onApply(loadThemes())
  })
  // Capture close gestures before the modal manager can discard the draft.
  document.addEventListener('click', event => {
    if (!dirty || pending) return
    const close = event.target.closest?.('#close-settings-btn')
    const backdrop = event.target.id === 'settings-modal'
    if (!close && !backdrop) return
    event.preventDefault(); event.stopImmediatePropagation()
    guard(() => (close || event.target).click())
  }, true)
  document.addEventListener('keydown', event => {
    if (!dirty || pending || event.key !== 'Escape' || !document.getElementById('settings-modal')?.classList.contains('is-visible')) return
    event.preventDefault(); event.stopImmediatePropagation(); guard(() => document.getElementById('close-settings-btn').click())
  }, true)
  loadSelection()
  return {
    setMode(nextMode, nextScheme) {
      if (dirty) return
      mode = nextMode; scheme = nextScheme; state = loadThemes(); loadSelection()
    },
    refreshLocale() {
      labels = themeLabels(t)
      for (const node of root.querySelectorAll('[data-theme-label]')) {
        if (node.firstChild?.nodeType === Node.TEXT_NODE) node.firstChild.textContent = labels[node.dataset.themeLabel]
      }
      search.placeholder = labels.search; search.setAttribute('aria-label', labels.search)
      root.setAttribute('aria-label', labels.title); preview.setAttribute('aria-label', labels.preview)
      renderCards(); renderFields(true); renderPreview()
    },
  }
}
