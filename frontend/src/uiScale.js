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

export function syncUiScaleControl(control, storage = localStorage) {
  const scale = loadUiScale(storage)
  if (control) control.value = String(scale)
  return scale
}

export function applyUiScale(value, root = document.documentElement) {
  const scale = normalizeUiScale(value)
  root.style.zoom = String(scale)
  return scale
}
