export const MINIMAL_UI_KEY = 'easypaper_minimal_ui'
export function isMinimalUi(storage = localStorage) {
  return storage.getItem(MINIMAL_UI_KEY) === 'true'
}
export function setMinimalUi(enabled, storage = localStorage) {
  storage.setItem(MINIMAL_UI_KEY, String(enabled === true))
}
export function isMinimalTabAllowed(tab) {
  return tab.kind === 'document' || (tab.kind === 'page' && tab.target === 'library')
}
