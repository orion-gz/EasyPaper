import { mountLabScene } from './labGuideScenes.js'
import { t } from './i18n.js'
import { icon } from './icons.js'
import { defaultGuideParameters, validGuideParameters, installationScenes, connectionScenes } from './labGuideFlow.js'

const labels = () => ({
  labEngineInstallNote: t('settings:labEngineInstallNote'),
  labEngineBindDocker: t('settings:labEngineBindDocker'),
  labEngineBindSystemd: t('settings:labEngineBindSystemd'),
  labEngineStartNote: t('settings:labEngineStartNote'),
  labEnginePullNote: t('settings:labEnginePullNote'),
  labEngineModelField: t('settings:labEngineModelField'),
  labEngineConfigureNote: t('settings:labEngineConfigureNote'),
  labAdminLoginNote: t('settings:labAdminLoginNote'),
  labAccountScene: t('settings:labAccountScene'),
  labAccountNote: t('settings:labAccountNote'),
  labAccountCurrentPassword: t('settings:labAccountCurrentPassword'),
  labAccountUsername: t('settings:labAccountUsername'),
  labAccountSubmit: t('settings:labAccountSubmit'),
  labAccountSaved: t('settings:labAccountSaved'),
  labInviteSsh: t('settings:labInviteSsh'),
  labInviteHttps: t('settings:labInviteHttps'),

  labInstallGuide: t('settings:labInstallGuide'),
  labConnectionGuide: t('settings:labConnectionGuide'),
  labInstallFirst: t('settings:labInstallFirst'),
  labInstallStep: t('settings:labInstallStep'),
  labMethodStep: t('settings:labMethodStep'),
  labAccessStep: t('settings:labAccessStep'),
  labInstallIntro: t('settings:labInstallIntro'),
  labMethodIntro: t('settings:labMethodIntro'),
  labAccessIntro: t('settings:labAccessIntro'),
  labSshChoice: t('settings:labSshChoice'),
  labHttpsChoice: t('settings:labHttpsChoice'),
  labHostField: t('settings:labHostField'),
  labUserField: t('settings:labUserField'),
  labPortField: t('settings:labPortField'),
  labLocalPortField: t('settings:labLocalPortField'),
  labDomainField: t('settings:labDomainField'),
  labCopyCommand: t('settings:labCopyCommand'),
  labCopiedCommand: t('settings:labCopiedCommand'),
  labCopyFailed: t('settings:labCopyFailed'),
  labInvalidParameters: t('settings:labInvalidParameters'),
  labCloneNote: t('settings:labCloneNote'),
  labToolsNote: t('settings:labToolsNote'),
  labDockerData: t('settings:labDockerData'),
  labDockerRun: t('settings:labDockerRun'),
  labSystemdRun: t('settings:labSystemdRun'),
  labSshNote: t('settings:labSshNote'),
  labAdminNote: t('settings:labAdminNote'),
  labDnsNote: t('settings:labDnsNote'),
  labCaddyNote: t('settings:labCaddyNote'),
  labProxyNote: t('settings:labProxyNote'),
  labVerifyNote: t('settings:labVerifyNote'),
  labConnectIntro: t('settings:labConnectIntro'),
  labConnectNote: t('settings:labConnectNote'),
  labServerUrlField: t('settings:labServerUrlField'),
  labAccountExample: t('settings:labAccountExample'),
  labPasswordExample: t('settings:labPasswordExample'),
  labEngineSetupNote: t('settings:labEngineSetupNote'),

  labSceneTools: t('settings:labSceneTools'),
  labScenePrevious: t('settings:labScenePrevious'),
  labWizardServer: t('settings:labWizardServer'),
  labWizardEngine: t('settings:labWizardEngine'),
  labWizardMembers: t('settings:labWizardMembers'),
  labWizardConnect: t('settings:labWizardConnect'),
  labWizardEnable: t('settings:labWizardEnable'),
  labWizardInvite: t('settings:labWizardInvite'),
  labWizardLogin: t('settings:labWizardLogin'),
  labWizardSpace: t('settings:labWizardSpace'),
  labWizardDemo: t('settings:labWizardDemo'),
  labWizardPause: t('settings:labWizardPause'),
  labWizardPlay: t('settings:labWizardPlay'),
  labWizardReplay: t('settings:labWizardReplay'),
  labWizardFrame: t('settings:labWizardFrame'),
  labWizardPrevious: t('settings:labWizardPrevious'),
  labWizardNext: t('settings:labWizardNext'),
  labWizardDone: t('settings:labWizardDone'),
  labWizardDetails: t('settings:labWizardDetails'),
  labDeployChoice: t('settings:labDeployChoice'),
  labSystemdHelp: t('settings:labSystemdHelp'),
  labReadyData: t('settings:labReadyData'),
  labReadyNetwork: t('settings:labReadyNetwork'),
  labReadyAccount: t('settings:labReadyAccount'),
  labChecklistProgress: t('settings:labChecklistProgress'),
  labMemberPath: t('settings:labMemberPath'),
  labSharedSpace: t('settings:labSharedSpace'),
  labCliSpace: t('settings:labCliSpace'),
  labPreviewName: t('settings:labPreviewName'),
  labPreviewSpace: t('settings:labPreviewSpace'),
  labPreviewInvalid: t('settings:labPreviewInvalid'),
  labCliReady: t('settings:labCliReady'),
  labCliNext: t('settings:labCliNext'),
  labCliWait: t('settings:labCliWait'),

  'labGuideTitle': t('settings:labGuideTitle'),
  'labAdvanced': t('settings:labAdvanced'),
  'labIntro': t('settings:labIntro'),
  'labGuideServer': t('settings:labGuideServer'),
  'labGuideEngine': t('settings:labGuideEngine'),
  'labGuideMembers': t('settings:labGuideMembers'),
  'labGuideServerText': t('settings:labGuideServerText'),
  'labGuideOllama': t('settings:labGuideOllama'),
  'labGuideVllm': t('settings:labGuideVllm'),
  'labGuideModels': t('settings:labGuideModels'),
  'labGuideNetwork': t('settings:labGuideNetwork'),
  'labGuideMembersText': t('settings:labGuideMembersText'),
  'labGuideCli': t('settings:labGuideCli'),
  'labCloseGuide': t('settings:labCloseGuide'),
  'labHelp_enabled': t('settings:labHelp_enabled'),
  'labHelp_password': t('settings:labHelp_password'),
  'labHelp_engine': t('settings:labHelp_engine'),
  'labHelp_url': t('settings:labHelp_url'),
  'labHelp_models': t('settings:labHelp_models'),
  'labHelp_default-model': t('settings:labHelp_default-model'),
  'labHelp_total-limit': t('settings:labHelp_total-limit'),
  'labHelp_user-limit': t('settings:labHelp_user-limit'),
  'labHelp_api-key': t('settings:labHelp_api-key'),
  'labHelp_username': t('settings:labHelp_username'),
  'labHelp_member-password': t('settings:labHelp_member-password'),
  'labHelp_personal-provider': t('settings:labHelp_personal-provider'),
  'labHelp_personal-model': t('settings:labHelp_personal-model'),
})

export function initializeLabGuide() {
  const panel = document.getElementById('tab-lab')
  const node = (tag, key) => {
    const element = document.createElement(tag)
    if (key) {
      element.dataset.i18n = `settings:${key}`
      element.textContent = labels()[key] || t(`settings:${key}`)
    }
    return element
  }
  const intro = node('p', 'labIntro')
  const open = node('button', 'labInstallGuide')
  open.type = 'button'
  open.className = 'btn btn-secondary'
  const introduction = node('div')
  introduction.className = 'lab-introduction'
  const connect = node('button', 'labConnectionGuide')
  connect.type = 'button'
  connect.className = 'btn btn-secondary'
  connect.disabled = true
  const unlockHint = node('p', 'labInstallFirst')
  unlockHint.id = 'lab-guide-unlock-hint'
  connect.setAttribute('aria-describedby', unlockHint.id)
  introduction.append(intro, open, connect, unlockHint)
  panel.prepend(introduction)
  for (const input of panel.querySelectorAll('input, select, textarea')) {
    const key = `labHelp_${input.id.replace('lab-', '')}`
    const help = node('p', key)
    help.id = `${input.id}-help`
    help.className = 'lab-field-help'
    help.setAttribute('popover', 'auto')
    const button = node('button')
    button.type = 'button'
    button.textContent = '?'
    button.className = 'lab-help-button'
    const label = panel.querySelector(`label[for="${input.id}"]`)
      || input.closest('label')?.querySelector('.toggle-switch-label')
    button.setAttribute('aria-label', `${label?.textContent || t('settings:labEnable')} ?`)
    button.setAttribute('aria-controls', help.id)
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('popovertarget', help.id)
    button.onclick = event => {
      event.preventDefault()
      if (help.matches(':popover-open')) {
        help.hidePopover()
        return
      }
      help.showPopover()
      const rect = button.getBoundingClientRect()
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - help.offsetWidth - 12))
      const top = rect.bottom + 8 + help.offsetHeight <= window.innerHeight - 12
        ? rect.bottom + 8
        : Math.max(12, rect.top - help.offsetHeight - 8)
      help.style.left = `${left}px`
      help.style.top = `${top}px`
    }
    help.addEventListener('toggle', () => {
      button.setAttribute('aria-expanded', String(help.matches(':popover-open')))
    })
    input.setAttribute('aria-describedby', help.id)
    const heading = node('span')
    heading.className = 'lab-field-heading'
    label.replaceWith(heading)
    heading.append(label, button)
    heading.append(help)
  }
  const dialog = node('dialog')
  dialog.className = 'modal-content lab-guide-dialog'
  dialog.setAttribute('aria-labelledby', 'lab-guide-title')
  const title = node('h2', 'labGuideTitle')
  title.id = 'lab-guide-title'
  const close = node('button', 'labCloseGuide')
  close.type = 'button'
  close.className = 'close-btn'
  close.removeAttribute('data-i18n')
  close.textContent = '×'
  close.setAttribute('aria-label', t('settings:labCloseGuide'))
  close.onclick = () => dialog.close()
  const header = node('div')
  header.className = 'modal-header'
  header.append(title, close)
  const body = node('div')
  body.className = 'lab-guide-body'
  dialog.append(header, body)

  let mode = 'install'
  let deployment = 'docker'
  let method = 'ssh'
  let completedMethod
  let opener = open
  const parameters = { ...defaultGuideParameters }
  // Only completion and method are persisted; hostnames and credentials are not.
  try {
    const saved = JSON.parse(localStorage.getItem('easypaper.labGuide.v1') || 'null')
    if (['ssh', 'https'].includes(saved?.method)) {
      completedMethod = method = saved.method
      if (['docker', 'systemd'].includes(saved.deployment)) deployment = saved.deployment
      connect.disabled = false
      unlockHint.hidden = true
    }
  } catch { /* The guide also works when storage is unavailable. */ }
  const steps = [
    { title: 'labInstallStep', text: 'labInstallIntro' },
    { title: 'labMethodStep', text: 'labMethodIntro' },
    { title: 'labAccessStep', text: 'labAccessIntro' },
  ]
  let scenes
  let step = 0
  let frame = 0
  let elapsed = 0
  let timer
  let paused = false
  let animation
  let followedElement
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const progress = node('p')
  progress.className = 'lab-guide-progress'
  progress.setAttribute('role', 'status')
  const heading = node('h3')
  heading.tabIndex = -1
  const description = node('p')
  const prerequisites = node('details')
  prerequisites.className = 'lab-guide-prerequisites'
  prerequisites.append(node('summary', 'labSceneTools'))
  const links = node('div')
  for (const [name, href] of [
    ['Git', 'https://git-scm.com/downloads/linux'],
    ['Docker Compose', 'https://docs.docker.com/engine/install/'],
    ['Caddy', 'https://caddyserver.com/docs/install'],
    ['Ollama', 'https://docs.ollama.com/linux'],
  ]) {
    const link = node('a')
    link.textContent = name
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    links.append(link)
  }
  prerequisites.append(links)
  const demo = node('div')
  demo.className = 'lab-guide-demo'
  const screen = node('div')
  screen.className = 'lab-guide-screen'
  screen.setAttribute('role', 'img')
  const screenTitle = node('div')
  const canvas = node('div')
  canvas.className = 'lab-scene-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  screen.append(screenTitle, canvas)
  const sceneNote = node('p')
  const caption = node('p')
  caption.className = 'lab-guide-caption'
  const controls = node('div')
  controls.className = 'lab-guide-controls'
  const button = (key, action) => {
    const element = node('button', key)
    element.type = 'button'
    element.className = 'btn btn-secondary'
    element.onclick = action
    return element
  }
  const stop = () => clearTimeout(timer)
  const updateToggle = () => {
    toggle.textContent = t(`settings:${paused ? 'labWizardPlay' : 'labWizardPause'}`)
    toggle.hidden = reducedMotion.matches
  }
  const paint = () => {
    animation.update(reducedMotion.matches ? animation.duration : elapsed, reducedMotion.matches)
    canvas.dataset.elapsed = String(elapsed)
    canvas.dataset.complete = String(reducedMotion.matches || elapsed >= animation.duration)
    const candidates = [...canvas.querySelectorAll('.is-active, .is-pressed, .lab-demo-result')]
    const active = candidates.filter(element => element.getClientRects().length).at(-1)
    if (!reducedMotion.matches && active && active !== followedElement) {
      const bounds = active.getBoundingClientRect()
      const viewport = body.getBoundingClientRect()
      if (bounds.bottom > viewport.bottom) body.scrollTop += bounds.bottom - viewport.bottom + 12
      else if (bounds.top < viewport.top) body.scrollTop -= viewport.top - bounds.top + 12
    }
    followedElement = active
  }
  const schedule = () => {
    stop()
    if (!dialog.open || paused || reducedMotion.matches || elapsed >= animation.duration) return
    timer = setTimeout(() => {
      elapsed += 80
      paint()
      schedule()
    }, 80)
  }
  const renderFrame = () => {
    stop()
    const scene = scenes[step][frame]
    renderCommands(scene)
    followedElement = undefined
    screenTitle.textContent = scene.title
    sceneNote.textContent = scene.note
    animation = mountLabScene(canvas, scene)
    animation.update(animation.duration, true)
    screen.setAttribute('aria-label', `${scene.title}. ${scene.note}. ${canvas.textContent}`)
    elapsed = reducedMotion.matches ? animation.duration : 0
    caption.textContent = `${frame + 1} / ${scenes[step].length}`
    backFrame.disabled = frame === 0
    const valid = validGuideParameters(parameters, scene.parameters || [])
    nextFrame.disabled = frame === scenes[step].length - 1 || !valid
    next.disabled = frame < scenes[step].length - 1 || !valid
    paused = false
    updateToggle()
    paint()
    schedule()
  }
  const toggle = button('labWizardPause', () => {
    paused = !paused
    if (!paused && elapsed >= animation.duration) elapsed = 0
    updateToggle()
    paint()
    schedule()
  })
  toggle.removeAttribute('data-i18n')
  const replay = button('labWizardReplay', () => {
    paused = false
    updateToggle()
    renderFrame()
  })
  const backFrame = button('labScenePrevious', () => { frame -= 1; renderFrame() })
  const nextFrame = button('labWizardFrame', () => { frame += 1; renderFrame() })
  controls.append(backFrame, toggle, replay, nextFrame, caption)
  demo.append(node('p', 'labWizardDemo'), screen, sceneNote)
  const reference = node('a', 'labWizardDetails')
  reference.href = 'https://github.com/orion-gz/EasyPaper/blob/main/docs/lab-mode.md'
  reference.target = '_blank'
  reference.rel = 'noopener noreferrer'
  const stepHeader = node('div')
  stepHeader.className = 'lab-guide-step-header'
  stepHeader.append(heading, progress)
  const choices = node('div')
  choices.className = 'lab-guide-choices'
  const commandArea = node('div')
  commandArea.className = 'lab-guide-commands'
  const parameterFields = node('div')
  parameterFields.className = 'lab-guide-parameters'
  const snippet = node('div')
  snippet.className = 'lab-guide-snippet'
  const code = node('code')
  code.tabIndex = 0
  const copyStatus = node('p')
  copyStatus.setAttribute('role', 'status')
  const copy = button('labCopyCommand', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent)
      copyStatus.textContent = t('settings:labCopiedCommand')
    } catch { copyStatus.textContent = t('settings:labCopyFailed') }
  })
  copy.removeAttribute('data-i18n')
  copy.innerHTML = icon('clipboard', 16, 'aria-hidden="true"')
  copy.setAttribute('aria-label', t('settings:labCopyCommand'))
  copy.title = t('settings:labCopyCommand')
  snippet.append(code, copy)
  commandArea.append(parameterFields, snippet, copyStatus)
  const refreshScenes = () => {
    scenes = mode === 'install' ? installationScenes(deployment, method, parameters) : connectionScenes(completedMethod, parameters)
  }
  const renderCommands = scene => {
    parameterFields.replaceChildren()
    copyStatus.textContent = ''
    const updateCode = () => {
      refreshScenes()
      const current = scenes[step][frame]
      code.textContent = current.copy || current.commands?.map(([command]) => command).join('\n') || ''
      snippet.hidden = !code.textContent
      copy.disabled = !validGuideParameters(parameters, scene.parameters || [])
      nextFrame.disabled = frame === scenes[step].length - 1 || copy.disabled
      next.disabled = frame < scenes[step].length - 1 || copy.disabled
      copyStatus.textContent = copy.disabled ? t('settings:labInvalidParameters') : ''
    }
    const keys = { host: 'labHostField', user: 'labUserField', port: 'labPortField', localPort: 'labLocalPortField', domain: 'labDomainField', model: 'labEngineModelField' }
    for (const name of scene.parameters || []) {
      const label = node('label', keys[name])
      const input = node('input')
      input.className = 'lab-guide-input'
      input.id = `lab-guide-param-${name}`
      input.value = parameters[name]
      input.type = name.toLowerCase().includes('port') ? 'number' : 'text'
      if (input.type === 'number') { input.min = '1'; input.max = '65535' }
      input.autocomplete = 'off'
      input.spellcheck = false
      label.htmlFor = input.id
      input.oninput = () => {
        parameters[name] = input.value.trim()
        updateCode()
        // Keep the existing animation in sync without stealing input focus.
        stop()
        animation = mountLabScene(canvas, scenes[step][frame])
        screenTitle.textContent = scenes[step][frame].title
        animation.update(animation.duration, true)
        screen.setAttribute('aria-label', `${scene.note}. ${canvas.textContent}`)
        elapsed = animation.duration
        paint()
      }
      const field = node('div')
      field.className = 'form-group'
      field.append(label, input)
      parameterFields.append(field)
    }
    updateCode()
    commandArea.hidden = !scene.parameters?.length && snippet.hidden
  }
  const renderChoices = () => {
    choices.replaceChildren()
    const options = mode === 'install' && step === 0
      ? [['docker', 'Docker'], ['systemd', 'systemd']]
      : mode === 'install' && step === 1
        ? [['ssh', t('settings:labSshChoice')], ['https', t('settings:labHttpsChoice')]] : []
    choices.hidden = !options.length
    for (const [value, text] of options) {
      const choice = button(null, () => {
        if (step === 0) deployment = value
        else method = value
        // Changing the installation path requires reviewing it before reconnecting.
        completedMethod = undefined
        connect.disabled = true
        unlockHint.hidden = false
        try { localStorage.removeItem('easypaper.labGuide.v1') } catch { /* optional persistence */ }
        refreshScenes()
        renderStep()
      })
      choice.textContent = text
      choice.setAttribute('aria-pressed', String(value === (step === 0 ? deployment : method)))
      choices.append(choice)
    }
  }
  body.append(stepHeader, description, choices, prerequisites, demo, commandArea, reference)
  const footer = node('div')
  footer.className = 'lab-guide-footer'
  const previous = button('labWizardPrevious', () => { step -= 1; renderStep() })
  const next = button('labWizardNext', () => {
    if (step === scenes.length - 1) {
      if (mode === 'install') {
        completedMethod = method
        connect.disabled = false
        unlockHint.hidden = true
        try { localStorage.setItem('easypaper.labGuide.v1', JSON.stringify({ method, deployment })) } catch { /* optional persistence */ }
      }
      dialog.close()
    } else { step += 1; renderStep() }
  })
  next.removeAttribute('data-i18n')
  next.className = 'btn btn-primary'
  footer.append(previous, next)
  dialog.append(controls, footer)
  const renderStep = () => {
    frame = 0
    paused = false
    progress.textContent = `STEP ${step + 1} / ${scenes.length}`
    heading.textContent = t(`settings:${mode === 'install' ? steps[step].title : 'labConnectionGuide'}`)
    description.textContent = t(`settings:${mode === 'install' ? steps[step].text : 'labConnectIntro'}`)
    prerequisites.hidden = mode !== 'install' || step !== 0
    renderChoices()
    previous.disabled = step === 0
    next.textContent = t(`settings:${step === scenes.length - 1 ? 'labWizardDone' : 'labWizardNext'}`)
    updateToggle()
    const hasScenes = scenes[step].length > 0
    demo.hidden = controls.hidden = commandArea.hidden = !hasScenes
    next.disabled = false
    if (hasScenes) renderFrame()
    else stop()
    body.scrollTop = 0
    heading.focus()
  }
  reducedMotion.addEventListener('change', () => {
    updateToggle()
    if (!animation || controls.hidden) return
    paint()
    schedule()
  })
  panel.append(dialog)
  const showGuide = guideMode => {
    mode = guideMode
    opener = mode === 'install' ? open : connect
    title.removeAttribute('data-i18n')
    title.textContent = t(`settings:${mode === 'install' ? 'labInstallGuide' : 'labConnectionGuide'}`)
    refreshScenes()
    step = 0
    paused = false
    toggle.textContent = t('settings:labWizardPause')
    dialog.showModal()
    renderStep()
  }
  open.onclick = () => showGuide('install')
  connect.onclick = () => showGuide('connect')
  dialog.addEventListener('close', () => { stop(); opener.focus() })
}
