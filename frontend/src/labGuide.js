import { t } from './i18n.js'

const labels = () => ({
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
      element.textContent = labels()[key]
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
  const section = (titleKey, textKeys) => {
    const details = node('details')
    details.append(node('summary', titleKey))
    for (const key of textKeys) details.append(node('p', key))
    body.append(details)
    return details
  }
  const server = section('labGuideServer', ['labGuideServerText'])
  server.open = true
  const commands = node('pre')
  commands.textContent = 'mkdir -p lab-data/home\n# Set lab-data ownership to LAB_APP_UID:LAB_APP_GID\ndocker compose -f docker-compose.lab.yml up -d --build\ndocker compose -f docker-compose.lab.yml logs --tail=100'
  server.append(commands)
  const deployLabel = node('label', 'labDeployChoice')
  deployLabel.htmlFor = 'lab-guide-deploy'
  const deploy = node('select')
  deploy.id = 'lab-guide-deploy'
  deploy.className = 'form-select'
  for (const value of ['Docker Compose', 'systemd']) {
    const option = node('option'); option.value = value; option.textContent = value; deploy.append(option)
  }
  const dockerCommands = commands.textContent
  const deployHelp = node('p')
  deployHelp.setAttribute('aria-live', 'polite')
  deploy.onchange = () => {
    const docker = deploy.value === 'Docker Compose'
    commands.textContent = docker ? dockerCommands : 'sudo cp deploy/lab/easypaper-lab.service /etc/systemd/system/\nsudo systemctl daemon-reload\nsudo systemctl enable --now easypaper-lab\nsudo systemctl status easypaper-lab'
    deployHelp.textContent = docker ? t('settings:labGuideServerText') : t('settings:labSystemdHelp')
  }
  server.insertBefore(deployLabel, commands)
  server.insertBefore(deploy, commands)
  server.insertBefore(deployHelp, commands)
  const checklist = node('div')
  checklist.className = 'lab-guide-checklist'
  const progress = node('p')
  progress.setAttribute('role', 'status')
  const updateProgress = () => { progress.textContent = t('settings:labChecklistProgress', { done: checklist.querySelectorAll(':checked').length, total: 3 }) }
  for (const key of ['labReadyData', 'labReadyNetwork', 'labReadyAccount']) {
    const label = node('label')
    const check = node('input'); check.type = 'checkbox'; check.onchange = updateProgress
    label.append(check, node('span', key)); checklist.append(label)
  }
  updateProgress()
  server.append(checklist, progress)
  const engine = section('labGuideEngine', ['labGuideModels'])
  const choices = node('div')
  choices.className = 'form-actions'
  const description = node('p')
  const command = node('pre')
  const source = node('a')
  source.target = '_blank'
  source.rel = 'noopener noreferrer'
  const choose = value => {
    const ollama = value === 'ollama'
    description.textContent = t(`settings:${ollama ? 'labGuideOllama' : 'labGuideVllm'}`)
    command.textContent = ollama ? 'ollama serve\n# In another terminal:\nollama pull qwen3:4b\n# URL: http://host.docker.internal:11434\n# Model: qwen3:4b' : 'vllm serve Qwen/Qwen3-4B --host 0.0.0.0 --port 8000\n# URL: http://gpu-server:8000/v1\n# Model: Qwen/Qwen3-4B'
    source.textContent = ollama ? 'Ollama · Qwen3' : 'vLLM · Serving'
    source.href = ollama ? 'https://ollama.com/library/qwen3' : 'https://docs.vllm.ai/en/stable/serving/online_serving/openai_compatible_server/'
    for (const button of choices.children) button.setAttribute('aria-pressed', String(button.dataset.engine === value))
  }
  for (const value of ['ollama', 'vllm']) {
    const button = node('button')
    button.type = 'button'
    button.className = 'btn btn-secondary'
    button.textContent = value === 'ollama' ? 'Ollama' : 'vLLM'
    button.dataset.engine = value
    button.onclick = () => choose(value)
    choices.append(button)
  }
  engine.append(choices, description, command, node('p', 'labGuideNetwork'), source)
  choose('ollama')
  const members = section('labGuideMembers', ['labGuideMembersText'])
  const nameLabel = node('label', 'labPreviewName')
  nameLabel.htmlFor = 'lab-guide-name'
  const name = node('input')
  name.id = 'lab-guide-name'; name.value = 'alice'; name.maxLength = 80
  const preview = node('p'); preview.setAttribute('role', 'status')
  const previewName = () => { preview.textContent = /^[a-zA-Z0-9_.-]{1,80}$/.test(name.value) ? t('settings:labPreviewSpace', { name: name.value }) : t('settings:labPreviewInvalid') }
  name.oninput = previewName; previewName()
  const pathLabel = node('label', 'labMemberPath'); pathLabel.htmlFor = 'lab-guide-space'
  const path = node('select'); path.id = 'lab-guide-space'; path.className = 'form-select'
  for (const key of ['labSharedSpace', 'labCliSpace']) { const option = node('option', key); option.value = key; path.append(option) }
  const cli = node('div'); cli.hidden = true
  cli.append(node('p', 'labGuideCli'))
  const readyLabel = node('label'); readyLabel.className = 'lab-guide-checklist'
  const ready = node('input'); ready.type = 'checkbox'
  readyLabel.append(ready, node('span', 'labCliReady'))
  const next = node('p'); next.setAttribute('role', 'status')
  const updateNext = () => { next.textContent = ready.checked ? t('settings:labCliNext') : t('settings:labCliWait') }
  ready.onchange = updateNext; updateNext()
  cli.append(readyLabel, next)
  path.onchange = () => { cli.hidden = path.value !== 'labCliSpace' }
  members.append(nameLabel, name, preview, pathLabel, path, cli)
  panel.append(dialog)
  open.onclick = () => { choose('ollama'); dialog.showModal() }
  dialog.addEventListener('close', () => open.focus())
}
