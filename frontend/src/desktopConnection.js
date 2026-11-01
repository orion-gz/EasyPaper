import { initI18n, loadNamespaces, t } from './i18n.js'
import './styles/desktop-connection.css'

let connection = null
let dialog = null
let beforeDownload = async () => {}
let pollTimer = null
let busy = false
let syncPreview = null
let automaticTimer = null

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
  for (const control of dialog.querySelectorAll('input, select, [data-apply], [data-download], [data-sync]')) control.disabled = value || !!syncPreview
  for (const control of dialog.querySelectorAll('[data-confirm-sync], [data-cancel-sync]')) control.disabled = value
  dialog.querySelector('[data-url]').disabled = value || !!syncPreview || !dialog.querySelector('[value=remote]').checked
  dialog.querySelector('[data-close]').disabled = value || !!syncPreview
  dialog.querySelector('[data-automatic]').disabled = value || !!syncPreview || dialog.querySelector('[data-action]').value !== 'merge'
  dialog.querySelector('[data-sync]').disabled = value || !!syncPreview || dialog.querySelector('[data-action]').value === 'defer'
}

async function pollDownload() {
  clearTimeout(pollTimer)
  try {
    const job = await connectionRequest('download')
    const running = ['uploading', 'downloading', 'importing'].includes(job.status)
    setBusy(running)
    if (job.status === 'uploading') status(t('desktop:syncUploading'))
    if (job.status === 'downloading') status(t('desktop:downloading', { size: (job.bytes / 1024 ** 2).toFixed(1) }))
    if (job.status === 'importing') status(t('desktop:importing'))
    if (job.status === 'completed') {
      status(job.kind === 'sync' ? t('desktop:syncCompleted', { count: job.documents }) : t('desktop:completed', { count: job.documents }))
      dialog.querySelector('[data-reload]').hidden = job.kind !== 'sync'
      if (job.kind === 'sync') {
        dialog.querySelector('[data-action]').value = 'merge'
        connection.sync = { ...connection.sync, action: 'merge' }
      }
    }
    if (job.status === 'conflict') {
      status(t('desktop:syncConflict'))
      clearInterval(automaticTimer)
      if (!dialog.open) dialog.showModal()
    }
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
      <section data-policy hidden>
        <label for="desktop-data-action" data-i18n="desktop:dataAction"></label>
        <select id="desktop-data-action" data-action>
          <option value="defer" data-i18n="desktop:defer"></option>
          <option value="merge" data-i18n="desktop:merge"></option>
          <option value="replace_local" data-i18n="desktop:replaceLocal"></option>
          <option value="replace_remote" data-i18n="desktop:replaceRemote"></option>
        </select>
        <p data-i18n="desktop:actionHelp"></p>
        <label><input type="checkbox" data-automatic><span data-i18n="desktop:automatic"></span></label>
      </section>
      <section data-transfer hidden>
        <p data-i18n="desktop:syncHelp"></p>
        <button type="button" data-sync data-i18n="desktop:syncNow"></button>
        <section data-preview hidden>
          <p data-preview-summary></p>
          <p data-preview-warning></p>
          <button type="button" data-cancel-sync data-i18n="desktop:cancelSync"></button>
          <button type="button" data-confirm-sync data-i18n="desktop:confirmSync"></button>
        </section>
        <p data-i18n="desktop:downloadHelp"></p>
        <button type="button" data-download data-i18n="desktop:download"></button>
      </section>
      <p data-status role="status" aria-live="polite"></p>
      <button type="button" data-reload hidden data-i18n="desktop:reload"></button>
      <footer>
        <button type="button" data-close data-i18n="desktop:close"></button>
        <button type="submit" data-apply data-i18n="desktop:apply"></button>
      </footer>
    </form>`
  dialog.querySelector('h2').textContent = onboarding ? t('desktop:title') : t('desktop:settingsTitle')
  for (const node of dialog.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n)
  document.body.append(dialog)
  dialog.querySelector('[data-close]').hidden = onboarding
  dialog.addEventListener('cancel', event => { if (onboarding || busy || syncPreview) event.preventDefault() })
  dialog.querySelector('[data-close]').addEventListener('click', () => { if (!busy && !syncPreview) dialog.close() })
  dialog.querySelector('[data-reload]').addEventListener('click', () => location.reload())
  dialog.querySelector('[data-action]').addEventListener('change', () => {
    if (dialog.querySelector('[data-action]').value !== 'merge') dialog.querySelector('[data-automatic]').checked = false
    setBusy(false)
  })
  for (const radio of dialog.querySelectorAll('[name=desktop-mode]')) radio.addEventListener('change', () => {
    const remote = dialog.querySelector('[value=remote]').checked
    dialog.querySelector('[data-url]').disabled = !remote
    dialog.querySelector('[data-url]').required = remote
    dialog.querySelector('[data-policy]').hidden = !remote
    dialog.querySelector('[data-transfer]').hidden = !remote || !connection.remote
  })
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault()
    if (busy) return
    const enabled = dialog.querySelector('[value=remote]').checked
    const server_url = dialog.querySelector('[data-url]').value.trim()
    setBusy(true)
    status(t('desktop:connecting'))
    try {
      const sync = { action: dialog.querySelector('[data-action]').value, automatic: dialog.querySelector('[data-automatic]').checked }
      const next = await connectionRequest('connection', { method: 'PUT', body: JSON.stringify({ enabled, server_url, sync }) })
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
  dialog.querySelector('[data-sync]').addEventListener('click', () => prepareSync())
  dialog.querySelector('[data-cancel-sync]').addEventListener('click', () => {
    syncPreview = null
    dialog.querySelector('[data-preview]').hidden = true
    status(t('desktop:syncCancelled'))
    setBusy(false)
  })
  dialog.querySelector('[data-confirm-sync]').addEventListener('click', () => startSync())
  return dialog
}

async function prepareSync(automatic = false) {
  if (busy || syncPreview) return
  if (!dialog) { makeDialog(); populate() }
  const action = automatic ? 'merge' : dialog.querySelector('[data-action]').value
  if (action === 'defer') return
  if (dialog.querySelector('[data-url]').value.trim() !== connection.server_url) {
    status(t('desktop:saveAddressFirst'))
    return
  }
  setBusy(true)
  status(t('desktop:syncPreparing'))
  try {
    await beforeDownload()
    connection = await connectionRequest('connection', { method: 'PUT', body: JSON.stringify({
      enabled: true, server_url: connection.server_url,
      sync: { action, automatic: automatic || connection.sync?.automatic === true },
    }) })
    syncPreview = await connectionRequest('sync/preview', { method: 'POST', body: JSON.stringify({ action }) })
    if (automatic && syncPreview.action !== 'merge') {
      syncPreview = null
      setBusy(false)
      return
    }
    dialog.querySelector('[data-preview-summary]').textContent = t('desktop:previewCounts', {
      local: syncPreview.local_documents, remote: syncPreview.remote_documents,
    })
    dialog.querySelector('[data-preview-warning]').textContent = syncPreview.action === 'replace_local'
      ? t('desktop:confirmReplaceLocal') : syncPreview.action === 'replace_remote'
        ? t('desktop:confirmReplaceRemote') : t('desktop:confirmMerge')
    dialog.querySelector('[data-preview]').hidden = false
    status(syncPreview.resume ? t('desktop:syncResume') : '')
    setBusy(false)
    if (automatic) await startSync()
  } catch (error) {
    status(error.message)
    setBusy(false)
  }
}

async function startSync() {
  if (busy || !syncPreview) return
  setBusy(true)
  try {
    const automatic = dialog.querySelector('[data-automatic]').checked && syncPreview.action === 'merge'
    await connectionRequest('sync', { method: 'POST', body: JSON.stringify({ plan_id: syncPreview.plan_id, confirmed: true, automatic }) })
    connection.sync = { ...connection.sync, automatic }
    syncPreview = null
    dialog.querySelector('[data-preview]').hidden = true
    await pollDownload()
  } catch (error) {
    status(error.message)
    setBusy(false)
  }
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
  dialog.querySelector('[data-policy]').hidden = !connection.enabled
  dialog.querySelector('[data-action]').value = connection.sync?.action || 'defer'
  dialog.querySelector('[data-automatic]').checked = connection.sync?.automatic === true
  setBusy(busy)
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
  automaticTimer = setInterval(() => {
    if (connection.remote && connection.sync?.automatic && connection.sync.action === 'merge'
        && document.visibilityState === 'visible' && !document.querySelector('.workspace-document-frame')
        && !dialog?.open) prepareSync(true)
  }, 5 * 60 * 1000)
  document.addEventListener('easypaper:locale-changed', () => {
    badge.textContent = (connection.remote ? t('desktop:badgeRemote') : t('desktop:badgeLocal'))
    button.textContent = t('desktop:settingsTitle')
    help.textContent = t('desktop:localSettings')
    for (const node of dialog?.querySelectorAll('[data-i18n]') || []) node.textContent = t(node.dataset.i18n)
  })
  return true
}
