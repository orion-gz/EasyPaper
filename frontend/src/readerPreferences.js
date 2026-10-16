import './styles/reader-comfort.css'
import { t } from './i18n.js'

export const READER_FEATURES = {
  commandSearch: () => t('viewer:comfort.commandSearch'),
  taskProgress: () => t('viewer:comfort.taskProgress'),
  focusReading: () => t('viewer:comfort.focusReading'),
  referenceReturn: () => t('viewer:comfort.referenceReturn'),
  restoreReading: () => t('viewer:comfort.restoreReading'),
  quickActions: () => t('viewer:comfort.quickActions'),
}
import { readerPreferenceKey, readerFeatureEnabled } from './readerPreferenceStore.js'
export { readerFeatureEnabled } from './readerPreferenceStore.js'
export function setReaderFeature(name, enabled, storage = localStorage) {
  storage.setItem(readerPreferenceKey(name), String(Boolean(enabled)))
  window.dispatchEvent(new CustomEvent('easypaper:reader-preferences'))
}
export function onReaderPreferences(callback) {
  const changed = event => {
    if (event.type !== 'storage' || event.key === null || event.key?.startsWith('easypaper_reader_')) callback()
  }
  window.addEventListener('storage', changed)
  window.addEventListener('easypaper:reader-preferences', changed)
  return () => {
    window.removeEventListener('storage', changed)
    window.removeEventListener('easypaper:reader-preferences', changed)
  }
}
export function installReaderPreferences() {
  const form = document.getElementById('general-settings-form')
  if (!form) return
  const group = document.createElement('fieldset')
  group.className = 'reader-preferences form-group'
  const legend = document.createElement('legend')
  legend.dataset.i18n = 'viewer:comfort.settings'
  legend.textContent = t('viewer:comfort.settings')
  group.append(legend)
  const controls = []
  for (const [name, label] of Object.entries(READER_FEATURES)) {
    const row = document.createElement('label')
    row.className = 'toggle-switch'
    const input = document.createElement('input')
    input.type = 'checkbox'; input.id = `setting-reader-${name}`
    const track = document.createElement('span'); track.className = 'toggle-switch-track'
    const thumb = document.createElement('span'); thumb.className = 'toggle-switch-thumb'; track.append(thumb)
    const text = document.createElement('span'); text.textContent = label()
    row.append(input, track, text); group.append(row)
    input.addEventListener('change', () => {
      try { setReaderFeature(name, input.checked) } catch { input.checked = readerFeatureEnabled(name) }
    })
    controls.push(() => { input.checked = readerFeatureEnabled(name); text.textContent = label() })
  }
  const sync = () => controls.forEach(update => update())
  onReaderPreferences(sync)
  document.addEventListener('easypaper:locale-changed', sync)
  sync()
  const themeSettings = form.querySelector('.theme-settings-group')
  if (themeSettings) themeSettings.after(group)
  else form.prepend(group)
}
