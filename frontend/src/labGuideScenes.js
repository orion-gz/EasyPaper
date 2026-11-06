import { t } from './i18n.js'

const el = (tag, className, text = '') => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}
const clamp = value => Math.max(0, Math.min(1, value))
const typed = (text, time, start, duration = 1400) => text.slice(0, Math.floor(text.length * clamp((time - start) / duration)))
const show = (node, visible) => { node.hidden = !visible }

// These are illustrative screens, never live forms. The parent exposes a static
// description to assistive technology; no credentials or API calls are used.
export function mountLabScene(root, scene) {
  root.replaceChildren()
  root.dataset.scene = scene.kind
  const updates = []
  const field = (label, value, start, parent = root) => {
    const row = el('div', 'lab-demo-field')
    const input = el('div', 'lab-demo-input')
    row.append(el('span', 'lab-demo-label', label), input)
    parent.append(row)
    updates.push(time => {
      input.textContent = typed(value, time, start) || '\u00a0'
      input.classList.toggle('is-active', time >= start && time < start + 1400)
    })
    return row
  }
  const action = (label, start, parent = root) => {
    const button = el('div', 'lab-demo-action', label)
    parent.append(button)
    updates.push(time => {
      button.classList.toggle('is-pressed', time >= start && time < start + 650)
      button.classList.toggle('is-target', time >= start - 500 && time < start)
      button.dataset.pressed = String(time >= start)
    })
    return button
  }
  const result = (text, start, parent = root) => {
    const box = el('div', 'lab-demo-result', `✓ ${text}`)
    parent.append(box)
    updates.push(time => show(box, time >= start))
    return box
  }
  const meter = (start, duration, parent = root) => {
    const wrap = el('div', 'lab-demo-meter')
    const bar = el('div', 'lab-demo-meter-fill')
    const value = el('span', 'lab-demo-percent')
    wrap.append(bar, value)
    parent.append(wrap)
    updates.push(time => {
      const percent = Math.round(clamp((time - start) / duration) * 100)
      bar.style.width = `${percent}%`
      value.textContent = `${percent}%`
      show(wrap, time >= start)
    })
    return wrap
  }
  let duration = 9000
  if (scene.kind === 'terminal') {
    const transcript = el('div', 'lab-demo-transcript')
    root.append(transcript)
    const rows = scene.commands.map(([command, logs], index) => {
      const block = el('div', 'lab-demo-command')
      const input = el('pre', 'lab-demo-command-input')
      const output = el('pre', 'lab-demo-command-output')
      const start = index * 5000
      block.append(input, output)
      transcript.append(block)
      meter(start + 1800, 2200, block)
      updates.push(time => {
        show(block, time >= start)
        input.textContent = `$ ${typed(command, time, start, 1800)}`
        input.classList.toggle('is-active', time >= start && time < start + 1800)
        output.textContent = time < start + 1800 ? '' : (time >= start + 4000 ? logs : logs.slice(0, Math.min(logs.length - 1, 1 + Math.floor((time - start - 1800) / (2200 / logs.length))))).join('\n')
        block.dataset.phase = time < start + 1800 ? 'typing' : time < start + 4000 ? 'running' : 'complete'
      })
      return block
    })
    updates.push((time, staticView) => {
      const current = Math.min(rows.length - 1, Math.floor(time / 5000))
      // Only the current command and its predecessor occupy the terminal viewport.
      rows.forEach((row, index) => show(row, staticView || index === current))
    })
    duration = scene.commands.length * 5000
  } else if (scene.kind === 'editor') {
    root.append(el('div', 'lab-demo-address', scene.path))
    const code = el('pre', 'lab-demo-editor')
    root.append(code)
    updates.push(time => { code.textContent = typed(scene.code, time, 0, 3000) })
    action(t('settings:labSave'), 3500)
    result(t('settings:labSceneSaved'), 4300)
    duration = 5500
  } else if (scene.kind === 'network') {
    const dns = el('div', 'lab-demo-card')
    root.append(dns)
    field('DNS · A', `${scene.domain || 'lab.example.com'} → SERVER_PUBLIC_IP`, 0, dns)
    action(t('settings:labSave'), 1900, dns)
    const route = el('div', 'lab-demo-route')
    root.append(route)
    ;['HTTPS :443', 'Caddy', '127.0.0.1:8000 · EasyPaper'].forEach((text, index) => {
      const point = el('div', 'lab-demo-hop', text)
      route.append(point)
      updates.push(time => point.classList.toggle('is-connected', time >= 3000 + index * 1200))
    })
    result(t('settings:labScenePorts'), 6000)
    duration = 7500
  } else if (scene.kind === 'connection') {
    field(t('settings:labServerUrlField'), scene.url, 0)
    field(t('settings:labAccountExample'), 'alice', 1500)
    field(t('settings:labPasswordExample'), '••••••••', 3000)
    duration = 4500
  } else if (scene.kind === 'admin-login') {
    root.append(el('div', 'lab-demo-address', scene.url))
    field(t('common:login.username'), 'admin', 0)
    field(t('common:login.password'), '••••••••', 1500)
    action(t('common:login.submit'), 3200)
    result(t('settings:labAccountScene'), 4200)
    duration = 5000
  } else if (scene.kind === 'account') {
    root.append(el('div', 'lab-demo-tabs', t('settings:labAccountScene')))
    field(t('settings:labAccountCurrentPassword'), '••••••••', 0)
    field(t('settings:labAccountUsername'), 'admin', 1500)
    field(t('settings:labSceneNewPassword'), '••••••••••••', 3000)
    field(t('settings:labSceneConfirmPassword'), '••••••••••••', 4500)
    action(t('settings:labAccountSubmit'), 6200)
    result(t('settings:labAccountSaved'), 7200)
    duration = 8000
  } else if (scene.kind === 'browser') {
    const address = el('div', 'lab-demo-address')
    const login = el('div', 'lab-demo-card')
    root.append(address, login)
    updates.push(time => { address.textContent = `◉ ${typed(scene.url || 'https://lab.example.com', time, 0)}`; show(login, time >= 2500) })
    login.append(el('strong', '', 'EasyPaper'))
    field(t('common:login.username'), 'admin', 2600, login)
    field(t('common:login.password'), '••••••••', 4100, login)
    action(t('common:login.submit'), 5800, login)
    const settings = result(t('settings:labSceneOpenSettings'), 6700)
    updates.push(time => show(login, time >= 2500 && time < 6700))
    settings.append(el('div', 'lab-demo-tabs', 'EasyPaper  ›  Lab'))
    const panel = el('div', 'lab-demo-settings')
    panel.append(el('div', 'lab-demo-action is-pressed', 'Lab'))
    const config = el('div', 'lab-demo-card')
    config.append(el('strong', '', t('settings:labInferenceSettings')), el('div', 'lab-demo-input', 'Ollama'))
    panel.append(config)
    settings.append(panel)
    duration = 8000
  } else if (scene.kind === 'inference') {
    const grid = el('div', 'lab-demo-grid')
    root.append(grid)
    field(t('settings:labEngine'), 'Ollama', 0, grid)
    field(t('settings:labUrl'), scene.url || 'http://host.docker.internal:11434', 1500, grid)
    field(t('settings:labModels'), scene.model || 'qwen3:4b', 3000, grid)
    field(t('settings:labDefaultModel'), scene.model || 'qwen3:4b', 4500, grid)
    const actions = el('div', 'lab-demo-actions')
    root.append(actions)
    action(t('settings:labSave'), 6100, actions)
    action(t('settings:labCheckInference'), 7300, actions)
    meter(7800, 1500)
    result(t('settings:labSceneConnected'), 9400)
    duration = 10500
  } else if (scene.kind === 'enable') {
    root.append(el('strong', '', t('settings:labModeSettings')))
    const toggle = el('div', 'lab-demo-toggle')
    toggle.append(el('span', 'lab-demo-toggle-thumb'), el('span', '', t('settings:labEnable')))
    root.append(toggle)
    updates.push(time => { toggle.classList.toggle('is-on', time >= 1000); toggle.dataset.checked = String(time >= 1000) })
    field(t('settings:labPassword'), '••••••••', 1800)
    action(t('settings:labSave'), 3600)
    result(t('settings:labOn'), 4400)
    duration = 5500
  } else if (scene.kind === 'invite') {
    root.append(el('strong', '', t('settings:labMembers')))
    const form = el('div', 'lab-demo-card')
    root.append(form)
    field(t('settings:labUsername'), 'alice', 0, form)
    field(t('settings:labInitialPassword'), '', 1500, form)
    action(t('settings:labCreate'), 2500, form)
    updates.push(time => show(form, time < 3400))
    const credentials = result(t('settings:labTemporaryPassword'), 3400)
    credentials.append(el('code', 'lab-demo-secret', 'demo-only-A7!2'))
    result(`alice  ·  ${scene.url || 'https://lab.example.com'}`, 4500)
    duration = 6000
  } else if (scene.kind === 'login') {
    root.append(el('div', 'lab-demo-address', 'https://lab.example.com'))
    const login = el('div', 'lab-demo-card')
    root.append(login)
    field(t('common:login.username'), 'alice', 0, login)
    field(t('common:login.password'), '••••••••', 1500, login)
    action(t('common:login.submit'), 3200, login)
    const change = el('div', 'lab-demo-card')
    root.append(change)
    change.append(el('strong', '', t('settings:labSceneChangePassword')))
    const fields = el('div', 'lab-demo-grid')
    change.append(fields)
    field(t('settings:labPassword'), '••••••••', 4200, fields)
    field(t('settings:labSceneNewPassword'), '••••••••••••', 5600, fields)
    field(t('settings:labSceneConfirmPassword'), '••••••••••••', 7000, fields)
    action(t('settings:labSave'), 8800, change)
    updates.push(time => { show(login, time < 4000); show(change, time >= 4000 && time < 9700) })
    result(t('settings:labSceneSignedIn'), 9700)
    duration = 11000
  } else if (scene.kind === 'library') {
    root.append(el('div', 'lab-demo-tabs', `alice  ›  ${t('settings:labSceneLibrary')}`))
    const upload = el('div', 'lab-demo-dropzone', `＋ ${t('settings:labSceneUpload')}`)
    root.append(upload)
    const file = el('div', 'lab-demo-file', '▤  paper.pdf')
    upload.append(file)
    updates.push(time => { file.style.transform = `translateY(${(1 - clamp(time / 1800)) * -35}px)`; file.style.opacity = String(clamp(time / 1000)) })
    meter(2000, 2500, upload)
    const paper = el('div', 'lab-demo-paper', '▤  paper.pdf')
    root.append(paper)
    action(t('settings:labSceneRead'), 5400, paper)
    const reader = el('div', 'lab-demo-reader')
    reader.append(el('strong', '', 'paper.pdf'), el('div', 'lab-demo-page', 'Abstract\n━━━━━━━━━━━━\n━━━━━━━━━━\n━━━━━━━━━━━━\n━━━━━━━━'))
    root.append(reader)
    updates.push(time => { show(upload, time < 4700); show(paper, time >= 4700 && time < 6300); show(reader, time >= 6300) })
    duration = 8000
  }
  return { duration, update(time, staticView = false) { updates.forEach(update => update(time, staticView)) } }
}

export function labScenes() {
  const terminal = (title, commands, note) => ({ kind: 'terminal', title, commands, note })
  return [
    [
      terminal('SSH', [['ssh user@lab-server', ['→ lab-server']], ['git --version && docker compose version && caddy version', ['Git ✓', 'Docker Compose ✓', 'Caddy ✓']]], t('settings:labScenePrerequisites')),
      terminal('EasyPaper · Docker', [['git clone https://github.com/orion-gz/EasyPaper.git && cd EasyPaper', ['Cloning EasyPaper…', 'EasyPaper ✓']], ['mkdir -p lab-data/home && sudo chown -R 1000:1000 lab-data', ['lab-data ✓']], ['docker compose -f docker-compose.lab.yml up -d --build', ['Building frontend…', 'Installing backend…', 'Starting easypaper…', '✓ 127.0.0.1:8000']]], t('settings:labSceneInstall')),
      { kind: 'network', title: 'DNS · HTTPS', note: t('settings:labWizardHosting') },
      { kind: 'editor', title: 'Caddyfile', path: '/etc/caddy/Caddyfile', code: 'lab.example.com {\n    reverse_proxy 127.0.0.1:8000\n}', note: t('settings:labWizardProxy') },
      terminal('HTTPS', [['sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy', ['Valid configuration', '✓ Caddy']], ['curl -I https://lab.example.com', ['HTTP/2 200', '✓ HTTPS']]], t('settings:labWizardRemote')),
      { kind: 'browser', title: 'https://lab.example.com', note: t('settings:labSceneAdmin') },
    ],
    [
      terminal('Ollama', [['curl -fsSL https://ollama.com/install.sh | sh', ['Downloading Ollama…', 'Installing service…', '✓ Ollama']]], t('settings:labSceneOllama')),
      { kind: 'editor', title: 'sudo systemctl edit ollama', path: 'ollama.service.d/override.conf', code: '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"', note: t('settings:labWizardEngine') },
      terminal('qwen3:4b', [['sudo systemctl daemon-reload && sudo systemctl restart ollama', ['✓ Ollama']], ['ollama pull qwen3:4b', ['Pulling model…', 'Verifying digest…', '✓ qwen3:4b']]], t('settings:labSceneModel')),
      { kind: 'inference', title: 'EasyPaper · Lab', note: t('settings:labWizardConnect') },
    ],
    [
      { kind: 'enable', title: 'EasyPaper · Lab', note: t('settings:labWizardEnable') },
      { kind: 'invite', title: 'EasyPaper · Lab', note: t('settings:labSceneInvite') },
      { kind: 'login', title: 'https://lab.example.com', note: t('settings:labWizardLogin') },
      { kind: 'library', title: 'EasyPaper · alice', note: t('settings:labWizardSpace') },
    ],
  ]
}
