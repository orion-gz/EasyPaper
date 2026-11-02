import { t } from './i18n.js'

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : t('settings:labFailed'))
  return result
}

export function initializeLabMode() {
  const status = document.getElementById('lab-status')
  const members = document.getElementById('lab-members')
  const report = error => { status.textContent = error.message }
  const run = action => async event => {
    event?.preventDefault()
    try { await action() } catch (error) { report(error) }
  }
  async function refresh() {
    const profile = await api('/auth/me')
    document.getElementById('lab-admin').hidden = profile.role !== 'master'
    status.textContent = `${profile.username} · ${(profile.lab_mode ? t('settings:labOn') : t('settings:labOff'))}`
    document.getElementById('lab-enabled').checked = profile.lab_mode
    const common = await api('/lab/inference')
    const personal = await api('/me/model-settings')
    document.getElementById('lab-personal-provider').value = personal.provider || common.engine
    document.getElementById('lab-personal-model').value = personal.model || common.model
    if (profile.role !== 'master') return
    document.getElementById('lab-engine').value = common.engine
    document.getElementById('lab-url').value = common.url
    document.getElementById('lab-models').value = common.models.join('\n')
    document.getElementById('lab-default-model').value = common.model
    document.getElementById('lab-total-limit').value = common.max_concurrent || (common.engine === 'vllm' ? 8 : 2)
    document.getElementById('lab-user-limit').value = common.per_user || 1
    members.replaceChildren()
    for (const user of await api('/lab/users')) {
      const row = document.createElement('div')
      const name = document.createElement('span')
      name.textContent = `${user.username} · ${user.role} `
      row.append(name)
      if (user.role === 'member') {
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.textContent = (user.active ? t('settings:labDisable') : t('settings:labEnable'))
        toggle.onclick = run(async () => { await api(`/lab/users/${user.id}`, 'PATCH', { active: !user.active }); await refresh() })
        const reset = document.createElement('button')
        reset.type = 'button'
        reset.textContent = t('settings:labReset')
        reset.onclick = run(async () => {
          const result = await api(`/lab/users/${user.id}/reset-password`, 'POST')
          status.textContent = `${t('settings:labTemporaryPassword')}: ${result.temporary_password}`
        })
        row.append(toggle, reset)
      }
      members.append(row)
    }
  }
  document.getElementById('settings-nav-lab').addEventListener('click', run(refresh))
  document.getElementById('lab-mode-form').addEventListener('submit', run(async () => {
    const password = document.getElementById('lab-password')
    try { await api('/lab/settings', 'PUT', { enabled: document.getElementById('lab-enabled').checked, password: password.value }) }
    finally { password.value = '' }
    await refresh()
  }))
  document.getElementById('lab-member-form').addEventListener('submit', run(async () => {
    const input = document.getElementById('lab-username')
    const result = await api('/lab/users', 'POST', { username: input.value.trim() })
    input.value = ''
    await refresh()
    status.textContent = `${result.username} — ${t('settings:labTemporaryPassword')}: ${result.temporary_password}`
  }))
  document.getElementById('lab-check-inference').addEventListener('click', run(async () => {
    const result = await api('/lab/inference/check', 'POST')
    status.textContent = result.models.join(', ')
  }))
  document.getElementById('lab-inference-form').addEventListener('submit', run(async () => {
    const key = document.getElementById('lab-api-key')
    try {
      await api('/lab/inference', 'PUT', {
        engine: document.getElementById('lab-engine').value,
        url: document.getElementById('lab-url').value,
        models: document.getElementById('lab-models').value.split('\n').map(value => value.trim()).filter(Boolean),
        model: document.getElementById('lab-default-model').value.trim(), api_key: key.value,
        max_concurrent: Number(document.getElementById('lab-total-limit').value),
        per_user: Number(document.getElementById('lab-user-limit').value),
      })
    } finally { key.value = '' }
    await refresh()
  }))
  document.getElementById('lab-personal-form').addEventListener('submit', run(async () => {
    await api('/me/model-settings', 'PUT', {
      provider: document.getElementById('lab-personal-provider').value,
      model: document.getElementById('lab-personal-model').value.trim(),
    })
    await refresh()
  }))
  for (const action of ['status', 'login', 'logout']) {
    document.getElementById(`lab-cli-${action}`).addEventListener('click', run(async () => {
      const provider = document.getElementById('lab-personal-provider').value
      const path = `/me/providers/${provider}${action === 'login' ? '/login' : ''}`
      const result = await api(path, action === 'login' ? 'POST' : action === 'logout' ? 'DELETE' : 'GET')
      document.getElementById('lab-cli-output').textContent = [result.status, result.instructions].filter(Boolean).join('\n')
    }))
  }
}
