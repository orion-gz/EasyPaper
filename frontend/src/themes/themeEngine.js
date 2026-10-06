import { PRESETS } from './presets.js'
import { getModeSetting } from '../modeSettings.js'
export { PRESETS } from './presets.js'
export const THEME_STORAGE_KEY = 'easypaper_custom_themes_v1'
const regions = ['sidebar', 'topbar', 'card', 'viewer', 'translation', 'chat']
export const COLOR_GROUPS = {
  background: ['bg-base', 'bg-surface', 'bg-elevated', 'bg-panel', 'bg-hover'],
  text: ['text-primary', 'text-secondary', 'text-tertiary', 'text-muted', 'link'],
  border: ['border', 'border-strong', 'focus-ring', 'selection-bg', 'selection-text'],
  accent: ['accent-mid', 'accent-from', 'accent-to', 'on-accent', 'control-accent-soft', 'control-accent-text'],
  status: ['success', 'warning', 'error', 'info'],
  ...Object.fromEntries(regions.map(region => [region, [`${region}-bg`, `${region}-text`, `${region}-border`, `${region}-selected`]])),
}
export const EDITABLE_TOKENS = Object.values(COLOR_GROUPS).flat()
const allowed = new Set(EDITABLE_TOKENS)
export const isColor = value => typeof value === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value)
const rgba = (hex, alpha) => hex.slice(0, 7) + Math.round(alpha * 255).toString(16).padStart(2, '0')
function mix(a, b, weight) {
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - weight) + parseInt(b.slice(i, i + 2), 16) * weight).toString(16).padStart(2, '0')).join('')
}
export function contrast(a, b, backdrop = '#ffffff') {
  const composite = (front, back) => mix(back, front, front.length === 9 ? parseInt(front.slice(7), 16) / 255 : 1)
  b = composite(b, backdrop)
  a = composite(a, b)
  const luminance = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1, 7), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
function rgbToHex(r, g, b) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)))
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('')
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return { h, s, l }
}
function hslToRgb(h, s, l) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: hue2rgb(p, q, h + 1 / 3) * 255,
    g: hue2rgb(p, q, h) * 255,
    b: hue2rgb(p, q, h - 1 / 3) * 255,
  }
}
// 기준 색상의 명도(lightness)만 delta만큼 옮긴 색상 반환 (그라데이션/텍스트 톤 파생용)
function shadeHex(hex, lightnessDelta) {
  const { r, g, b } = hexToRgb(hex)
  const hsl = rgbToHsl(r, g, b)
  hsl.l = Math.max(0.08, Math.min(0.92, hsl.l + lightnessDelta))
  const rgb = hslToRgb(hsl.h, hsl.s, hsl.l)
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

function cleanOverrides(value, strict = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { if (strict) throw new Error('invalidTheme'); return {} }
  const result = {}
  for (const [key, color] of Object.entries(value)) {
    if (!allowed.has(key) || !isColor(color)) { if (strict) throw new Error('invalidTheme'); continue }
    result[key] = color.toLowerCase()
  }
  return result
}
export function resolveTheme(id, state, draft) {
  const custom = draft || state?.themes?.find(theme => theme.id === id)
  const preset = PRESETS.find(theme => theme.id === (custom?.basePresetId || id)) || PRESETS.find(theme => theme.id === `easypaper-${custom?.scheme === 'light' ? 'light' : 'dark'}`)
  const { base, surface, elevated, text, secondary, accent } = preset.colors
  const light = preset.scheme === 'light'
  const o = cleanOverrides(custom?.overrides)
  const legacy = preset.id.startsWith('easypaper-')
  const legacyBase = legacy ? (light ? {
    'bg-surface': '#ffffffcc', 'bg-elevated': '#f1f5f9d9', 'bg-panel': '#fffffffa', 'bg-hover': '#e2e8f0e6',
    border: '#0000000a', 'border-strong': '#00000014', 'text-tertiary': '#64748b', 'text-muted': '#64748b',
    success: '#10b981', error: '#ef4444', warning: '#f59e0b',
  } : {
    'bg-surface': '#0d0b16b3', 'bg-elevated': '#171426bf', 'bg-panel': '#141224f2', 'bg-hover': '#272240cc',
    border: '#ffffff0d', 'border-strong': '#ffffff1a', 'text-tertiary': '#86868f', 'text-muted': '#9ca3af',
    success: '#10b981', error: '#ef4444', warning: '#f59e0b',
  }) : {}
  const tokens = {
    'bg-base': base, 'bg-surface': surface, 'bg-elevated': elevated, 'bg-panel': surface,
    'bg-hover': mix(elevated, text, 0.08), 'text-primary': text, 'text-secondary': secondary,
    'text-tertiary': secondary, 'text-muted': secondary, border: rgba(text, 0.12), 'border-strong': rgba(text, 0.24),
    'accent-mid': accent, success: light ? '#167647' : '#73c991', warning: light ? '#936000' : '#e5c07b',
    error: light ? '#c62828' : '#f48771', info: light ? '#0969da' : '#75beff', ...legacyBase, ...o,
  }
  const a = tokens['accent-mid'], fg = tokens['text-primary']
  Object.assign(tokens, {
    'accent-from': legacy ? shadeHex(a, -0.16) : mix(a, '#000000', 0.2), 'accent-to': legacy ? shadeHex(a, 0.18) : mix(a, '#ffffff', 0.25),
    'accent-glow': rgba(a, 0.3), 'control-accent': a, 'control-accent-soft': rgba(a, 0.16),
    'control-accent-text': legacy ? shadeHex(a, light ? -0.24 : 0.24) : mix(a, light ? '#000000' : '#ffffff', 0.25),
    'on-accent': contrast(a, '#ffffff') >= contrast(a, '#000000') ? '#ffffff' : '#000000',
    'border-glow': rgba(a, 0.2), 'focus-ring': a, 'selection-bg': a,
    'selection-text': contrast(a, '#ffffff') >= contrast(a, '#000000') ? '#ffffff' : '#000000', link: a,
    ...o,
  })
  for (const region of regions) {
    tokens[`${region}-bg`] = tokens[region === 'viewer' ? 'bg-base' : region === 'card' ? 'bg-elevated' : 'bg-panel']
    tokens[`${region}-text`] = fg
    tokens[`${region}-border`] = tokens.border
    tokens[`${region}-selected`] = tokens['control-accent-soft']
  }
  if (legacy) {
    Object.assign(tokens, light ? { 'topbar-bg': o['bg-panel'] || '#ffffffcc', 'card-bg': o['bg-elevated'] || tokens['bg-surface'], 'viewer-bg': tokens['bg-base'] } : { 'topbar-bg': o['bg-panel'] || '#0a0812bf', 'card-bg': o['bg-elevated'] || '#ffffff05' })
  }
  Object.assign(tokens, o)
  Object.assign(tokens, {
    'bg-primary': tokens['bg-base'], danger: tokens.error,
    'bg-topbar': tokens['topbar-bg'], 'bg-card': tokens['card-bg'], 'bg-card-hover': tokens['bg-hover'],
    'bg-trans-label': rgba(fg, 0.02), 'bg-page-pair': tokens['viewer-bg'], 'bg-page-pair-hover': tokens['bg-hover'],
    'bg-dropzone': tokens['bg-surface'], 'bg-page-block': tokens['translation-bg'],
  })
  return { id, name: custom?.name || preset.name, scheme: preset.scheme, tokens }
}
export const THEME_TOKEN_NAMES = Object.keys(resolveTheme('easypaper-dark').tokens)
export function applyTheme(target, theme) {
  for (const name of THEME_TOKEN_NAMES) target.style.removeProperty(`--${name}`)
  for (const [name, color] of Object.entries(theme.tokens)) target.style.setProperty(`--${name}`, color)
  target.style.colorScheme = theme.scheme
  target.classList.toggle('light-theme', theme.scheme === 'light')
  target.dataset.themeId = theme.id
  if (target === target.ownerDocument.body) {
    const root = target.ownerDocument.documentElement
    for (const name of THEME_TOKEN_NAMES) root.style.removeProperty(`--${name}`)
    root.style.setProperty('--bg-base', theme.tokens['bg-base'])
    root.style.colorScheme = theme.scheme
    target.ownerDocument.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.tokens['bg-base'])
  }
}
export function createThemeState(storage) {
  const state = { version: 1, selections: {}, themes: [] }
  for (const mode of ['research', 'general']) {
    state.selections[mode] = {}
    const accent = getModeSetting('accentColor', mode, storage)
    for (const scheme of ['light', 'dark']) {
      const presetId = `easypaper-${scheme}`
      const id = isColor(accent) && accent.toLowerCase() !== '#2563eb' ? `legacy-${mode}-${scheme}` : presetId
      if (id !== presetId) state.themes.push({ id, name: `EasyPaper ${mode} ${scheme}`, scheme, basePresetId: presetId, overrides: { 'accent-mid': accent } })
      state.selections[mode][scheme] = id
    }
  }
  return state
}
export function loadThemes(storage = localStorage) {
  let raw
  try { raw = JSON.parse(storage.getItem(THEME_STORAGE_KEY)) } catch { /* recover below */ }
  if (!raw || raw.version !== 1 || !Array.isArray(raw.themes)) return createThemeState(storage)
  const themes = [], ids = new Set(PRESETS.map(p => p.id))
  for (const theme of raw.themes) {
    if (!theme || typeof theme.id !== 'string' || ids.has(theme.id) || !theme.id || typeof theme.name !== 'string' || !theme.name.trim()) continue
    if (!PRESETS.some(p => p.id === theme.basePresetId && p.scheme === theme.scheme)) continue
    ids.add(theme.id)
    themes.push({ id: theme.id, name: theme.name.slice(0, 80), scheme: theme.scheme, basePresetId: theme.basePresetId, overrides: cleanOverrides(theme.overrides) })
  }
  const selections = {}
  for (const mode of ['research', 'general']) {
    selections[mode] = {}
    for (const scheme of ['light', 'dark']) {
      const id = raw.selections?.[mode]?.[scheme]
      selections[mode][scheme] = [...PRESETS, ...themes].some(t => t.id === id && t.scheme === scheme) ? id : `easypaper-${scheme}`
    }
  }
  return { version: 1, selections, themes }
}
export function saveThemes(state, storage = localStorage) { storage.setItem(THEME_STORAGE_KEY, JSON.stringify(state)) }
export function selectedTheme(mode, scheme, state) { return resolveTheme(state.selections[mode]?.[scheme] || `easypaper-${scheme}`, state) }
export function deleteTheme(state, id) {
  const next = structuredClone(state)
  next.themes = next.themes.filter(theme => theme.id !== id)
  for (const selection of Object.values(next.selections)) for (const scheme of ['light', 'dark']) if (selection[scheme] === id) selection[scheme] = `easypaper-${scheme}`
  return next
}
export function exportTheme(theme) {
  return JSON.stringify({ version: 1, name: theme.name, scheme: theme.scheme, colors: Object.fromEntries(EDITABLE_TOKENS.map(key => [key, theme.tokens[key]])) }, null, 2)
}
export function importTheme(text, id = globalThis.crypto.randomUUID()) {
  if (text.length > 100000) throw new Error('invalidTheme')
  let value
  try { value = JSON.parse(text) } catch { throw new Error('invalidTheme') }
  if (!value || value.version !== 1 || !['light', 'dark'].includes(value.scheme) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('invalidTheme')
  const overrides = cleanOverrides(value.colors, true)
  if (EDITABLE_TOKENS.some(key => !overrides[key])) throw new Error('invalidTheme')
  return { id, name: value.name.trim(), scheme: value.scheme, basePresetId: `easypaper-${value.scheme}`, overrides }
}
