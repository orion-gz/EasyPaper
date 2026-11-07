import { initializeLabGuide } from './labGuide.js'
import { connectionEditor } from './sshConnectionForm.js'
import { syncSelectValue } from './uiScale.js'
import { t, loadNamespaces } from './i18n.js'

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : t('settings:labFailed'))
  return result
}

export async function initializeLabMode() {
  await loadNamespaces(['settings'])
  initializeLabGuide()
  const status = document.getElementById('lab-status')
  const members = document.getElementById('lab-members')
  const personalStatus = document.getElementById('lab-personal-status')
  const report = error => {
    const target = document.getElementById('tab-model').classList.contains('active') ? personalStatus : status
    target.textContent = error.message
  }
  const providerSelect = document.getElementById('lab-personal-provider')
  const output = document.getElementById('lab-cli-output')
  let loginGeneration = 0
  let loginTimer
  function cancelPolling() {
    loginGeneration += 1
    clearTimeout(loginTimer)
  }
  function updateProviderControls() {
    cancelPolling()
    output.textContent = ''
    document.getElementById('lab-cli-actions').hidden = ['ollama', 'vllm'].includes(providerSelect.value)
  }
  providerSelect.addEventListener('change', updateProviderControls)
  window.addEventListener('pagehide', cancelPolling)
  async function pollLogin(provider, generation, expires) {
    if (generation !== loginGeneration || Date.now() >= expires || !output.getClientRects().length) return
    try {
      const result = await api(`/me/providers/${provider}`)
      if (generation !== loginGeneration) return
      output.textContent = [result.status, result.instructions].filter(Boolean).join('\n')
      if (result.status === 'pending') loginTimer = setTimeout(() => pollLogin(provider, generation, expires), 2000)
    } catch (error) {
      if (generation === loginGeneration) report(error)
    }
  }
  const run = action => async event => {
    event?.preventDefault()
    try { await action() } catch (error) { report(error) }
  }
  const resetPersonal = document.createElement('button')
  resetPersonal.type = 'button'
  resetPersonal.className = 'btn btn-secondary'
  resetPersonal.textContent = t('settings:connectionUsePersonalSettings')
  resetPersonal.onclick = run(async () => {
    await api('/me/model-settings', 'DELETE')
    await refresh()
  })
  document.querySelector('#lab-personal-form > .form-actions').append(resetPersonal)
  let servers = []
  let defaultId = null
  const form = document.getElementById('lab-inference-form')
  const editor = connectionEditor(form, data => api('/inference/ssh/host-key', 'POST', data))
  const serverSelect = document.createElement('select')
  serverSelect.id = 'lab-server-select'
  serverSelect.className = 'form-select'
  serverSelect.setAttribute('aria-label', t('settings:connectionInferenceServer'))
  const name = document.createElement('input')
  name.placeholder = t('settings:connectionServerName')
  name.setAttribute('aria-label', name.placeholder)
  name.required = true
  function settingsRow(control, title) {
    const row = document.createElement('div')
    row.className = 'form-group settings-row'
    const label = document.createElement('label')
    label.htmlFor = control.id
    label.textContent = title
    row.append(label, control)
    return row
  }
  name.id = 'lab-server-name'
  form.querySelector('.settings-section-heading').after(
    settingsRow(serverSelect, t('settings:connectionInferenceServer')),
    settingsRow(name, t('settings:connectionServerName')),
  )
  document.getElementById('lab-url').closest('.form-group').after(form.querySelector('.ssh-connection-form'))
  const personalServer = document.createElement('select')
  personalServer.id = 'lab-personal-server'
  personalServer.className = 'form-select'
  personalServer.setAttribute('aria-label', t('settings:connectionInferenceServer'))
  document.querySelector('#lab-personal-form .settings-section-heading').after(settingsRow(personalServer, t('settings:connectionInferenceServer')))
  function loadServer(server = {}) {
    name.value = server.name || ''
    syncSelectValue(document.getElementById('lab-engine'), server.engine || 'ollama')
    document.getElementById('lab-url').value = server.url || ''
    document.getElementById('lab-models').value = (server.models || []).join('\n')
    document.getElementById('lab-default-model').value = server.model || ''
    document.getElementById('lab-total-limit').value = server.max_concurrent || 2
    document.getElementById('lab-user-limit').value = server.per_user || 1
    document.getElementById('lab-api-key').value = ''
    editor.load(server)
  }
  serverSelect.onchange = () => loadServer(servers.find(s => s.id === serverSelect.value))
  personalServer.onchange = () => {
    const server = servers.find(s => s.id === personalServer.value)
    if (server) {
      syncSelectValue(document.getElementById('lab-personal-provider'), server.engine)
      document.getElementById('lab-personal-model').value = server.model
      updateProviderControls()
    }
  }
  for (const [label, action] of [
    [t('settings:connectionSetDefault'), async () => api(`/inference/servers/${serverSelect.value}/default`, 'POST')],
    [t('settings:connectionDeleteServer'), async () => {
      if (!window.confirm(t('settings:connectionDeleteThisServer'))) return
      await api(`/inference/servers/${serverSelect.value}`, 'DELETE')
    }],
  ]) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'btn btn-secondary'; button.textContent = label
    button.onclick = run(async () => { if (serverSelect.value) { await action(); await refresh() } })
    form.querySelector('.form-actions').append(button)
  }
  const personalForm = document.getElementById('lab-personal-form')
  let pendingRefreshes = 0
  async function refresh(preferredId) {
    pendingRefreshes += 1
    personalForm.inert = true
    try { await refreshSettings(preferredId) }
    finally {
      pendingRefreshes -= 1
      personalForm.inert = pendingRefreshes > 0
    }
  }
  async function refreshSettings(preferredId) {
    personalStatus.textContent = ''
    const profile = await api('/auth/me')
    document.getElementById('lab-admin').hidden = profile.role !== 'master'
    status.textContent = `${profile.username} · ${(profile.lab_mode ? t('settings:labOn') : t('settings:labOff'))}`
    document.getElementById('lab-enabled').checked = profile.lab_mode
    resetPersonal.hidden = !!profile.lab_mode
    resetPersonal.disabled = false
    const common = await api('/lab/inference')
    const personal = await api('/me/model-settings')
    const listing = await api('/inference/servers')
    editor.storage(listing.credential_storage)
    servers = listing.servers; defaultId = listing.default_id
    const previous = preferredId || serverSelect.value
    serverSelect.replaceChildren(new Option(t('settings:connectionNewServer'), ''))
    personalServer.replaceChildren()
    for (const server of servers) {
      const label = server.name + (server.id === defaultId ? ' ★' : '')
      serverSelect.add(new Option(label, server.id))
      personalServer.add(new Option(label, server.id))
    }
    syncSelectValue(serverSelect, servers.some(s => s.id === previous) ? previous : defaultId || '')
    syncSelectValue(personalServer, personal.server_id || defaultId || '')
    syncSelectValue(document.getElementById('lab-personal-provider'), personal.provider || common.engine)
    document.getElementById('lab-personal-model').value = personal.model || common.model
    updateProviderControls()
    if (profile.role !== 'master') return
    loadServer(servers.find(s => s.id === serverSelect.value))
    members.replaceChildren()
    for (const user of await api('/lab/users')) {
      const row = document.createElement('div')
      row.className = 'lab-member-row'
      const name = document.createElement('span')
      name.textContent = `${user.username} · ${user.role} `
      row.append(name)
      if (user.role === 'member') {
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'btn btn-secondary'
        toggle.textContent = (user.active ? t('settings:labDisable') : t('settings:labEnable'))
        toggle.onclick = run(async () => { await api(`/lab/users/${user.id}`, 'PATCH', { active: !user.active }); await refresh() })
        const reset = document.createElement('button')
        reset.type = 'button'
        reset.className = 'btn btn-secondary'
        reset.textContent = t('settings:labReset')
        reset.onclick = run(async () => {
          const result = await api(`/lab/users/${user.id}/reset-password`, 'POST')
          status.textContent = `${t('settings:labTemporaryPassword')}: ${result.temporary_password}`
        })
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'btn lab-delete-button'
        remove.textContent = t('settings:labDelete')
        remove.onclick = run(async () => {
          if (!window.confirm(t('settings:labDeleteConfirm', { username: user.username }))) return
          await api(`/lab/users/${user.id}`, 'DELETE')
          await refresh()
        })
        row.append(toggle, reset, remove)
      }
      members.append(row)
    }
  }
  document.addEventListener('easypaper:settings-category-changed', event => {
    if (['tab-lab', 'tab-model'].includes(event.detail.category)) run(() => refresh())()
    else cancelPolling()
  })
  document.getElementById('lab-mode-form').addEventListener('submit', run(async () => {
    const password = document.getElementById('lab-password')
    try { await api('/lab/settings', 'PUT', { enabled: document.getElementById('lab-enabled').checked, password: password.value }) }
    finally { password.value = '' }
    await refresh()
  }))
  document.getElementById('lab-member-form').addEventListener('submit', run(async () => {
    const input = document.getElementById('lab-username')
    const password = document.getElementById('lab-member-password')
    let result
    try {
      result = await api('/lab/users', 'POST', { username: input.value.trim(), ...(password.value ? { password: password.value } : {}) })
    } finally { password.value = '' }
    input.value = ''
    await refresh()
    status.textContent = `${result.username} — ${t('settings:labTemporaryPassword')}: ${result.temporary_password}`
  }))
  document.getElementById('lab-check-inference').addEventListener('click', run(async () => {
    if (!serverSelect.value) throw new Error(t('settings:connectionSaveTheServerFirst'))
    const result = await api(`/inference/servers/${serverSelect.value}/check`, 'POST')
    status.textContent = result.models.join(', ')
  }))
  document.getElementById('lab-inference-form').addEventListener('submit', run(async () => {
    const key = document.getElementById('lab-api-key')
    let saved
    try {
      const connection = editor.read()
      saved = await api('/inference/servers' + (serverSelect.value ? '/' + serverSelect.value : ''), serverSelect.value ? 'PUT' : 'POST', {
        ...connection, name: name.value.trim(),
        credentials: { ...connection.credentials, api_key: key.value },
        engine: document.getElementById('lab-engine').value,
        url: document.getElementById('lab-url').value,
        models: document.getElementById('lab-models').value.split('\n').map(value => value.trim()).filter(Boolean),
        model: document.getElementById('lab-default-model').value.trim(),
        max_concurrent: Number(document.getElementById('lab-total-limit').value),
        per_user: Number(document.getElementById('lab-user-limit').value),
      })
    } finally { key.value = ''; editor.clear() }
    await refresh(saved.id)
  }))
  document.getElementById('lab-personal-form').addEventListener('submit', run(async () => {
    await api('/me/model-settings', 'PUT', {
      server_id: personalServer.value || null,
      provider: document.getElementById('lab-personal-provider').value,
      model: document.getElementById('lab-personal-model').value.trim(),
    })
    await refresh()
  }))
  for (const action of ['status', 'login', 'logout']) {
    document.getElementById(`lab-cli-${action}`).addEventListener('click', run(async () => {
      cancelPolling()
      const generation = loginGeneration
      const provider = providerSelect.value
      const path = `/me/providers/${provider}${action === 'login' ? '/login' : ''}`
      const result = await api(path, action === 'login' ? 'POST' : action === 'logout' ? 'DELETE' : 'GET')
      if (generation !== loginGeneration) return
      output.textContent = [result.status, result.instructions].filter(Boolean).join('\n')
      if (result.status === 'pending') loginTimer = setTimeout(() => pollLogin(provider, generation, Date.now() + 600000), 1000)
    }))
  }
}
