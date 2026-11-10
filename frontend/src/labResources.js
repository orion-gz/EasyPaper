import { t } from './i18n.js'

export function resourceEditor(form, api, serverId) {
  const box = document.createElement('fieldset')
  box.id = 'lab-memory-policy'
  box.className = 'lab-memory-policy'
  const title = document.createElement('legend')
  title.textContent = t('settings:labMemoryPolicy')
  const enabled = document.createElement('input')
  enabled.type = 'checkbox'
  const enableLabel = document.createElement('label')
  enableLabel.className = 'lab-memory-toggle'
  enableLabel.append(enabled, document.createTextNode(t('settings:labMemoryEnforce')))
  const fields = document.createElement('div')
  fields.className = 'lab-memory-fields'
  const grid = document.createElement('div')
  grid.className = 'lab-memory-grid'
  function number(parent, label, value, min = 1, step = '1') {
    const row = document.createElement('label')
    row.className = 'lab-memory-field'
    row.textContent = label
    const input = document.createElement('input')
    input.type = 'number'; input.min = String(min); input.step = step; input.value = String(value)
    row.append(input); parent.append(row)
    return input
  }
  const poolLabel = document.createElement('label')
  poolLabel.className = 'lab-memory-field lab-memory-pool-field'
  poolLabel.textContent = t('settings:labMemoryPool')
  const pool = document.createElement('input')
  pool.type = 'text'; pool.maxLength = 200
  poolLabel.append(pool); grid.append(poolLabel)
  const budget = number(grid, t('settings:labMemoryBudget'), 16, 0.1, '0.1')
  const maximum = number(grid, t('settings:labMemoryLoaded'), 1)
  const rows = document.createElement('div')
  rows.className = 'lab-memory-models'
  const output = document.createElement('pre')
  output.className = 'lab-auth-terminal'
  output.setAttribute('role', 'status')
  let specifications = {}
  function render(models) {
    rows.replaceChildren()
    for (const model of models) {
      const group = document.createElement('fieldset')
      group.className = 'lab-memory-model-card'
      const legend = document.createElement('legend'); legend.textContent = model; group.append(legend)
      const spec = specifications[model] || {}
      const controls = {
        parameters_billions: number(group, t('settings:labMemoryParameters'), spec.parameters_billions || 7, 0.001, '0.001'),
        weight_bits: number(group, t('settings:labMemoryBits'), spec.weight_bits || 4, 1, '0.1'),
        context_tokens: number(group, t('settings:labMemoryContext'), spec.context_tokens || 8192),
        kv_bytes_per_token: number(group, t('settings:labMemoryKv'), spec.kv_bytes_per_token || 131072),
        concurrency: number(group, t('settings:labMemoryConcurrency'), spec.concurrency || 1),
        measured_gib: number(group, t('settings:labMemoryMeasured'), spec.measured_gib || 0, 0, '0.1'),
      }
      group.dataset.model = model
      group.read = () => Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, key === 'measured_gib' && !Number(input.value) ? null : Number(input.value)]))
      const unload = document.createElement('button')
      unload.type = 'button'; unload.className = 'btn btn-secondary'; unload.textContent = t('settings:labUnload')
      unload.onclick = async () => {
        try { await api(`/lab/resources/${serverId()}/unload`, 'POST', { model }); output.textContent = t('settings:saved') }
        catch (error) { output.textContent = error.message }
      }
      group.append(unload); rows.append(group)
    }
  }
  const check = document.createElement('button')
  check.type = 'button'; check.className = 'btn btn-secondary'; check.textContent = t('settings:labMemoryPlan')
  check.onclick = async () => {
    try {
      if (!serverId()) throw new Error(t('settings:connectionSaveTheServerFirst'))
      const result = await api(`/lab/resources/${serverId()}`)
      const gib = bytes => (bytes / 2 ** 30).toFixed(2)
      const gpu = result.telemetry.available ? result.telemetry.gpus.map(g => `${g.name} (${g.id}): ${gib(g.free_bytes)} / ${gib(g.total_bytes)} GiB`).join('\n') : t('settings:labMemoryTelemetryMissing')
      const estimates = Object.entries(result.plan?.estimated_bytes || {}).map(([name, bytes]) => `${name}: ~${gib(bytes)} GiB`).join('\n')
      const plans = result.plan?.suggestions.map(names => names.join(' + ')).join('\n') || t('settings:labMemoryNoPlan')
      output.textContent = `${gpu}\n${estimates}\n${plans}`
    } catch (error) { output.textContent = error.message }
  }
  const note = document.createElement('p'); note.className = 'form-help'; note.textContent = t('settings:labMemoryNote')
  fields.append(grid, rows, check, output)
  box.append(title, enableLabel, note, fields)
  enabled.onchange = () => { fields.hidden = !enabled.checked }
  form.querySelector('.form-actions').before(box)
  const modelsInput = document.getElementById('lab-models')
  modelsInput?.addEventListener('change', () => {
    specifications = Object.fromEntries([...rows.children].map(row => [row.dataset.model, row.read()]))
    render(modelsInput.value.split('\n').map(m => m.trim()).filter(Boolean))
  })
  return {
    load(server = {}) {
      enabled.checked = server.lab_shared !== false || !!server.memory_policy
      pool.value = server.memory_policy?.gpu_pool || ''
      budget.value = server.memory_policy?.budget_gib || 16
      maximum.value = server.memory_policy?.max_loaded || 1
      specifications = server.memory_policy?.models || {}
      render(server.models || [])
      enabled.onchange(); output.textContent = ''
    },
    sync(models = []) {
      specifications = { ...specifications, ...Object.fromEntries([...rows.children].map(row => [row.dataset.model, row.read()])) }
      render(models)
    },
    read() {
      if (!enabled.checked) return null
      return { gpu_pool: pool.value.trim(), budget_gib: Number(budget.value), max_loaded: Number(maximum.value),
        models: Object.fromEntries([...rows.children].map(row => [row.dataset.model, row.read()])) }
    },
  }
}
