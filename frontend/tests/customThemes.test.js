import test from 'node:test'
import assert from 'node:assert/strict'
import { PRESETS, THEME_STORAGE_KEY, EDITABLE_TOKENS, createThemeState, loadThemes, saveThemes, resolveTheme, deleteTheme, exportTheme, importTheme, contrast, isColor } from '../src/themes/themeEngine.js'
const storage = entries => {
  const values = new Map(Object.entries(entries || {}))
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}
test('32 unique presets provide every editable color and valid provenance', () => {
  assert.equal(PRESETS.length, 32)
  assert.equal(new Set(PRESETS.map(p => p.id)).size, 32)
  for (const preset of PRESETS) {
    const result = resolveTheme(preset.id)
    assert.equal(result.scheme, preset.scheme)
    assert.ok(preset.source.startsWith('https://github.com/'))
    for (const token of EDITABLE_TOKENS) assert.ok(isColor(result.tokens[token]), `${preset.id}: ${token}`)
  }
})
test('legacy mode accents migrate independently into both appearance slots exactly once', () => {
  const s = storage({ easypaper_accent_color: '#e0677a', easypaper_accent_color_general: '#1c9c6b' })
  const state = loadThemes(s)
  for (const scheme of ['light', 'dark']) {
    assert.equal(resolveTheme(state.selections.research[scheme], state).tokens['accent-mid'], '#e0677a')
    assert.equal(resolveTheme(state.selections.general[scheme], state).tokens['accent-mid'], '#1c9c6b')
  }
  saveThemes(state, s)
  s.setItem('easypaper_accent_color', '#000000')
  assert.deepEqual(loadThemes(s), state)
})
test('common colors inherit into regions and explicit overrides take priority', () => {
  const draft = { basePresetId: 'catppuccin-mocha', overrides: { 'bg-panel': '#123456', 'accent-mid': '#ff0000', 'sidebar-bg': '#abcdef', 'control-accent-text': '#112233' } }
  const { tokens } = resolveTheme('draft', undefined, draft)
  assert.equal(tokens['chat-bg'], '#123456')
  assert.equal(tokens['sidebar-bg'], '#abcdef')
  assert.equal(tokens['control-accent'], '#ff0000')
  assert.equal(tokens['control-accent-text'], '#112233')
  delete draft.overrides['sidebar-bg']
  assert.equal(resolveTheme('draft', undefined, draft).tokens['sidebar-bg'], '#123456')
})
test('all four slots retain independent selections and deletion resets only references', () => {
  const state = createThemeState(storage())
  state.themes.push({ id: 'custom', name: 'Custom', scheme: 'dark', basePresetId: 'nord', overrides: {} })
  state.selections.research.dark = 'custom'
  state.selections.general.dark = 'custom'
  state.selections.general.light = 'github-light'
  const next = deleteTheme(state, 'custom')
  assert.equal(next.selections.research.dark, 'easypaper-dark')
  assert.equal(next.selections.general.dark, 'easypaper-dark')
  assert.equal(next.selections.general.light, 'github-light')
  assert.equal(state.themes.length, 1)
})
test('invalid stored JSON, missing ids, mismatched schemes and CSS values recover safely', () => {
  assert.deepEqual(loadThemes(storage({ [THEME_STORAGE_KEY]: '{' })), createThemeState(storage()))
  const state = createThemeState(storage())
  state.selections.research.light = 'nord'
  state.selections.general.dark = 'deleted'
  state.themes.push({ id: 'custom', name: 'Custom', scheme: 'dark', basePresetId: 'nord', overrides: { 'bg-base': 'url(https://bad.test)', 'text-primary': '#abcdef', unknown: '#123456' } })
  const result = loadThemes(storage({ [THEME_STORAGE_KEY]: JSON.stringify(state) }))
  assert.equal(result.selections.research.light, 'easypaper-light')
  assert.equal(result.selections.general.dark, 'easypaper-dark')
  assert.deepEqual(result.themes[0].overrides, { 'text-primary': '#abcdef' })
})
test('portable files round-trip all editable colors without depending on a preset id', () => {
  for (const preset of PRESETS) {
    const resolved = resolveTheme(preset.id)
    const imported = importTheme(exportTheme(resolved), 'new-id')
    assert.equal(imported.id, 'new-id')
    const result = resolveTheme(imported.id, undefined, imported)
    for (const token of EDITABLE_TOKENS) assert.equal(result.tokens[token], resolved.tokens[token], token)
  }
})
test('imports reject unsupported versions, unknown tokens and malformed colors', () => {
  const exported = JSON.parse(exportTheme(resolveTheme('nord')))
  for (const value of [{ ...exported, version: 9 }, { ...exported, colors: {} }, { ...exported, colors: { ...exported.colors, evil: '#abcdef' } }, { ...exported, colors: { ...exported.colors, 'bg-base': 'red; color: blue' } }, { ...exported, scheme: 'auto' }]) {
    assert.throws(() => importTheme(JSON.stringify(value), 'new-id'), /invalidTheme/)
  }
})
test('storage failures propagate without modifying the saved selection', () => {
  const state = createThemeState(storage())
  assert.throws(() => saveThemes(state, { setItem() { throw new Error('quota') } }), /quota/)
  assert.equal(state.selections.research.dark, 'easypaper-dark')
})
test('contrast uses relative luminance', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21)
  assert.equal(contrast('#ffffff', '#ffffff'), 1)
})

test('contrast composites transparent foreground and backgrounds', () => {
  assert.equal(contrast('#00000000', '#ffffff'), 1)
  assert.equal(contrast('#ffffff', '#00000000', '#ffffff'), 1)
  assert.ok(contrast('#00000080', '#ffffff') < contrast('#000000', '#ffffff'))
})

test('legacy accent derivation ignores alpha bytes when calculating RGB channels', () => {
  const opaque = resolveTheme('draft', undefined, { basePresetId: 'easypaper-dark', overrides: { 'accent-mid': '#123456' } })
  const alpha = resolveTheme('draft', undefined, { basePresetId: 'easypaper-dark', overrides: { 'accent-mid': '#12345680' } })
  assert.equal(opaque.tokens['accent-from'], alpha.tokens['accent-from'])
})

test('preset diagnostic and selection colors preserve palette identity and override precedence', () => {
  const mocha = resolveTheme('catppuccin-mocha').tokens
  assert.equal(mocha.success, '#a6e3a1')
  assert.equal(mocha.error, '#f38ba8')
  assert.equal(mocha['selection-bg'], '#585b70')
  const dracula = resolveTheme('dracula').tokens
  assert.equal(dracula.success, '#50fa7b')
  assert.equal(dracula['card-selected'], '#44475a')
  for (const preset of PRESETS.filter(p => !p.id.startsWith('easypaper-'))) {
    for (const key of ['success', 'warning', 'error', 'info', 'selection']) assert.ok(isColor(preset.colors[key]), `${preset.id}: ${key}`)
  }
  const overridden = resolveTheme('draft', undefined, { basePresetId: 'dracula', overrides: { success: '#123456', 'accent-mid': '#abcdef', 'card-selected': '#112233' } }).tokens
  assert.equal(overridden.success, '#123456')
  assert.equal(overridden['card-selected'], '#112233')
  assert.equal(overridden['selection-bg'], '#abcdef')
  assert.notEqual(overridden['sidebar-selected'], dracula['sidebar-selected'])
})
