import { t } from './i18n.js'

const labels = () => ({
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
  panel.prepend(intro, open)
  for (const input of panel.querySelectorAll('input, select, textarea')) {
    const key = `labHelp_${input.id.replace('lab-', '')}`
    const help = node('p', key)
    help.id = `${input.id}-help`
    help.className = 'lab-field-help'
    help.hidden = true
    const button = node('button')
    button.type = 'button'
    button.textContent = '?'
    button.className = 'lab-help-button'
    const label = panel.querySelector(`label[for="${input.id}"]`)
    button.setAttribute('aria-label', `${label?.textContent || t('settings:labEnable')} ?`)
    button.setAttribute('aria-controls', help.id)
    button.setAttribute('aria-expanded', 'false')
    button.onclick = () => {
      help.hidden = !help.hidden
      button.setAttribute('aria-expanded', String(!help.hidden))
    }
    input.setAttribute('aria-describedby', help.id)
    const group = input.closest('.form-group')
    group.append(button, help)
  }
  const dialog = node('dialog')
  dialog.className = 'lab-guide-dialog'
  dialog.setAttribute('aria-labelledby', 'lab-guide-title')
  const title = node('h2', 'labGuideTitle')
  title.id = 'lab-guide-title'
  const close = node('button', 'labCloseGuide')
  close.type = 'button'
  close.className = 'btn btn-secondary'
  close.onclick = () => dialog.close()
  dialog.append(title, close)
  const section = (titleKey, textKeys) => {
    const details = node('details')
    details.append(node('summary', titleKey))
    for (const key of textKeys) details.append(node('p', key))
    dialog.append(details)
    return details
  }
  const server = section('labGuideServer', ['labGuideServerText'])
  server.open = true
  const commands = node('pre')
  commands.textContent = 'mkdir -p lab-data/home\n# Set lab-data ownership to LAB_APP_UID:LAB_APP_GID\ndocker compose -f docker-compose.lab.yml up -d --build\ndocker compose -f docker-compose.lab.yml logs --tail=100'
  server.append(commands)
  const engine = section('labGuideEngine', ['labGuideModels'])
  const choices = node('div')
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
  section('labGuideMembers', ['labGuideMembersText', 'labGuideCli'])
  panel.append(dialog)
  open.onclick = () => { choose('ollama'); dialog.showModal() }
  dialog.addEventListener('close', () => open.focus())
}
