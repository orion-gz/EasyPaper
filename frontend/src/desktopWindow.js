import { t } from './i18n.js'
import './styles/desktop-window.css'

let desktopWindowReady = Promise.resolve(null)

export function initializeDesktopWindow(i18nReady) {
  if (!('__TAURI_INTERNALS__' in window) || window.parent !== window) return
  const platform = /Windows/.test(navigator.userAgent) ? 'windows' : /Macintosh|Mac OS X/.test(navigator.userAgent) ? 'macos' : null
  if (!platform) return
  document.body.classList.add('desktop-window', `desktop-${platform}`)
  const syncScale = () => document.body.style.setProperty('--desktop-ui-scale', Number(document.documentElement.style.zoom) || 1)
  new MutationObserver(syncScale).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  syncScale()
  desktopWindowReady = createDesktopWindow(platform, i18nReady).catch(error => {
    console.error('Could not initialize desktop window controls', error)
    return null
  })
}

async function createDesktopWindow(platform, i18nReady) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const appWindow = getCurrentWindow()
  const run = action => Promise.resolve().then(action).catch(error => console.error('Window action failed', error))
  const fallback = document.createElement('header')
  fallback.className = 'desktop-window-titlebar'
  const drag = document.createElement('div')
  drag.className = 'desktop-window-drag'
  fallback.append(drag)
  document.body.append(fallback)
  const controls = document.createElement('div')
  controls.className = 'desktop-window-controls'
  const buttons = new Map()
  let maximized = false
  let stateGeneration = 0
  function updateLabels() {
    const labels = {
      minimize: t('navigation:window.minimize'),
      maximize: maximized ? t('navigation:window.restore') : t('navigation:window.maximize'),
      close: t('navigation:window.close'),
    }
    for (const [action, button] of buttons) {
      button.title = labels[action]
      button.setAttribute('aria-label', button.title)
    }
  }
  if (platform === 'windows') {
    for (const [action, path] of [
      ['minimize', 'M3 8h10'],
      ['maximize', 'M3.5 3.5h9v9h-9z'],
      ['close', 'M3 3l10 10M13 3L3 13'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.windowAction = action
      button.innerHTML = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="${path}"/></svg>`
      button.addEventListener('click', () => run(async () => {
        if (action === 'minimize') await appWindow.minimize()
        if (action === 'maximize') { await appWindow.toggleMaximize(); await syncState() }
        if (action === 'close') await appWindow.close()
      }))
      buttons.set(action, button)
      controls.append(button)
    }
    fallback.append(controls)
  }
  // Only empty chrome starts a native drag. Tab clicks and HTML tab drags
  // must never become window drags; the second click toggles maximization.
  function bindDrag(region, isBlank = target => target === region) {
    region.addEventListener('mousedown', event => {
      if (event.button !== 0 || !isBlank(event.target)) return
      event.preventDefault()
      if (event.detail === 2) run(async () => { await appWindow.toggleMaximize(); await syncState() })
      else run(() => appWindow.startDragging())
    })
  }
  bindDrag(drag)
  async function syncState() {
    const generation = ++stateGeneration
    const [nextMaximized, fullscreen] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()])
    if (generation !== stateGeneration) return
    maximized = nextMaximized
    document.body.classList.toggle('desktop-fullscreen', fullscreen)
    const maximize = buttons.get('maximize')
    if (maximize) maximize.querySelector('path').setAttribute('d', maximized ? 'M5.5 3.5v-1h8v8h-1M2.5 5.5h8v8h-8z' : 'M3.5 3.5h9v9h-9z')
    updateLabels()
  }
  const stopResize = await appWindow.onResized(() => run(syncState))
  window.addEventListener('pagehide', stopResize, { once: true })
  document.addEventListener('easypaper:locale-changed', updateLabels)
  await i18nReady
  await run(syncState)
  return { fallback, controls, bindDrag, platform }
}

export function attachDesktopWindow(shell, topnav, tabControls, tablist) {
  desktopWindowReady.then(chrome => {
    if (!chrome) return
    const spacer = document.createElement('div')
    spacer.className = 'desktop-workspace-drag'
    tabControls.append(spacer)
    chrome.bindDrag(topnav, target => [topnav, tabControls, tablist, spacer].includes(target))
    function syncVisibility() {
      chrome.fallback.hidden = !shell.hidden
      if (chrome.platform === 'windows') (shell.hidden ? chrome.fallback : topnav).append(chrome.controls)
    }
    new MutationObserver(syncVisibility).observe(shell, { attributes: true, attributeFilter: ['hidden'] })
    syncVisibility()
  })
}
