import { syncSelectValue } from './uiScale.js'
import { t } from './i18n.js'
import './styles/ssh-connection-form.css'
let editorSequence = 0
/** Shared backend-owned SSH connection editor. Never repopulates secret inputs. */
export function connectionEditor(parent, probe) {
  const root = document.createElement('fieldset')
  root.className = 'ssh-connection-form'
  root.setAttribute('aria-label', t('settings:connectionConnection'))
  const fields = {}
  const wrappers = {}
  const prefix = `ssh-editor-${++editorSequence}`
  let storageAvailable = true
  function field(name, label, type = 'text', options) {
    const wrapper = document.createElement('label')
    wrapper.textContent = label
    const input = document.createElement(options ? 'select' : type === 'textarea' ? 'textarea' : 'input')
    if (options) for (const [value, text] of options) input.add(new Option(text, value))
    else if (type !== 'textarea') input.type = type
    input.id = `${prefix}-${name}`
    wrapper.htmlFor = input.id
    wrappers[name] = wrapper
    input.autocomplete = 'off'
    wrapper.append(input)
    root.append(wrapper)
    fields[name] = input
    return input
  }
  field('transport', t('settings:connectionConnection'), 'text', [['https', 'HTTP(S)'], ['ssh', 'SSH']])
  field('host', t('settings:connectionSshHost'))
  field('port', t('settings:connectionSshPort'), 'number').value = '22'
  fields.port.min = '1'; fields.port.max = '65535'
  field('username', t('settings:connectionSshUsername'))
  field('auth', t('settings:connectionAuthentication'), 'text', [['password', t('settings:connectionPassword')], ['key', t('settings:connectionPrivateKey')]])
  field('password', t('settings:connectionPassword'), 'password')
  field('private_key', t('settings:connectionPrivateKeyPemOpenssh'), 'textarea')
  field('passphrase', t('settings:connectionKeyPassphrase'), 'password')
  field('save_credentials', t('settings:connectionSaveCredentialsSecurely'), 'checkbox')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-secondary'
  button.textContent = t('settings:connectionVerifyHostKey')
  const message = document.createElement('p')
  message.setAttribute('role', 'status')
  root.append(button, message)
  parent.append(root)
  let hostKey = ''
  const ssh = () => ({ host: fields.host.value.trim(), port: Number(fields.port.value), username: fields.username.value.trim(), auth: fields.auth.value, host_key: hostKey })
  function visibility() {
    const enabled = fields.transport.value === 'ssh'
    for (const name of ['host', 'port', 'username', 'auth']) wrappers[name].hidden = !enabled
    for (const name of ['password', 'private_key', 'passphrase']) wrappers[name].hidden = !enabled || (name === 'password' ? fields.auth.value !== 'password' : fields.auth.value !== 'key')
    button.hidden = !enabled
    message.hidden = !enabled
  }
  for (const name of ['host', 'port']) fields[name].addEventListener('input', () => { hostKey = ''; message.textContent = '' })
  fields.transport.addEventListener('change', visibility)
  fields.auth.addEventListener('change', visibility)
  button.onclick = async () => {
    button.disabled = true
    try {
      const result = await probe(ssh())
      if (window.confirm(t('settings:connectionConfirmFingerprint', { fingerprint: result.fingerprint }))) {
        hostKey = result.host_key
        message.textContent = result.fingerprint
      }
    } catch (error) { message.textContent = error.message }
    finally { button.disabled = false }
  }
  const clear = () => { for (const name of ['password', 'private_key', 'passphrase']) fields[name].value = '' }
  visibility()
  return {
    storage(capability) {
      storageAvailable = capability?.available !== false
      fields.save_credentials.disabled = !storageAvailable
      if (!storageAvailable) fields.save_credentials.checked = false
      fields.save_credentials.title = capability?.reason || ''
    },
    read() {
      if (fields.transport.value === 'ssh' && !hostKey) throw new Error(t('settings:connectionVerifyTheSshHostKeyFirst'))
      return { transport: fields.transport.value, ssh: fields.transport.value === 'ssh' ? ssh() : null,
        save_credentials: storageAvailable && fields.save_credentials.checked,
        credentials: Object.fromEntries(['password', 'private_key', 'passphrase'].map(name => [name, fields[name].value])) }
    },
    load(profile = {}) {
      syncSelectValue(fields.transport, profile.transport || 'https')
      for (const name of ['host', 'username']) fields[name].value = profile.ssh?.[name] || ''
      fields.port.value = profile.ssh?.port || 22
      syncSelectValue(fields.auth, profile.ssh?.auth || 'password')
      fields.save_credentials.checked = storageAvailable && !!profile.save_credentials
      hostKey = profile.ssh?.host_key || ''
      message.textContent = hostKey ? t('settings:connectionHostKeyConfirmed') : ''
      clear(); visibility()
    }, clear,
  }
}
