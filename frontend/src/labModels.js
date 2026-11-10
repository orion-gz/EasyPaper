import { t, loadNamespaces } from './i18n.js'

async function request(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : t('settings:labFailed'))
  return result
}

export async function initializeLabModels(cliProviders) {
  await loadNamespaces(['settings'])
  const section = document.createElement('section')
  section.id = 'lab-model-settings'
  section.hidden = true
  section.className = 'modal-form'
  const heading = document.createElement('h3')
  heading.textContent = t('settings:labModelSelection')
  const select = document.createElement('select')
  select.id = 'lab-model-selection'
  select.className = 'form-select'
  select.setAttribute('aria-label', heading.textContent)
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  section.append(heading, select, status)
  document.getElementById('tab-model').prepend(section)
  document.getElementById('setting-default-ai-provider').parentElement.parentElement.dataset.personalModels = ''
  let catalog = { enabled: false, models: [] }
  let preference = {}
  let events
  let generation = 0
  const cards = []
  const valueOf = item => JSON.stringify([item.provider, item.server_id || null, item.model])
  function render() {
    const states = { unloaded: t('settings:labState_unloaded'), loading: t('settings:labState_loading'), idle: t('settings:labState_idle'), inferencing: t('settings:labState_inferencing'), error: t('settings:labState_error') }
    document.body.classList.toggle('lab-models-active', catalog.enabled)
    section.hidden = !catalog.enabled
    select.replaceChildren(new Option(t('settings:labChooseModel'), ''))
    const cli = document.createElement('optgroup')
    cli.label = t('settings:labCliProviders')
    for (const provider of cliProviders) {
      for (const model of provider.models) {
        cli.append(new Option(`${provider.label} · ${model.label}`, valueOf({ provider: provider.id, model: model.value })))
      }
    }
    select.append(cli)
    const shared = document.createElement('optgroup')
    shared.label = t('settings:labSharedModels')
    for (const model of catalog.models) {
      const activity = t('settings:labModelActivity', { active: model.active_requests, queued: model.queued_requests })
      const memory = model.vram_bytes == null ? '' : ` · ${(model.vram_bytes / 2 ** 30).toFixed(2)} GiB`
      const option = new Option(`${model.name} · ${model.model} — ${states[model.state]} · ${activity}${memory}`, valueOf(model))
      option.disabled = !model.available
      option.title = model.detail || ''
      if (!model.available && model.detail) option.textContent += ` — ${model.detail}`
      shared.append(option)
    }
    select.append(shared)
    select.value = valueOf(preference)
    window.dispatchEvent(new CustomEvent('lab-model-catalog', { detail: { ...catalog, preference, cliProviders } }))
    select.dispatchEvent(new Event('optionschange'))
  }
  select.addEventListener('change', async () => {
    if (!select.value) return
    const [provider, server_id, model] = JSON.parse(select.value)
    try {
      preference = await request('/me/model-settings', 'PUT', { provider, server_id, model })
      render()
      status.textContent = t('settings:saved')
      if (cliProviders.some(item => item.id === provider)) {
        const auth = await request(`/me/providers/${provider}`)
        if (auth.status !== 'connected') status.textContent = t('settings:labLoginRequired')
      }
    } catch (error) { status.textContent = error.message; render() }
  })
  for (const provider of cliProviders) {
    const card = document.createElement('div')
    const title = document.createElement('h4')
    title.textContent = provider.label
    const output = document.createElement('pre')
    output.className = 'lab-auth-terminal'
    output.setAttribute('role', 'status')
    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.maxLength = 4095
    input.setAttribute('aria-label', t('settings:labAuthInput'))
    input.hidden = true
    let timer
    let serial = 0
    const stop = () => { serial++; clearTimeout(timer); output.textContent = ''; input.value = ''; input.hidden = true }
    cards.push(stop)
    async function show(result, current) {
      if (current !== serial) return
      output.textContent = [result.status, result.instructions].filter(Boolean).join('\n')
      input.hidden = result.status !== 'pending'
      if (result.status === 'pending') timer = setTimeout(async () => {
        try { await show(await request(`/me/providers/${provider.id}`), current) }
        catch (error) { if (current === serial) output.textContent = error.message }
      }, 1500)
    }
    card.append(title)
    for (const [action, key] of [['status', 'labCliStatus'], ['login', 'labCliLogin'], ['logout', 'labCliLogout']]) {
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'btn btn-secondary'; button.textContent = t(`settings:${key}`)
      button.onclick = async () => {
        stop()
        const current = serial
        try { await show(await request(`/me/providers/${provider.id}${action === 'login' ? '/login' : ''}`, action === 'login' ? 'POST' : action === 'logout' ? 'DELETE' : 'GET'), current) }
        catch (error) { if (current === serial) output.textContent = error.message }
      }
      card.append(button)
    }
    input.addEventListener('keydown', async event => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      const text = input.value + '\n'
      input.value = ''
      try { await request(`/me/providers/${provider.id}/input`, 'POST', { text }) }
      catch (error) { output.textContent = error.message }
    })
    card.append(output, input)
    section.append(card)
  }
  async function refresh() {
    const current = ++generation
    events?.close()
    try {
      const profile = await request('/auth/me')
      if (current !== generation) return
      catalog.enabled = !!profile.lab_mode
      render()
      if (!catalog.enabled) { cards.forEach(stop => stop()); return }
      const [models, selected] = await Promise.all([request('/lab/models'), request('/me/model-settings')])
      if (current !== generation) return
      if (typeof models.enabled !== 'boolean' || !Array.isArray(models.models)) throw new Error(t('settings:labStatusReconnecting'))
      catalog = models; preference = selected; render()
      events = new EventSource('/api/lab/models/events')
      events.onmessage = event => {
        if (current !== generation) return
        const update = JSON.parse(event.data)
        if (typeof update.enabled !== 'boolean' || !Array.isArray(update.models)) return
        catalog = update; render()
        if (!catalog.enabled) { events.close(); cards.forEach(stop => stop()) }
      }
      events.onerror = () => {
        status.textContent = t('settings:labStatusReconnecting')
        catalog.models = catalog.models.map(model => ({ ...model, available: false, detail: status.textContent }))
        render()
      }
    } catch (error) { status.textContent = error.message }
  }
  document.getElementById('settings-nav-model').addEventListener('click', refresh)
  window.addEventListener('lab-mode-changed', refresh)
  window.addEventListener('lab-account-cleared', () => {
    generation++; events?.close(); cards.forEach(stop => stop()); preference = {}; catalog = { enabled: false, models: [] }; render()
  })
  window.addEventListener('pagehide', () => { generation++; events?.close(); cards.forEach(stop => stop()) })
  refresh()
}
