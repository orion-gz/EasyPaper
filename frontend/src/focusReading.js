import { icon } from './icons.js'
import { t } from './i18n.js'
import { readerFeatureEnabled, onReaderPreferences } from './readerPreferences.js'
import './styles/reader-comfort.css'

export function installFocusReading({ toolbar, floating, panels, restorePanels, translationCollapsed, setTranslationCollapsed, changed }) {
  const host = window.parent.document.body
  let focused = false
  let active = true
  let previous
  let previousCollapsed
  const button = document.createElement('button')
  button.type = 'button'; button.id = 'reader-focus'; button.className = 'icon-btn'
  button.innerHTML = icon('expand', 16); button.title = t('viewer:comfort.focusReading'); button.setAttribute('aria-label', button.title)
  const view = document.createElement('div')
  view.id = 'reader-focus-view'; view.setAttribute('role', 'group'); view.setAttribute('aria-label', t('viewer:comfort.readingView'))
  let selectedView = window.innerWidth < 800 ? 'original' : 'both'
  for (const [value, label] of [['both', t('viewer:comfort.both')], ['original', t('viewer:comfort.original')], ['translation', t('viewer:comfort.translation')]]) {
    const option = document.createElement('button'); option.type = 'button'; option.dataset.view = value; option.textContent = label
    option.addEventListener('click', () => { selectedView = value; render() }); view.append(option)
  }
  const render = () => {
    button.title = t('viewer:comfort.focusReading'); button.setAttribute('aria-label', button.title)
    view.setAttribute('aria-label', t('viewer:comfort.readingView'))
    view.querySelectorAll('button').forEach(option => { option.textContent = t(`viewer:comfort.${option.dataset.view}`) })
    button.hidden = !readerFeatureEnabled('focusReading')
    button.setAttribute('aria-pressed', String(focused))
    view.hidden = !focused
    document.body.classList.toggle('reader-focus', focused)
    document.body.dataset.focusView = focused ? selectedView : 'both'
    if (active) host.classList.toggle('reader-focus-host', focused)
    view.querySelectorAll('button').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.view === selectedView)))
    changed()
  }
  const set = value => {
    if (value === focused || (value && !readerFeatureEnabled('focusReading'))) return
    if (value) { previous = panels(); previousCollapsed = translationCollapsed(); setTranslationCollapsed(false); restorePanels({ panel: false, outline: false }) }
    else if (previous) { restorePanels(previous); setTranslationCollapsed(previousCollapsed) }
    focused = value; render()
  }
  button.addEventListener('click', () => set(!focused))
  const escape = event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !focused) return
    if (document.querySelector('.modal-overlay:not(.hidden), .selection-menu:not(.hidden), .figure-preview-tooltip:not(.hidden)')) return
    if (event.target.closest('textarea, input, [contenteditable="true"]')) return
    event.preventDefault(); set(false); button.focus()
  }
  document.addEventListener('keydown', escape)
  const unsubscribe = onReaderPreferences(() => { if (!readerFeatureEnabled('focusReading')) set(false); render() })
  document.addEventListener('easypaper:locale-changed', render)
  floating.append(button, view)
  render()
  return {
    toggle: () => set(!focused),
    setActive(value) { active = value; host.classList.toggle('reader-focus-host', active && focused) },
    destroy() { unsubscribe(); document.removeEventListener('easypaper:locale-changed', render); document.removeEventListener('keydown', escape); if (active) host.classList.remove('reader-focus-host') },
  }
}
