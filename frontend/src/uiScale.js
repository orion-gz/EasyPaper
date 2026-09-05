export const UI_SCALE_STORAGE_KEY = 'easypaper_ui_scale'
export const DEFAULT_UI_SCALE = 1
export const UI_SCALE_OPTIONS = Object.freeze([0.8, 0.9, 1, 1.1, 1.25])

export function normalizeUiScale(value) {
  const parsed = Number.parseFloat(value)
  return UI_SCALE_OPTIONS.includes(parsed) ? parsed : DEFAULT_UI_SCALE
}

export function loadUiScale(storage = localStorage) {
  return normalizeUiScale(storage.getItem(UI_SCALE_STORAGE_KEY))
}

export function saveUiScale(value, storage = localStorage) {
  const scale = normalizeUiScale(value)
  storage.setItem(UI_SCALE_STORAGE_KEY, String(scale))
  return scale
}

export function syncSelectValue(control, value) {
  if (!control) return ''

  const nextValue = String(value)
  for (const option of control.options) {
    const isSelected = option.value === nextValue
    option.selected = isSelected
    option.defaultSelected = isSelected
    option.toggleAttribute('selected', isSelected)
  }
  control.value = nextValue
  return control.value
}

export function syncUiScaleControl(control, storage = localStorage) {
  const scale = loadUiScale(storage)
  syncSelectValue(control, scale)
  return scale
}

export function applyUiScale(value, root = document.documentElement) {
  const scale = normalizeUiScale(value)
  root.style.zoom = String(scale)
  return scale
}
