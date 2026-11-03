import { setSyncProgress } from './syncProgress.js'
import { initI18n, loadNamespaces, t } from './i18n.js'
import './styles/desktop-connection.css'
import { getModeSetting } from './modeSettings.js'
import { applyTheme, loadThemes, selectedTheme } from './themes/themeEngine.js'

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

function status(text, state = '') {
  const node = dialog.querySelector('[data-status]')
  node.textContent = text
  node.dataset.state = state
}

function updatePolicy() {
  const action = dialog.querySelector('[data-action]').value
  dialog.querySelector('[data-policy]').dataset.policyAction = action
  dialog.querySelector('[data-action-description]').textContent = ({
    merge: t('desktop:confirmMerge'), replace_local: t('desktop:confirmReplaceLocal'), replace_remote: t('desktop:confirmReplaceRemote'), defer: t('desktop:deferHelp'),
  })[action]
}

function showConflicts(conflicts = []) {
  const panel = dialog.querySelector('[data-conflicts]')
  panel.hidden = false
  const list = panel.querySelector('ul')
  list.replaceChildren()
  const categories = {
    documents: t('desktop:conflictDocuments'), files: t('desktop:conflictFiles'), annotations: t('desktop:conflictNotes'), memos: t('desktop:conflictNotes'),
    chats: t('desktop:conflictChats'), compare_sessions: t('desktop:conflictChats'), folders: t('desktop:conflictFolders'), document_folders: t('desktop:conflictFolders'),
    checkpoint: t('desktop:conflictCheckpoint'), confirmation: t('desktop:conflictConfirmation'),
  }
  const seen = new Set()
  for (const conflict of conflicts) {
    const label = categories[conflict.table] || t('desktop:conflictRecords')
    const text = conflict.document ? `${label} · ${conflict.document}` : label
    if (seen.has(text)) continue
    seen.add(text)
    const item = document.createElement('li')
    item.textContent = text
    list.append(item)
  }
  if (!list.children.length) {
    const item = document.createElement('li')
    item.textContent = t('desktop:conflictRecords')
    list.append(item)
  }
}

function setBusy(value) {
  busy = value
  dialog.querySelector('form').setAttribute('aria-busy', String(value))
  dialog.querySelector('[data-progress]').hidden = !value
  for (const control of dialog.querySelectorAll('input, select, [data-apply], [data-download], [data-sync]')) control.disabled = value || !!syncPreview
  for (const control of dialog.querySelectorAll('[data-confirm-sync], [data-cancel-sync]')) control.disabled = value
  dialog.querySelector('[data-acknowledge]').disabled = value
  if (syncPreview?.action.startsWith('replace_')) {
    dialog.querySelector('[data-confirm-sync]').disabled = value || !dialog.querySelector('[data-acknowledge]').checked
  }
  dialog.querySelector('[data-url]').disabled = value || !!syncPreview || !dialog.querySelector('[value=remote]').checked
  dialog.querySelector('[data-close]').disabled = value || !!syncPreview
  if (connection?.access_mode === 'offline') dialog.querySelector('[data-download]').disabled = true
  dialog.querySelector('[data-automatic]').disabled = value || !!syncPreview || dialog.querySelector('[data-action]').value !== 'merge'
  dialog.querySelector('[data-sync]').disabled = value || !!syncPreview || dialog.querySelector('[data-action]').value === 'defer'
}

async function pollDownload() {
  clearTimeout(pollTimer)
  try {
    const job = await connectionRequest('download')
    const running = ['uploading', 'downloading', 'importing'].includes(job.status)
    setSyncProgress('desktop-transfer', running)
    setBusy(running)
    if (job.status === 'uploading') status(t('desktop:syncUploading'))
    if (job.status === 'downloading') status(t('desktop:downloading', { size: (job.bytes / 1024 ** 2).toFixed(1) }))
    if (job.status === 'importing') status(t('desktop:importing'))
    if (job.status === 'completed') {
      status(job.kind === 'sync' ? t('desktop:syncCompleted', { count: job.documents }) : t('desktop:completed', { count: job.documents }), 'success')
      dialog.querySelector('[data-reload]').hidden = job.kind !== 'sync'
      if (job.kind === 'sync') {
        if (connection.access_mode === 'offline' && !connection.sync?.offline_ready) {
          window.location.reload()
          return
        }
        dialog.querySelector('[data-action]').value = 'merge'
        dialog.querySelector('[data-action]').dispatchEvent(new Event('change'))
        connection.sync = { ...connection.sync, action: 'merge' }
        updatePolicy()
        setBusy(false)
      }
    }
    if (job.status === 'conflict') {
      status(t('desktop:syncConflict'), 'warning')
      connection.sync = { ...connection.sync, automatic: false }
      dialog.querySelector('[data-automatic]').checked = false
      showConflicts(job.conflicts)
      if (!dialog.open) dialog.showModal()
    }
    if (job.status === 'failed') status(job.error, 'error')
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
      <div class="desktop-connection-eyebrow">EasyPaper <span data-i18n="desktop:workspace"></span></div>
      <h2 id="desktop-connection-title"></h2>
      <p data-i18n="desktop:preserved"></p>
      <fieldset class="desktop-mode-options">
        <legend data-i18n="desktop:modeLegend"></legend>
        <label><input type="radio" name="desktop-mode" value="local"><span><strong data-i18n="desktop:local"></strong><small data-i18n="desktop:localHint"></small></span></label>
        <label><input type="radio" name="desktop-mode" value="remote"><span><strong data-i18n="desktop:remote"></strong><small data-i18n="desktop:remoteHint"></small></span></label>
      </fieldset>
      <div class="desktop-server-address">
      <label for="desktop-server-url" data-i18n="desktop:url"></label>
      <input id="desktop-server-url" data-url type="url" placeholder="https://paper.example.com" maxlength="2048" autocomplete="url" aria-describedby="desktop-url-help">
      <p id="desktop-url-help" data-i18n="desktop:urlHelp"></p>
      </div>
      <label for="desktop-access-mode" data-i18n="desktop:accessMode"></label>
      <select id="desktop-access-mode" class="form-select" data-access-mode>
        <option value="server" data-i18n="desktop:accessServer"></option>
        <option value="offline" data-i18n="desktop:accessOffline"></option>
      </select>
      <p data-i18n="desktop:offlineHelp"></p>
      <section data-policy hidden>
        <h3 data-i18n="desktop:syncTitle"></h3>
        <label for="desktop-data-action" data-i18n="desktop:dataAction"></label>
        <select id="desktop-data-action" class="form-select" data-action aria-describedby="desktop-action-description">
          <option value="defer" data-i18n="desktop:defer"></option>
          <option value="merge" data-i18n="desktop:merge"></option>
          <option value="replace_local" data-i18n="desktop:replaceLocal"></option>
          <option value="replace_remote" data-i18n="desktop:replaceRemote"></option>
        </select>
        <p id="desktop-action-description" data-action-description></p>
        <p class="desktop-fine-print" data-i18n="desktop:actionHelp"></p>
        <label class="desktop-auto-option"><input type="checkbox" data-automatic><span data-i18n="desktop:automatic"></span></label>
      </section>
      <section data-transfer hidden>
        <p data-i18n="desktop:syncHelp"></p>
        <button type="button" data-sync data-i18n="desktop:syncNow"></button>
        <section data-preview hidden>
          <h3 data-i18n="desktop:previewTitle"></h3>
          <p class="desktop-sr-only" data-preview-summary></p>
          <div class="desktop-library-counts" aria-hidden="true">
            <div><span data-i18n="desktop:localLibrary"></span><strong data-local-count></strong></div>
            <span class="desktop-transfer-direction" data-direction></span>
            <div><span data-i18n="desktop:serverLibrary"></span><strong data-remote-count></strong></div>
          </div>
          <p data-preview-warning></p>
          <label class="desktop-delete-ack" data-acknowledge-label hidden><input type="checkbox" data-acknowledge><span data-i18n="desktop:acknowledgeDeletion"></span></label>
          <div class="desktop-preview-actions">
          <button type="button" data-cancel-sync data-i18n="desktop:cancelSync"></button>
          <button type="button" data-confirm-sync data-i18n="desktop:confirmSync"></button>
          </div>
        </section>
        <section data-conflicts hidden tabindex="-1" aria-labelledby="desktop-conflicts-title">
          <h3 id="desktop-conflicts-title" data-i18n="desktop:conflictsTitle"></h3>
          <ul></ul>
          <p data-i18n="desktop:conflictsHelp"></p>
        </section>
        <details class="desktop-copy-option"><summary data-i18n="desktop:copyTitle"></summary>
        <p data-i18n="desktop:downloadHelp"></p>
        <button type="button" data-download data-i18n="desktop:download"></button>
        </details>
      </section>
      <progress data-progress hidden aria-label="${t('desktop:transferProgress')}"></progress>
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
  dialog.querySelector('[data-access-mode]').addEventListener('change', () => {
    if (dialog.querySelector('[data-access-mode]').value === 'offline') {
      dialog.querySelector('[data-action]').value = 'merge'
      dialog.querySelector('[data-automatic]').checked = true
      updatePolicy()
    }
  })
  dialog.querySelector('[data-action]').addEventListener('change', () => {
    if (dialog.querySelector('[data-action]').value !== 'merge') dialog.querySelector('[data-automatic]').checked = false
    updatePolicy()
    setBusy(busy)
  })
  dialog.querySelector('[data-acknowledge]').addEventListener('change', () => setBusy(busy))
  for (const radio of dialog.querySelectorAll('[name=desktop-mode]')) radio.addEventListener('change', () => {
    const remote = dialog.querySelector('[value=remote]').checked
    dialog.querySelector('[data-url]').disabled = !remote
    dialog.querySelector('[data-url]').required = remote
    dialog.querySelector('[data-policy]').hidden = !remote
    dialog.querySelector('[data-transfer]').hidden = !remote || !connection.remote
  })
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault()
    if (busy || syncPreview) return
    const enabled = dialog.querySelector('[value=remote]').checked
    const server_url = dialog.querySelector('[data-url]').value.trim()
    setBusy(true)
    status(t('desktop:connecting'))
    try {
      const offline = dialog.querySelector('[data-access-mode]').value === 'offline'
      const sync = { action: offline ? 'merge' : dialog.querySelector('[data-action]').value, automatic: offline || dialog.querySelector('[data-automatic]').checked }
      const next = await connectionRequest('connection', { method: 'PUT', body: JSON.stringify({ enabled, server_url, sync, access_mode: dialog.querySelector('[data-access-mode]').value }) })
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
    dialog.querySelector('[data-sync]').focus()
  })
  dialog.querySelector('[data-confirm-sync]').addEventListener('click', () => startSync())
  return dialog
}

async function prepareSync(automatic = false) {
  if (busy || syncPreview) return
  if (!dialog) { makeDialog(); populate() }
  const action = automatic || connection.access_mode === 'offline' ? 'merge' : dialog.querySelector('[data-action]').value
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
      sync: { action, automatic: action === 'merge' && (automatic || connection.sync?.automatic === true) },
    }) })
    syncPreview = await connectionRequest('sync/preview', { method: 'POST', body: JSON.stringify({ action, automatic }) })
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
    const destructive = syncPreview.action.startsWith('replace_')
    dialog.querySelector('[data-preview]').dataset.destructive = String(destructive)
    dialog.querySelector('[data-local-count]').textContent = syncPreview.local_documents
    dialog.querySelector('[data-remote-count]').textContent = syncPreview.remote_documents
    dialog.querySelector('[data-direction]').textContent = syncPreview.action === 'replace_local' ? '←' : syncPreview.action === 'replace_remote' ? '→' : '↔'
    dialog.querySelector('[data-acknowledge-label]').hidden = !destructive
    dialog.querySelector('[data-acknowledge]').checked = false
    dialog.querySelector('[data-confirm-sync]').textContent = destructive ? t('desktop:confirmDeletion') : t('desktop:confirmSync')
    dialog.querySelector('[data-conflicts]').hidden = true
    dialog.querySelector('[data-preview]').hidden = false
    status(syncPreview.resume ? t('desktop:syncResume') : '')
    setBusy(false)
    if (automatic) await startSync()
    else dialog.querySelector(destructive ? '[data-acknowledge]' : '[data-confirm-sync]').focus()
  } catch (error) {
    status(error.message)
    setBusy(false)
  }
}

async function startSync() {
  if (busy || !syncPreview) return
  if (syncPreview.action.startsWith('replace_') && !dialog.querySelector('[data-acknowledge]').checked) return
  setBusy(true)
  try {
    const automatic = dialog.querySelector('[data-automatic]').checked && syncPreview.action === 'merge'
    await connectionRequest('sync', { method: 'POST', body: JSON.stringify({ plan_id: syncPreview.plan_id, confirmed: true, automatic }) })
    connection.sync = { ...connection.sync, automatic }
    syncPreview = null
    dialog.querySelector('[data-preview]').hidden = true
    dialog.querySelector('[data-conflicts]').hidden = true
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
  dialog.querySelector('[data-access-mode]').value = connection.access_mode || 'server'
  dialog.querySelector('[data-url]').value = connection.server_url
  dialog.querySelector('[data-url]').disabled = !connection.enabled
  dialog.querySelector('[data-url]').required = connection.enabled
  dialog.querySelector('[data-transfer]').hidden = !connection.remote || !connection.enabled
  dialog.querySelector('[data-policy]').hidden = !connection.enabled
  dialog.querySelector('[data-action]').value = connection.sync?.action || 'defer'
  dialog.querySelector('[data-action]').dispatchEvent(new Event('change'))
  dialog.querySelector('[data-automatic]').checked = connection.sync?.automatic === true
  updatePolicy()
  setBusy(busy)
  status(connection.error || '')
}

// Run before main.js or any reader module touches localStorage or the API.
export async function prepareDesktopConnection() {
  if (!window.__TAURI_INTERNALS__) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initDevicePanel(), { once: true })
    } else {
      await initDevicePanel()
    }
    return true
  }
  const mode = localStorage.getItem('easypaper_workspace_mode') === 'general' ? 'general' : 'research'
  const scheme = getModeSetting('theme', mode) === 'light' ? 'light' : 'dark'
  applyTheme(document.body, selectedTheme(mode, scheme, loadThemes()))
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
  badge.className = 'btn btn-secondary desktop-connection-badge'
  badge.textContent = (connection.remote ? t('desktop:badgeRemote') : t('desktop:badgeLocal'))
  badge.title = connection.remote ? connection.server_url : t('desktop:settingsTitle')
  badge.addEventListener('click', openSettings)
  document.body.append(badge)
  const section = document.createElement('section')
  section.className = 'desktop-connection-section form-group settings-action-card'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-primary'
  button.textContent = t('desktop:settingsTitle')
  button.addEventListener('click', openSettings)
  const help = document.createElement('p')
  help.textContent = t('desktop:localSettings')
  const syncButton = document.createElement('button')
  syncButton.type = 'button'
  syncButton.className = 'btn btn-secondary'
  syncButton.textContent = t('desktop:syncNow')
  syncButton.addEventListener('click', async () => {
    await openSettings()
    if (connection.remote) await prepareSync()
  })
  section.append(button, syncButton, help)
  startDeviceHeartbeat()
  document.querySelector('#tab-data-system .modal-form')?.prepend(section)
  makeDialog()
  populate()
  await pollDownload()
  const autoSync = () => {
    if (connection.remote && connection.sync?.automatic && connection.sync.action === 'merge'
        && document.visibilityState === 'visible' && (connection.access_mode === 'offline' || !document.querySelector('.workspace-document-frame'))
        && !dialog?.open) prepareSync(true)
  }
  automaticTimer = setInterval(autoSync, connection.access_mode === 'offline' ? 30 * 1000 : 5 * 60 * 1000)
  window.addEventListener('online', autoSync)
  if (connection.access_mode === 'offline') autoSync()
  document.addEventListener('easypaper:locale-changed', () => {
    badge.textContent = (connection.remote ? t('desktop:badgeRemote') : t('desktop:badgeLocal'))
    button.textContent = t('desktop:settingsTitle')
    help.textContent = t('desktop:localSettings')
    for (const node of dialog?.querySelectorAll('[data-i18n]') || []) node.textContent = t(node.dataset.i18n)
  })
  return true
}


async function deviceRequest(path = '', options = {}) {
  const response = await fetch('/api/user-data/devices' + path, {
    ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
  })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : t('desktop:failed'))
  return data
}

function startDeviceHeartbeat() {
  let acknowledged = false
  let deviceId = localStorage.getItem('easypaper-device-id')
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    localStorage.setItem('easypaper-device-id', deviceId)
  }
  const tick = async () => {
    try {
      if (!connection.remote) return
      const job = await connectionRequest('download')
      const result = await deviceRequest('/' + deviceId, { method: 'PUT', body: JSON.stringify({
        name: navigator.platform || 'Desktop', status: job.status,
        action: connection.sync?.action, automatic: connection.sync?.automatic, acknowledged,
      }) })
      acknowledged = false
      if (result.requested && !busy && !syncPreview && !dialog?.open && connection.sync?.action === 'merge') {
        // Remote requests open the existing preview; confirmation remains local.
        await openSettings()
        await prepareSync()
        acknowledged = true
      }
    } catch { /* Retry after login or connectivity recovers. */ }
    finally { setTimeout(tick, 15000) }
  }
  tick()
}

async function initDevicePanel() {
  if (window.parent !== window) return
  await initI18n()
  await loadNamespaces(['desktop'])
  const target = document.getElementById('tab-data-system')
  if (!target) return
  const section = document.createElement('section')
  section.className = 'desktop-connection-section'
  target.prepend(section)
  const refresh = async () => {
    try {
      const { devices } = await deviceRequest()
      section.replaceChildren()
      for (const device of devices) {
        const row = document.createElement('div')
        const title = document.createElement('h3')
        title.textContent = device.name
        const details = document.createElement('p')
        details.textContent = t('desktop:deviceDetails', {
          online: device.online ? t('desktop:online') : t('desktop:offline'),
          status: device.status, action: device.action,
          automatic: device.automatic ? t('desktop:enabled') : t('desktop:disabled'),
          seen: new Date(device.seen * 1000).toLocaleString(),
        })
        const help = document.createElement('p')
        help.textContent = t('desktop:deviceHelp')
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'btn btn-secondary'
        button.textContent = device.requested ? t('desktop:requestPending') : t('desktop:syncNow')
        button.disabled = !device.online || device.action !== 'merge' || device.requested
        button.onclick = async () => {
          button.disabled = true
          try {
            await deviceRequest('/' + encodeURIComponent(device.id) + '/sync', { method: 'POST' })
            button.textContent = t('desktop:requestPending')
          } catch (error) { help.textContent = error.message; button.disabled = false }
        }
        row.append(title, details, help, button)
        section.append(row)
      }
    } catch { /* Authentication may not yet be available. */ }
    finally { setTimeout(refresh, 15000) }
  }
  refresh()
}
