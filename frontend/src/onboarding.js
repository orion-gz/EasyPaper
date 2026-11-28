import { CURRENT_ONBOARDING_VERSION, ONBOARDING_VERSION_KEY, WORKSPACE_PURPOSE_SELECTED_KEY } from './documentModes.js'
import { getLocale, t } from './i18n.js'
import { desktopServerUrl, isRemoteDesktop, openSettings } from './desktopConnection.js'
import { getSystemSettingsAPI, fetchCliAvailability, getOllamaStatusAPI,
  streamInstallOllamaAPI, streamInstallClaudeCodeAPI, streamInstallCodexAPI, streamInstallAntigravityAPI,
  streamPullModelAPI, patchWorkspaceSettingsAPI } from './api.js'
import './styles/onboarding-guide.css'

const installers = { ollama: streamInstallOllamaAPI, claude_code: streamInstallClaudeCodeAPI,
  codex: streamInstallCodexAPI, antigravity: streamInstallAntigravityAPI }
const names = { ollama: 'Ollama', vllm: 'vLLM', claude_code: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }
const commands = { claude_code: 'claude auth login', codex: 'codex login', antigravity: 'agy' }
const messages = {
  location: () => t('onboarding:location'),
  local: () => t('onboarding:local'),
  localHelp: () => t('onboarding:localHelp'),
  remote: () => t('onboarding:remote'),
  remoteHelp: () => t('onboarding:remoteHelp'),
  team: () => t('onboarding:team'),
  teamHelp: () => t('onboarding:teamHelp'),
  tools: () => t('onboarding:tools'),
  installed: () => t('onboarding:installed'),
  install: () => t('onboarding:install'),
  installing: () => t('onboarding:installing'),
  start: () => t('onboarding:start'),
  gpu: () => t('onboarding:gpu'),
  endpoint: () => t('onboarding:endpoint'),
  url: () => t('onboarding:url'),
  key: () => t('onboarding:key'),
  check: () => t('onboarding:check'),
  model: () => t('onboarding:model'),
  empty: () => t('onboarding:empty'),
  download: () => t('onboarding:download'),
  sample: () => t('onboarding:sample'),
  save: () => t('onboarding:save'),
  ready: () => t('onboarding:ready'),
  open: () => t('onboarding:open'),
  login: () => t('onboarding:login'),
  working: () => t('onboarding:working'),
  teamUrl: () => t('onboarding:teamUrl'),
  invalid: () => t('onboarding:invalid'),
  localOllama: () => t('onboarding:localOllama'),
  cliHelp: () => t('onboarding:cliHelp'),
  service: () => t('onboarding:service'),
  retry: () => t('onboarding:retry'),
}
const label = key => messages[key]()

async function request(path, body, method = 'POST') {
  const response = await fetch('/api/' + path, body === undefined ? { cache: 'no-store' } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : response.statusText)
  return data
}

export function createOnboarding({ openOverlayModal, closeOverlayModal, providerConfig,
  viewerTransPicker, settingTransPicker, onWorkspaceSelected }) {
  const $ = id => document.getElementById(id)
  const modal = $('onboarding-modal'), guide = $('onboarding-guide'), purpose = $('onboarding-purpose')
  const fields = $('onboarding-fields'), feedback = $('onboarding-feedback'), action = $('onboarding-action')
  const back = $('onboarding-back-btn'), details = $('onboarding-details')
  let step = '', selectedPurpose, provider = 'ollama', remoteEngine = 'ollama'
  let sys, available = {}, remoteModels = [], server, savedId, model, verified, busy = false
  let address = '', key = '', teamUrl = '', gpuModel = '', gpuModels = [], history = []

  function close() {
    localStorage.setItem('easypaper_onboarding_seen', '1')
    localStorage.setItem(ONBOARDING_VERSION_KEY, String(CURRENT_ONBOARDING_VERSION))
    patchWorkspaceSettingsAPI({ onboarding_version: CURRENT_ONBOARDING_VERSION }).catch(console.warn)
    closeOverlayModal(modal)
  }
  function node(tag, text) {
    const el = document.createElement(tag)
    if (text) el.textContent = text
    return el
  }
  function setAction(key, callback) {
    action.hidden = !callback
    action.textContent = key ? label(key) : ''
    action.onclick = callback ? () => run(callback) : null
  }
  async function run(callback) {
    if (busy) return
    busy = true
    fields.inert = true
    action.disabled = back.disabled = true
    delete feedback.dataset.state
    feedback.setAttribute('role', 'status')
    feedback.textContent = label('working')
    try { await callback() } catch (error) {
      if (step === 'purpose') $('onboarding-purpose-error').textContent = error.message
      else {
        feedback.dataset.state = 'error'
        feedback.setAttribute('role', 'alert')
        feedback.textContent = error.message
      }
    }
    finally { busy = fields.inert = action.disabled = back.disabled = false }
  }
  function card(title, help, callback) {
    const button = node('button')
    button.type = 'button'
    button.className = 'onboarding-card'
    button.append(node('strong', title))
    if (help) button.append(node('small', help))
    button.onclick = () => run(callback)
    fields.append(button)
  }
  function input(title, type, value, change) {
    const wrapper = node('label', label(title)), el = node('input')
    el.className = 'form-input'
    el.type = type
    el.value = value
    el.oninput = () => change(el.value)
    wrapper.append(el)
    fields.append(wrapper)
    return el
  }
  let selectSeq = 0
  function select(title, values, current, change) {
    const wrapper = node('label'), labelText = node('span', title), el = node('select')
    const id = 'onboarding-select-' + (++selectSeq)
    labelText.id = id + '-label'
    wrapper.htmlFor = id
    el.id = id
    el.className = 'form-select'
    el.setAttribute('aria-labelledby', labelText.id)
    for (const [value, name] of values) el.add(new Option(name, value))
    if (values.some(([value]) => value === current)) el.value = current
    change(el.value)
    el.onchange = () => change(el.value)
    wrapper.append(labelText, el)
    fields.append(wrapper)
  }
  function go(next) {
    history.push(step)
    render(next)
  }
  function showLog(line) {
    details.hidden = false
    details.querySelector('pre').textContent = line
  }
  function stream(start) {
    return new Promise((resolve, reject) => {
      let lines = []
      start(data => {
        if (data.line) {
          lines.push(data.line)
          lines = lines.slice(-40)
          showLog(lines.join('\n'))
        }
        feedback.textContent = data.total ? Math.round(100 * (data.completed || 0) / data.total) + '%' : data.status || label('installing')
      }, resolve, reject)
    })
  }
  async function detect() {
    const [settings, cli, ollama] = await Promise.all([getSystemSettingsAPI(), fetchCliAvailability(), getOllamaStatusAPI()])
    sys = settings
    available = { ...cli, ollama: ollama.installed, running: ollama.running }
  }
  async function chooseTool(id) {
    provider = id
    server = savedId = model = null
    if (id === 'vllm') {
      const job = await request('settings/vllm')
      gpuModels = job.models
      gpuModel = job.model || gpuModels[0]
      go('gpu')
      if (['starting', 'installing', 'ready'].includes(job.status)) await watchGpu(job)
    } else if (available[id] || !installers[id]) await prepareModels()
    else go('install')
  }
  async function prepareModels() {
    if (provider === 'ollama') {
      if (!available.running) {
        go('service')
        return
      }
    }
    if (['claude_code', 'codex'].includes(provider)) {
      const auth = await request('settings/cli-login/' + provider)
      if (!auth.connected) { go('login'); return }
    }
    go('model')
  }
  async function watchGpu(job) {
    while (['installing', 'starting'].includes(job.status)) {
      feedback.textContent = label('installing')
      showLog(job.log.join('\n'))
      await new Promise(resolve => setTimeout(resolve, 1500))
      job = await request('settings/vllm')
    }
    if (job.status !== 'ready') {
      card('Ollama', label('localOllama'), () => chooseTool('ollama'))
      card(label('remote'), label('remoteHelp'), () => go('endpoint'))
      throw new Error(job.log.at(-1) || job.status)
    }
    await discover('vllm', job.url, '')
  }
  async function discover(engine, url, apiKey) {
    const target = { name: new URL(url).host, engine, url, credentials: { api_key: apiKey },
      save_credentials: false, lab_shared: false }
    const result = await request('settings/discover-models', target)
    if (!result.models.length) throw new Error(label('empty'))
    target.save_credentials = Boolean(apiKey && result.credential_storage)
    server = target
    savedId = null
    provider = engine === 'vllm' ? 'openai' : 'ollama'
    remoteModels = result.models
    model = remoteModels.includes(model) ? model : remoteModels[0]
    go('model')
  }
  async function preview() {
    const result = await request('settings/translation-preview', {
      provider, model, server, target_lang: getLocale(),
    })
    verified = result.translation
    render('model', { preserveActionFocus: true })
  }
  async function save() {
    if (server && !savedId) {
      const result = await request('inference/servers', { ...server, models: remoteModels, model })
      savedId = result.id
    }
    await request('settings/translation-model', { provider, model, server_id: savedId || '' }, 'PUT')
    viewerTransPicker.setValue(provider, model)
    settingTransPicker.setValue(provider, model)
    key = ''
    server = null
    go('ready')
  }
  function render(next, { preserveActionFocus = false } = {}) {
    step = next
    purpose.classList.toggle('hidden', next !== 'purpose')
    guide.classList.toggle('hidden', next === 'purpose')
    const stepIndex = next === 'purpose' ? 1 : ['location', 'team'].includes(next) ? 2 : ['model', 'ready'].includes(next) ? 4 : 3
    const footer = modal.querySelector('.onboarding-footer')
    if (footer) footer.hidden = next === 'ready'
    const stepper = $('onboarding-stepper')
    if (stepper) {
      for (const item of stepper.querySelectorAll('.onboarding-step')) {
        const num = Number(item.dataset.step)
        const isCompleted = num < stepIndex || (next === 'ready' && num === 4)
        const isActive = num === stepIndex && !isCompleted
        item.classList.toggle('is-completed', isCompleted)
        item.classList.toggle('is-active', isActive)
        if (isActive) item.setAttribute('aria-current', 'step')
        else item.removeAttribute('aria-current')
        const statusEl = item.querySelector('.onboarding-step-status')
        if (statusEl) statusEl.textContent = isCompleted ? ' (' + t('onboarding:stepCompleted') + ')' : ''
        const indicator = item.querySelector('.onboarding-step-indicator')
        if (indicator) {
          indicator.innerHTML = isCompleted
            ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
            : String(num)
        }
      }
    }
    if (next === 'purpose') {
      $('onboarding-purpose-error').textContent = ''
      purpose.querySelector('h3').focus()
      return
    }
    fields.replaceChildren()
    delete feedback.dataset.state
    feedback.setAttribute('role', 'status')
    feedback.textContent = ''
    details.hidden = true
    setAction('', null)
    back.hidden = !history.length || next === 'ready'
    const titles = { login: 'login', tools: 'tools', install: 'install', gpu: 'gpu', service: 'service', endpoint: 'endpoint',
      location: 'location', team: 'team', model: 'model', ready: 'ready' }
    const heading = $('onboarding-question')
    heading.textContent = next === 'install' ? names[provider] : label(titles[next])
    requestAnimationFrame(() => (preserveActionFocus && !action.hidden ? action : heading).focus())
    if (next === 'location') {
      for (const id of ['local', 'remote', 'team']) card(label(id), label(id + 'Help'), async () => {
        server = savedId = model = verified = null
        if (id === 'local') {
          sys = await getSystemSettingsAPI()
          if (sys.read_only || sys.assigned_translation_model) { model = sys.trans_model; go('ready'); return }
          await detect(); go('tools')
        }
        else if (id === 'remote') go('endpoint')
        else go('team')
      })
    } else if (next === 'tools') {
      for (const [id, name] of Object.entries(names)) card(name, available[id] ? label('installed') :
        label(id === 'ollama' ? 'localOllama' : id === 'vllm' ? 'gpu' : 'cliHelp'), () => chooseTool(id))
      for (const cfg of providerConfig.filter(p => sys.api_keys?.[p.id]?.configured)) card(cfg.label || cfg.id, '', () => chooseTool(cfg.id))
    } else if (next === 'install') {
      setAction('install', async () => { await stream(installers[provider]); await detect(); await prepareModels() })
    } else if (next === 'login') {
      fields.append(node('code', commands[provider]))
      setAction('retry', async () => {
        const auth = await request('settings/cli-login/' + provider)
        if (auth.connected) go('model')
        else feedback.textContent = label('login')
      })
    } else if (next === 'service') {
      setAction('retry', async () => { await detect(); history.pop(); await prepareModels() })
    } else if (next === 'gpu') {
      select('vLLM', gpuModels.map(m => [m, m]), gpuModel, value => { gpuModel = value })
      setAction('start', async () => {
        render('gpu')
        await watchGpu(await request('settings/vllm', { model: gpuModel }))
      })
    } else if (next === 'endpoint') {
      select(label('tools'), [['ollama', 'Ollama'], ['vllm', 'vLLM']], remoteEngine, value => { remoteEngine = value })
      const addressField = input('url', 'url', address, value => { address = value })
      addressField.placeholder = remoteEngine === 'vllm' ? 'https://models.example.org/v1' : 'https://models.example.org'
      input('key', 'password', key, value => { key = value })
      setAction('check', () => discover(remoteEngine, address.trim(), key))
    } else if (next === 'team') {
      if (window.__TAURI_INTERNALS__) setAction('team', () => openSettings({ remoteSetup: true }))
      else {
        fields.append(node('p', label('teamUrl')))
        input('url', 'url', teamUrl, value => { teamUrl = value })
        setAction('team', () => {
          const url = new URL(teamUrl)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(label('invalid'))
          location.assign(url.href)
        })
      }
    } else if (next === 'model') {
      const cfg = providerConfig.find(p => p.id === provider)
      const options = server ? remoteModels : provider === 'ollama' ? sys.available_models || [] : cfg?.models || []
      if (server) fields.append(node('small', server.url))
      if (server?.credentials.api_key && !server.save_credentials) fields.append(node('p', t('onboarding:sessionKey')))
      fields.append(node('blockquote', getLocale() === 'en' ? t('onboarding:sampleKo') : t('onboarding:sampleEn')))
      if (provider === 'antigravity') fields.append(node('p', label('login') + ' ' + commands[provider]))
      select(names[server?.engine || provider] || provider, options.map(m => typeof m === 'string' ? [m, m] : [m.value, m.label]), model, value => {
        if (model !== value) verified = null
        model = value
        if (model) setAction(verified ? 'save' : 'sample', verified ? save : preview)
        feedback.textContent = verified || ''
      })
      if (!options.length) feedback.textContent = label('empty')
      if (!server && provider === 'ollama') {
        let download
        select(label('download'), [['llama3.1:8b', 'Llama 3.1 8B · ≈4.9 GB'], ['gemma4:e4b', 'Gemma 4 E4B'], ['qwen3.5:9b', 'Qwen 3.5 9B'],
          ['gemma4:12b', 'Gemma 4 12B'], ['qwen3.6:27b', 'Qwen 3.6 27B'], ['mistral-small3.2:24b', 'Mistral Small 3.2 24B'],
          ['phi4-reasoning:14b', 'Phi-4 Reasoning 14B'], ['deepseek-r1:8b', 'DeepSeek R1 8B']], '', value => { download = value })
        const downloadButton = node('button', label('download'))
        downloadButton.type = 'button'
        downloadButton.className = 'btn btn-secondary'
        fields.append(downloadButton)
        downloadButton.onclick = () => run(async () => {
          await stream((progress, done, fail) => streamPullModelAPI(download, progress, done, fail))
          sys = await getSystemSettingsAPI()
          model = download
          verified = null
          render('model')
        })
      }
    } else if (next === 'ready') {
      fields.append(node('p', model || ''))
      setAction('open', () => { close(); $('file-input').click() })
    }
  }
  back.onclick = () => { verified = null; render(history.pop() || 'location') }
  $('onboarding-close-btn').onclick = $('onboarding-skip-btn').onclick = close
  const purposeNext = $('onboarding-purpose-next-btn')
  const purposeRadios = Array.from(purpose.querySelectorAll('[data-purpose-mode]'))
  function selectPurpose(button, shouldFocus = false) {
    if (!button) return
    selectedPurpose = button.dataset.purposeMode
    $('onboarding-purpose-error').textContent = ''
    for (const item of purposeRadios) {
      const checked = item === button
      item.setAttribute('aria-checked', String(checked))
      item.tabIndex = checked ? 0 : -1
    }
    purposeNext.disabled = false
    if (shouldFocus) button.focus()
  }
  for (const button of purposeRadios) {
    button.onclick = () => selectPurpose(button)
  }
  const purposeGroup = purpose.querySelector('[role="radiogroup"]')
  if (purposeGroup) {
    purposeGroup.addEventListener('keydown', event => {
      const currentIdx = Math.max(0, purposeRadios.indexOf(document.activeElement))
      let nextIdx = -1
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIdx = (currentIdx + 1) % purposeRadios.length
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + purposeRadios.length) % purposeRadios.length
      else if (event.key === 'Home') nextIdx = 0
      else if (event.key === 'End') nextIdx = purposeRadios.length - 1
      if (nextIdx >= 0) {
        event.preventDefault()
        selectPurpose(purposeRadios[nextIdx], true)
      }
    })
  }
  purposeNext.onclick = () => run(async () => {
    await onWorkspaceSelected(selectedPurpose)
    localStorage.setItem(WORKSPACE_PURPOSE_SELECTED_KEY, '1')
    go('location')
  })
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !busy && !modal.querySelector('.custom-select-picker.open, .provider-picker.open')) {
      event.preventDefault()
      close()
    }
  })
  document.addEventListener('easypaper:locale-changed', () => {
    if (step && !busy) {
      verified = null
      render(step)
    }
  })
  return { async maybeShowOnboarding({ restart = false } = {}) {
    openOverlayModal(modal)
    if (busy) return
    server = savedId = verified = null
    key = ''
    const hasSelectedPurpose = Boolean(localStorage.getItem(WORKSPACE_PURPOSE_SELECTED_KEY))
    history = !restart && hasSelectedPurpose ? ['purpose'] : []
    const initial = !restart && hasSelectedPurpose ? 'location' : 'purpose'
    render(initial)
    if (isRemoteDesktop()) {
      render('ready')
      await run(async () => {
        sys = await getSystemSettingsAPI()
        model = new URL(desktopServerUrl() || location.href).host + ' · ' + sys.trans_model
        render('ready')
      })
    }
  } }
}
