import { t } from './i18n.js'

const labels = () => ({
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
  const open = node('button', 'labGuideTitle')
  open.type = 'button'
  open.className = 'btn btn-secondary'
  const introduction = node('div')
  introduction.className = 'lab-introduction'
  introduction.append(intro, open)
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

  const steps = [
    { title: 'labGuideServer', text: 'labWizardServer', frames: [
      ['SSH', '$ ssh user@lab-server\n$ git clone https://github.com/orion-gz/EasyPaper.git\n$ cd EasyPaper'],
      ['Docker Compose', '$ mkdir -p lab-data/home\n$ sudo chown -R 1000:1000 lab-data\n$ docker compose -f docker-compose.lab.yml up -d --build'],
      ['HTTPS · /etc/caddy/Caddyfile', 'lab.example.com {\n    reverse_proxy 127.0.0.1:8000\n}'],
      ['HTTPS', '$ sudo systemctl reload caddy\nhttps://lab.example.com → EasyPaper'],
    ] },
    { title: 'labGuideEngine', text: 'labWizardEngine', frames: [
      ['Ollama · /etc/systemd/system/ollama.service.d/override.conf', '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"'],
      ['SSH', '$ sudo systemctl daemon-reload\n$ sudo systemctl restart ollama\n$ ollama pull qwen3:4b'],
      ['EasyPaper · Lab', 'Ollama\nhttp://host.docker.internal:11434\nqwen3:4b'],
      ['EasyPaper · Lab', () => t('settings:labWizardConnect')],
    ] },
    { title: 'labGuideMembers', text: 'labWizardMembers', frames: [
      ['EasyPaper · Lab', () => t('settings:labWizardEnable')],
      ['EasyPaper · Lab', () => t('settings:labWizardInvite')],
      ['https://lab.example.com', () => t('settings:labWizardLogin')],
      ['EasyPaper · alice', () => t('settings:labWizardSpace')],
    ] },
  ]
  let step = 0
  let frame = 0
  let timer
  let paused = false
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const progress = node('p')
  progress.className = 'lab-guide-progress'
  progress.setAttribute('role', 'status')
  const heading = node('h3')
  heading.tabIndex = -1
  const description = node('p')
  const demo = node('div')
  demo.className = 'lab-guide-demo'
  const demoLabel = node('p', 'labWizardDemo')
  const screen = node('div')
  screen.className = 'lab-guide-screen'
  const screenTitle = node('div')
  const output = node('pre')
  const caption = node('p')
  caption.className = 'lab-guide-caption'
  screen.append(screenTitle, output)
  const controls = node('div')
  controls.className = 'lab-guide-controls'
  const button = (key, action) => {
    const el = node('button', key)
    el.type = 'button'
    el.className = 'btn btn-secondary'
    el.onclick = action
    return el
  }
  const stop = () => { clearTimeout(timer) }
  const renderFrame = () => {
    const current = steps[step].frames[frame]
    screenTitle.textContent = current[0]
    output.textContent = typeof current[1] === 'function' ? current[1]() : current[1]
    caption.textContent = `${frame + 1} / ${steps[step].frames.length}`
    screen.classList.remove('is-playing')
    void screen.offsetWidth
    if (!paused && !reducedMotion.matches) screen.classList.add('is-playing')
  }
  const schedule = () => {
    stop()
    if (!dialog.open || paused || reducedMotion.matches) return
    timer = setTimeout(() => {
      frame = (frame + 1) % steps[step].frames.length
      renderFrame()
      schedule()
    }, 4000)
  }
  const toggle = button('labWizardPause', () => {
    paused = !paused
    toggle.textContent = t(`settings:${paused ? 'labWizardPlay' : 'labWizardPause'}`)
    renderFrame()
    schedule()
  })
  toggle.removeAttribute('data-i18n')
  const replay = button('labWizardReplay', () => { frame = 0; renderFrame(); schedule() })
  const nextFrame = button('labWizardFrame', () => {
    frame = (frame + 1) % steps[step].frames.length
    renderFrame()
    schedule()
  })
  controls.append(toggle, replay, nextFrame)
  demo.append(demoLabel, screen, caption, controls)
  const reference = node('a', 'labWizardDetails')
  reference.href = 'https://github.com/orion-gz/EasyPaper/blob/main/docs/lab-mode.md'
  reference.target = '_blank'
  reference.rel = 'noopener noreferrer'
  body.append(progress, heading, description, demo, reference)
  const footer = node('div')
  footer.className = 'lab-guide-footer'
  const previous = button('labWizardPrevious', () => { step -= 1; renderStep() })
  const next = button('labWizardNext', () => {
    if (step === steps.length - 1) dialog.close()
    else { step += 1; renderStep() }
  })
  next.removeAttribute('data-i18n')
  next.className = 'btn btn-primary'
  footer.append(previous, next)
  dialog.append(footer)
  const renderStep = () => {
    stop()
    frame = 0
    progress.textContent = `STEP ${step + 1} / 3`
    heading.textContent = t(`settings:${steps[step].title}`)
    description.textContent = t(`settings:${steps[step].text}`)
    previous.disabled = step === 0
    next.textContent = t(`settings:${step === 2 ? 'labWizardDone' : 'labWizardNext'}`)
    toggle.hidden = reducedMotion.matches
    renderFrame()
    body.scrollTop = 0
    heading.focus()
    schedule()
  }
  reducedMotion.addEventListener('change', () => {
    toggle.hidden = reducedMotion.matches
    renderFrame()
    schedule()
  })
  panel.append(dialog)
  open.onclick = () => {
    step = 0
    paused = false
    toggle.textContent = t('settings:labWizardPause')
    dialog.showModal()
    renderStep()
  }
  dialog.addEventListener('close', () => { stop(); open.focus() })
}
