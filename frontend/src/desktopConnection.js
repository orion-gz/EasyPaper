import { initI18n, loadNamespaces, t } from './i18n.js'
import './styles/desktop-connection.css'

let connection = null
let dialog = null
let beforeDownload = async () => {}
let pollTimer = null
let busy = false

export async function connectionRequest(path, options = {}) {
  const response = await fetch('/desktop/' + path, {
    ...options, cache: 'no-store',
    headers: { 'X-EasyPaper-Desktop': '1', 'Content-Type': 'application/json', ...options.headers },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : t('desktop:failed'))
  return data
}

export function isRemoteDesktop() { return !!connection?.remote }
export function setBeforeServerDownload(callback) { beforeDownload = callback }

function status(text) { dialog.querySelector('[data-status]').textContent = text }

function setBusy(value) {
  busy = value
  for (const control of dialog.querySelectorAll('input, [data-apply], [data-download]')) control.disabled = value
  dialog.querySelector('[data-url]').disabled = value || !dialog.querySelector('[value=remote]').checked
}

async function pollDownload() {
  clearTimeout(pollTimer)
  try {
    const job = await connectionRequest('download')
    const running = job.status === 'downloading' || job.status === 'importing'
    setBusy(running)
    if (job.status === 'downloading') status(t('desktop:downloading', { size: (job.bytes / 1024 ** 2).toFixed(1) }))
    if (job.status === 'importing') status(t('desktop:importing'))
    if (job.status === 'completed') status(t('desktop:completed', { count: job.documents }))
    if (job.status === 'failed') status(job.error)
    if (running) pollTimer = setTimeout(pollDownload, 1000)
  } catch (error) {
    // A lost response does not mean the import stopped. Keep mode changes
    // disabled and recover progress instead of inviting a duplicate import.
    status(error.message)
    if (busy) pollTimer = setTimeout(pollDownload, 2000)
  }
}

function makeDialog(onboarding = false) {
  dialog = document.createElement('dialog')
  dialog.className = 'desktop-connection-dialog'
  dialog.setAttribute('aria-labelledby', 'desktop-connection-title')
  dialog.innerHTML = `
    <form>
      <h2 id="desktop-connection-title"></h2>
      <p data-i18n="desktop:preserved"></p>
      <fieldset>
        <label><input type="radio" name="desktop-mode" value="local"><span data-i18n="desktop:local"></span></label>
        <label><input type="radio" name="desktop-mode" value="remote"><span data-i18n="desktop:remote"></span></label>
      </fieldset>
      <label for="desktop-server-url" data-i18n="desktop:url"></label>
      <input id="desktop-server-url" data-url type="url" placeholder="https://paper.example.com" maxlength="2048" autocomplete="url" aria-describedby="desktop-url-help">
      <p id="desktop-url-help" data-i18n="desktop:urlHelp"></p>
      <section data-transfer hidden>
        <p data-i18n="desktop:downloadHelp"></p>
        <button type="button" data-download data-i18n="desktop:download"></button>
      </section>
      <p data-status role="status" aria-live="polite"></p>
      <footer>
        <button type="button" data-close data-i18n="desktop:close"></button>
        <button type="submit" data-apply data-i18n="desktop:apply"></button>
      </footer>
    </form>`
  dialog.querySelector('h2').textContent = onboarding ? t('desktop:title') : t('desktop:settingsTitle')
  for (const node of dialog.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n)
  document.body.append(dialog)
  dialog.querySelector('[data-close]').hidden = onboarding
  dialog.addEventListener('cancel', event => { if (onboarding) event.preventDefault() })
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close())
  for (const radio of dialog.querySelectorAll('[name=desktop-mode]')) radio.addEventListener('change', () => {
    const remote = dialog.querySelector('[value=remote]').checked
    dialog.querySelector('[data-url]').disabled = !remote
    dialog.querySelector('[data-url]').required = remote
  })
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault()
    if (busy) return
    const enabled = dialog.querySelector('[value=remote]').checked
    const server_url = dialog.querySelector('[data-url]').value.trim()
    setBusy(true)
    status(t('desktop:connecting'))
    try {
      const next = await connectionRequest('connection', { method: 'PUT', body: JSON.stringify({ enabled, server_url }) })
      // Navigation (not a live API switch) stops the old document runtime and
      // restores the browser storage belonging to the selected origin.
      window.location.replace(next.destination)
    } catch (error) {
      status(error.message)
      setBusy(false)
    }
  })
  dialog.querySelector('[data-download]').addEventListener('click', async () => {
    if (busy || !window.confirm(t('desktop:confirmDownload'))) return
    setBusy(true)
    status(t('desktop:downloading', { size: '0.0' }))
    try {
      await beforeDownload()
      await connectionRequest('download', { method: 'POST' })
      await pollDownload()
    } catch (error) {
      status(error.message)
      // The request may have reached the server even if its response was lost.
      await pollDownload()
    }
  })
  return dialog
}

async function openSettings() {
  if (!dialog) makeDialog()
  dialog.showModal()
  try {
    connection = await connectionRequest('connection')
    populate()
    await pollDownload()
  } catch (error) { status(error.message) }
}

function populate() {
  dialog.querySelector(`[value=${connection.enabled ? 'remote' : 'local'}]`).checked = true
  dialog.querySelector('[data-url]').value = connection.server_url
  dialog.querySelector('[data-url]').disabled = !connection.enabled
  dialog.querySelector('[data-url]').required = connection.enabled
  dialog.querySelector('[data-transfer]').hidden = !connection.remote || !connection.enabled
  status(connection.error || '')
}

// Run before main.js or any reader module touches localStorage or the API.
export async function prepareDesktopConnection() {
  if (!window.__TAURI_INTERNALS__) return true
  await initI18n()
  await loadNamespaces(['desktop'])
  try {
    connection = await connectionRequest('connection')
  } catch (error) {
    const panel = document.createElement('dialog')
    panel.className = 'desktop-connection-dialog'
    const text = document.createElement('p')
    text.textContent = t('desktop:connectionError') + ' ' + error.message
    const retry = document.createElement('button')
    retry.textContent = t('desktop:retry')
    retry.onclick = () => location.reload()
    panel.append(text, retry)
    panel.addEventListener('cancel', event => event.preventDefault())
    document.body.append(panel)
    panel.showModal()
    return false
  }
  if (!connection.onboarded || connection.error) {
    makeDialog(true)
    populate()
    dialog.showModal()
    return false
  }
  if (new URL(connection.destination).origin !== location.origin) {
    location.replace(connection.destination)
    return false
  }
  if (window.parent !== window) return true
  const badge = document.createElement('button')
  badge.type = 'button'
  badge.className = 'desktop-connection-badge'
  badge.textContent = (connection.remote ? t('desktop:badgeRemote') : t('desktop:badgeLocal'))
  badge.title = connection.remote ? connection.server_url : t('desktop:settingsTitle')
  badge.addEventListener('click', openSettings)
  document.body.append(badge)
  const section = document.createElement('section')
  section.className = 'desktop-connection-section'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-secondary'
  button.textContent = t('desktop:settingsTitle')
  button.addEventListener('click', openSettings)
  const help = document.createElement('p')
  help.textContent = t('desktop:localSettings')
  section.append(button, help)
  document.getElementById('tab-data-system')?.prepend(section)
  document.addEventListener('easypaper:locale-changed', () => {
    badge.textContent = (connection.remote ? t('desktop:badgeRemote') : t('desktop:badgeLocal'))
    button.textContent = t('desktop:settingsTitle')
    help.textContent = t('desktop:localSettings')
    for (const node of dialog?.querySelectorAll('[data-i18n]') || []) node.textContent = t(node.dataset.i18n)
  })
  return true
}
