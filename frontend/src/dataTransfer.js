import { t } from './i18n.js'
import { checkAuthAPI, saveSystemSettingsAPI } from './api.js'

import { collectBrowserData, prepareBrowserRestore, restoreBrowserData } from './dataTransferStorage.js'

async function checked(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(typeof body.detail === 'string' ? body.detail : t('settings:dataTransfer.failed'))
  }
  return response
}

export function initializeDataTransfer({ confirmImport, beforeExport = async () => {} } = {}) {
  const exportButton = document.getElementById('user-data-export')
  const importButton = document.getElementById('user-data-import')
  const input = document.getElementById('user-data-file')
  const status = document.getElementById('user-data-status')
  const reloadButton = document.getElementById('user-data-reload')
  const retryButton = document.getElementById('user-data-retry')
  const systemSettings = document.getElementById('user-data-system-settings')
  let pendingRestore = null
  let transferBusy = false
  const busy = value => {
    transferBusy = value
    exportButton.disabled = value
    importButton.disabled = value || !!pendingRestore
    input.disabled = value || !!pendingRestore
    systemSettings.disabled = value || !!pendingRestore
    retryButton.disabled = value || !pendingRestore
    retryButton.hidden = !pendingRestore
    reloadButton.disabled = value || !!pendingRestore
  }
  reloadButton.addEventListener('click', () => window.location.reload())
  const finishRestore = async () => {
    const { result } = pendingRestore
    pendingRestore.browser ??= prepareBrowserRestore(result.browser_data, result.id_map, pendingRestore.username, window.location.origin)
    restoreBrowserData(pendingRestore.browser)
    if (pendingRestore.system && Object.keys(result.system_settings || {}).length) {
      await saveSystemSettingsAPI(result.system_settings)
    }
    pendingRestore = null
    status.textContent = t('settings:dataTransfer.imported', { count: result.documents })
    reloadButton.hidden = false
  }
  retryButton.addEventListener('click', async () => {
    if (transferBusy || !pendingRestore) return
    busy(true)
    try { await finishRestore() } catch (error) { status.textContent = `${t('settings:dataTransfer.partial')} ${error.message}` }
    finally { busy(false) }
  })
  exportButton.addEventListener('click', async () => {
    if (transferBusy) return
    busy(true)
    status.textContent = t('settings:dataTransfer.exporting')
    try {
      await beforeExport()
      const response = await checked(await fetch('/api/user-data/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectBrowserData()),
      }))
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `easypaper-user-data-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      status.textContent = t('settings:dataTransfer.exported')
    } catch (error) { status.textContent = `${t('settings:dataTransfer.failed')} ${error.message}` }
    finally { busy(false) }
  })
  importButton.addEventListener('click', () => {
    if (!transferBusy && !pendingRestore) input.click()
  })
  input.addEventListener('change', async () => {
    if (transferBusy || pendingRestore) { input.value = ''; return }
    const file = input.files?.[0]
    if (!file) return
    const restoreSystemSettings = systemSettings.checked
    busy(true)
    try {
      if (!await confirmImport(t('settings:dataTransfer.confirm'))) return
      reloadButton.hidden = true
      status.textContent = t('settings:dataTransfer.importing')
      const auth = await checkAuthAPI()
      if (file.size > 4 * 1024 ** 3) throw new Error(t('settings:dataTransfer.tooLarge'))
      const result = await (await checked(await fetch('/api/user-data/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file }))).json()
      pendingRestore = { result, username: auth.username, system: restoreSystemSettings }
      await finishRestore()
    } catch (error) {
      status.textContent = `${t(pendingRestore ? 'settings:dataTransfer.partial' : 'settings:dataTransfer.failed')} ${error.message}`
    } finally { input.value = ''; busy(false) }
  })
}
