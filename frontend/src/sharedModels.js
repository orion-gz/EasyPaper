import { t } from './i18n.js'

// Server tasks outlive this view; polling is only a read-only observer.
export function sharedModelManager({ api, container, report, changed }) {
  let serverId = '', generation = 0, pollSequence = 0, timer, catalog = [], lastRender = ''
  const heading = document.createElement('h4')
  heading.textContent = t('settings:sharedModelsTitle')
  const notice = document.createElement('p')
  notice.className = 'form-help'
  const select = document.createElement('select')
  select.className = 'form-select'
  select.id = 'lab-model-recommendation'
  select.setAttribute('aria-label', t('settings:sharedModelsRecommend'))
  const details = document.createElement('p')
  details.className = 'form-help'
  const input = document.createElement('input')
  input.id = 'lab-model-id'
  input.placeholder = t('settings:sharedModelsId')
  input.setAttribute('aria-label', input.placeholder)
  input.maxLength = 200
  const add = document.createElement('button')
  add.type = 'button'; add.className = 'btn btn-secondary'
  add.textContent = t('settings:sharedModelsAdd')
  add.disabled = true; input.disabled = true; select.disabled = true
  const list = document.createElement('div')
  list.id = 'lab-shared-model-list'
  const actions = document.createElement('div')
  actions.className = 'shared-model-add'
  actions.append(select, input, add)
  container.replaceChildren(heading, notice, actions, details, list)
  const root = id => `/inference/servers/${encodeURIComponent(id)}/shared-models`
  const bytes = value => value == null ? '—' : `${(value / 1024 ** 3).toFixed(2)} GiB`
  select.onchange = () => {
    input.value = select.value
    const model = catalog.find(m => m.model_id === select.value)
    details.textContent = model ? `${model.model_id} · ${model.quantization} · ${t('settings:sharedModelsVram', { size: model.estimated_vram_gb })}` : ''
  }
  input.addEventListener('input', () => { select.value = ''; details.textContent = '' })
  async function perform(action) {
    add.disabled = true
    try { await action(); await changed(); await poll(generation) } catch (error) { report(error) }
    finally { add.disabled = !serverId }
  }
  add.onclick = () => {
    const id = serverId, value = input.value.trim()
    if (!id || !value) return
    return perform(async () => { await api(root(id), 'POST', { model_id: value }); input.value = ''; select.value = '' })
  }
  function button(row, title, action) {
    const control = document.createElement('button')
    control.type = 'button'; control.className = 'btn btn-secondary'
    control.textContent = title
    control.dataset.modelAction = `${row.dataset.modelId}:${title}`
    control.onclick = async () => {
      control.disabled = true
      try { await perform(action) } finally { control.disabled = false }
    }
    row.append(control)
  }
  function render(models, id) {
    const serialized = JSON.stringify(models)
    if (serialized === lastRender) return
    lastRender = serialized
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.modelAction : null
    const states = {
      Pending: t('settings:sharedModelsPending'), Downloading: t('settings:sharedModelsDownloading'),
      Verifying: t('settings:sharedModelsVerifying'), Completed: t('settings:sharedModelsCompleted'),
      Failed: t('settings:sharedModelsFailed'), Cancelled: t('settings:sharedModelsCancelled'),
    }
    list.replaceChildren()
    if (!models.length) list.textContent = t('settings:sharedModelsEmpty')
    for (const model of models) {
      const row = document.createElement('article')
      row.className = 'shared-model-row'
      row.dataset.modelId = model.id
      const title = document.createElement('strong')
      title.textContent = `${model.name ? model.name + ' (' + model.model_id + ')' : model.model_id} · ${model.engine}`
      const state = document.createElement('p')
      state.textContent = `${states[model.status] || model.status} · ${model.parameters || '—'} · ${bytes(model.completed)} / ${bytes(model.total)}${model.speed ? ` · ${bytes(model.speed)}/s` : ''}`
      const available = document.createElement('p')
      available.className = 'form-help'
      available.textContent = [model.enabled ? t('settings:sharedModelsEnabled') : t('settings:sharedModelsDisabled'),
        model.available == null ? t('settings:sharedModelsUnknown') : model.available ? t('settings:sharedModelsAvailable') : t('settings:sharedModelsNotServing'),
        model.legacy && !model.verified ? t('settings:sharedModelsLegacy') : ''].filter(Boolean).join(' · ')
      row.append(title, state, available)
      const active = ['Pending', 'Downloading', 'Verifying'].includes(model.status)
      if (active) {
        const progress = document.createElement('progress')
        progress.max = 100
        if (model.percent != null) progress.value = model.percent
        progress.setAttribute('aria-label', `${model.model_id} ${model.percent ?? ''}%`)
        const value = document.createElement('span')
        value.textContent = model.percent == null ? '—' : `${model.percent}%`
        row.append(progress, value)
        button(row, t('settings:sharedModelsCancel'), () => api(`${root(id)}/${model.id}`, 'PATCH', { action: 'cancel' }))
      } else {
        if (model.status === 'Completed') {
          button(row, t(model.enabled ? 'settings:labDisable' : 'settings:labEnable'), () => api(`${root(id)}/${model.id}`, 'PATCH', { action: model.enabled ? 'disable' : 'enable' }))
        }
        if (['Failed', 'Cancelled'].includes(model.status) || (model.legacy && !model.verified)) {
          button(row, t('settings:sharedModelsRetry'), () => api(`${root(id)}/${model.id}`, 'PATCH', { action: 'retry' }))
        }
        button(row, t('settings:sharedModelsRemove'), () => api(`${root(id)}/${model.id}`, 'DELETE'))
      }
      if (model.error) {
        const error = document.createElement('p')
        error.className = 'error-message'; error.textContent = model.error
        row.append(error)
      }
      list.append(row)
    }
    if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.modelAction === focused)?.focus({ preventScroll: true })
  }
  async function poll(version) {
    clearTimeout(timer)
    const id = serverId
    const sequence = ++pollSequence
    if (!id || version !== generation) return
    try {
      const result = await api(root(id))
      if (version !== generation || sequence !== pollSequence) return
      render(result.models, id)
      await changed()
    } catch (error) { if (version === generation) report(error) }
    if (version === generation && sequence === pollSequence) timer = setTimeout(() => poll(version), 2000)
  }
  return {
    async load(server) {
      const version = ++generation
      clearTimeout(timer)
      serverId = server?.id || ''
      add.disabled = !serverId; input.disabled = !serverId; select.disabled = !serverId
      input.value = ''; details.textContent = ''; list.replaceChildren(); lastRender = ''
      select.replaceChildren(new Option(t('settings:sharedModelsRecommend'), ''))
      notice.textContent = serverId ? t('settings:sharedModelsRetained') : t('settings:connectionSaveTheServerFirst')
      if (!serverId) return
      void poll(version)
      try {
        const result = await api(`/inference/servers/${serverId}/model-catalog`)
        if (version !== generation) return
        catalog = result.models
        for (const model of catalog) select.add(new Option(`${model.name} · ${model.parameters} · ${model.provider} · ${model.engine}`, model.model_id))
        if (result.notice) notice.textContent += ` ${result.notice}`
      } catch (error) { if (version === generation) report(error) }
    },
    stop() { generation++; clearTimeout(timer) },
  }
}
