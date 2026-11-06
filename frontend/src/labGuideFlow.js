import { t } from './i18n.js'

export const defaultGuideParameters = { host: 'lab-server', user: 'user', port: '22', localPort: '18000', domain: 'lab.example.com', model: 'qwen3:4b' }
export function validGuideParameters(values, names = Object.keys(defaultGuideParameters)) {
  const port = value => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535
  const valid = {
    host: /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(values.host),
    user: /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(values.user),
    model: /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(values.model),
    port: port(values.port),
    localPort: port(values.localPort),
    domain: /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(values.domain),
  }
  return names.every(name => valid[name])
}
export const tunnelCommand = values => `ssh -o ExitOnForwardFailure=yes -N -L ${values.localPort}:127.0.0.1:8000 -p ${values.port} ${values.user}@${values.host}`
export const guideServerUrl = (method, values) => method === 'ssh' ? `http://localhost:${values.localPort}` : `https://${values.domain}`

export function installationScenes(deployment, method, values) {
  const terminal = (title, command, note, parameters = []) => ({ kind: 'terminal', title, commands: [[command, ['✓']]], note: t(`settings:${note}`), parameters })
  const tunnel = terminal('SSH', tunnelCommand(values), 'labSshNote', ['host', 'user', 'port', 'localPort'])
  const admin = { kind: 'admin-login', title: `http://localhost:${values.localPort}`, url: `http://localhost:${values.localPort}`, note: t('settings:labAdminLoginNote'), copy: `http://localhost:${values.localPort}` }
  const install = [
    terminal('Git', 'sudo apt-get update && sudo apt-get install -y git curl ca-certificates', 'labToolsNote'),
    terminal('EasyPaper', 'git clone https://github.com/orion-gz/EasyPaper.git && cd EasyPaper', 'labCloneNote'),
  ]
  if (deployment === 'docker') install.push(
    terminal('Docker Compose', 'sudo apt-get install -y docker.io docker-compose-v2 && sudo systemctl enable --now docker', 'labToolsNote'),
    terminal('EasyPaper · Docker', 'mkdir -p lab-data/home && sudo chown -R 1000:1000 lab-data', 'labDockerData'),
    terminal('EasyPaper · Docker', 'sudo docker compose -f docker-compose.lab.yml up -d --build', 'labDockerRun'),
  )
  else install.push(terminal('EasyPaper · systemd', 'sudo bash deploy/lab/install-systemd.sh', 'labSystemdRun'))
  const bridge = "$(sudo docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
  const engineHost = deployment === 'docker' ? bridge : '127.0.0.1'
  const engineUrl = deployment === 'docker' ? 'http://host.docker.internal:11434' : 'http://127.0.0.1:11434'
  install.push(
    terminal('Ollama', 'LAB_OLLAMA_INSTALL="$(mktemp)" && curl -fsSL https://ollama.com/install.sh -o "$LAB_OLLAMA_INSTALL" && sh "$LAB_OLLAMA_INSTALL" && rm -f "$LAB_OLLAMA_INSTALL"', 'labEngineInstallNote'),
    terminal('Ollama · OLLAMA_HOST', `LAB_OLLAMA_IP="${engineHost}" && test -n "$LAB_OLLAMA_IP" && sudo install -d /etc/systemd/system/ollama.service.d && printf '[Service]\\nEnvironment="OLLAMA_HOST=%s:11434"\\n' "$LAB_OLLAMA_IP" | sudo tee /etc/systemd/system/ollama.service.d/90-easypaper.conf`, deployment === 'docker' ? 'labEngineBindDocker' : 'labEngineBindSystemd'),
    terminal('Ollama', `sudo systemctl daemon-reload && sudo systemctl enable ollama && sudo systemctl restart ollama && curl --fail --retry 20 --retry-connrefused --retry-delay 3 --max-time 5 "http://${engineHost}:11434/api/tags"`, 'labEngineStartNote'),
    terminal('Ollama · model', `OLLAMA_HOST="http://${engineHost}:11434" ollama pull ${values.model}`, 'labEnginePullNote', ['model']),
  )
  const access = [tunnel, admin, { kind: 'account', title: t('settings:labAccountScene'), note: t('settings:labAccountNote') }]
  if (method === 'https') access.push(
    { kind: 'network', title: 'DNS · HTTPS', domain: values.domain, note: t('settings:labDnsNote'), parameters: ['domain'] },
    terminal('Caddy', 'sudo apt-get update && sudo apt-get install -y caddy', 'labCaddyNote'),
    terminal('Caddyfile', `printf '%s\\n' '${values.domain} {' '    reverse_proxy 127.0.0.1:8000' '}' | sudo tee /etc/caddy/Caddyfile\nsudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`, 'labProxyNote', ['domain']),
    terminal('HTTPS', `curl --fail --head https://${values.domain}`, 'labVerifyNote', ['domain']),
  )
  access.push(
    { kind: 'inference', title: 'EasyPaper · Lab', url: engineUrl, model: values.model, copy: engineUrl, parameters: ['model'], note: t('settings:labEngineConfigureNote') },
    { kind: 'enable', title: 'EasyPaper · Lab', note: t('settings:labEngineSetupNote') },
    { kind: 'invite', title: 'EasyPaper · Lab', url: guideServerUrl(method, values), note: method === 'ssh' ? t('settings:labInviteSsh') : t('settings:labInviteHttps') },
  )
  return [install, [], access]
}

export function connectionScenes(method, values) {
  const scenes = []
  if (method === 'ssh') scenes.push({ kind: 'terminal', title: 'SSH', commands: [[tunnelCommand(values), ['✓']]], note: t('settings:labSshNote'), parameters: ['host', 'user', 'port', 'localPort'] })
  scenes.push({ kind: 'connection', title: guideServerUrl(method, values), url: guideServerUrl(method, values), note: t('settings:labConnectNote'), parameters: method === 'https' ? ['domain'] : ['localPort'], copy: guideServerUrl(method, values) })
  return [scenes]
}
