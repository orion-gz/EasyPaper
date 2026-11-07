import { t } from './i18n.js'

export const defaultGuideParameters = { host: 'lab-server', user: 'user', port: '22', localPort: '18000', domain: 'lab.example.com', model: 'qwen3:4b', publicIp: '203.0.113.10' }
export function validGuideParameters(values, names = Object.keys(defaultGuideParameters)) {
  const port = value => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535
  const valid = {
    publicIp: /^(?:\d{1,3}\.){3}\d{1,3}$/.test(values.publicIp) && values.publicIp.split('.').every(part => Number(part) <= 255),
    host: /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(values.host),
    user: /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(values.user),
    model: /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(values.model),
    port: port(values.port),
    localPort: port(values.localPort),
    domain: /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(values.domain),
  }
  return names.every(name => valid[name])
}
export const tunnelCommand = values => `ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -L 127.0.0.1:${values.localPort}:127.0.0.1:8000 -p ${values.port} ${values.user}@${values.host}`
export const guideServerUrl = (method, values) => method === 'ssh' ? `http://localhost:${values.localPort}` : `https://${values.domain}`

export function installationScenes(deployment, method, values) {
  const terminal = (title, command, note, parameters = []) => ({ kind: 'terminal', title, commands: [[command, ['✓']]], note: t(`settings:${note}`), parameters })
  const tunnel = terminal('SSH', tunnelCommand(values), 'labSshNote', ['host', 'user', 'port', 'localPort'])
  const admin = { kind: 'admin-login', title: `http://localhost:${values.localPort}`, url: `http://localhost:${values.localPort}`, note: t('settings:labAdminLoginNote'), copy: `http://localhost:${values.localPort}` }
  const install = [deployment === 'docker'
    ? terminal('EasyPaper · Docker', 'sudo bash deploy/lab/install-docker.sh', 'labDockerRun')
    : terminal('EasyPaper · systemd', 'sudo bash deploy/lab/install-systemd.sh', 'labSystemdRun')]
  const engineUrl = deployment === 'docker' ? 'http://host.docker.internal:11434' : 'http://127.0.0.1:11434'
  install.push(
    terminal('Ollama', `sudo bash deploy/lab/install-inference.sh --deployment ${deployment} --model ${values.model}`, 'labAutomatedInference', ['model']),
    terminal('Diagnostics', `sudo bash deploy/lab/diagnose.sh --deployment ${deployment} --model ${values.model}`, 'labDiagnosticsNote', ['model']),
  )
  tunnel.sshDownload = true
  const access = [tunnel, admin, { kind: 'account', title: t('settings:labAccountScene'), note: t('settings:labAccountNote') }]
  if (method === 'https') access.push(
    { kind: 'network', title: 'DNS · HTTPS', domain: values.domain, note: t('settings:labDnsNote'), parameters: ['domain'] },
    terminal('Caddy · HTTPS', `sudo bash deploy/lab/install-https.sh --domain ${values.domain} --public-ip ${values.publicIp}`, 'labAutomatedHttps', ['domain', 'publicIp']),
    terminal('HTTPS', `curl --fail --show-error --silent --output /dev/null --write-out 'HTTP %{http_code}\\n' https://${values.domain}`, 'labVerifyNote', ['domain']),
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
  if (method === 'ssh') scenes.push({ kind: 'terminal', title: 'SSH', commands: [[tunnelCommand(values), ['✓']]], sshDownload: true, note: t('settings:labSshNote'), parameters: ['host', 'user', 'port', 'localPort'] })
  scenes.push({ kind: 'connection', title: guideServerUrl(method, values), url: guideServerUrl(method, values), note: method === 'ssh' ? `${t('settings:labConnectNote')} ${t('settings:labConnectSshPortNote')}` : t('settings:labConnectNote'), parameters: method === 'https' ? ['domain'] : ['localPort'], readOnlyParameters: method === 'ssh' ? ['localPort'] : [], copy: guideServerUrl(method, values) })
  return [scenes]
}
