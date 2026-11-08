import { validGuideParameters, tunnelCommand } from './labGuideFlow.js'

// Downloads contain connection parameters only; authentication stays in OpenSSH.
export function sshLauncher(values, platform) {
  if (!validGuideParameters(values, ['host', 'user', 'port', 'localPort'])) throw new Error('Invalid SSH parameters')
  const command = tunnelCommand(values)
  const url = `http://localhost:${values.localPort}`
  if (platform === 'windows') return {
    name: 'easypaper-connect.cmd',
    content: `@echo off\r\necho Keep this window open. Open ${url} after SSH connects.\r\n${command.replace(/^ssh /, 'ssh.exe ')}\r\nset "LAB_SSH_EXIT=%ERRORLEVEL%"\r\npause\r\nexit /b %LAB_SSH_EXIT%\r\n`,
  }
  if (platform !== 'unix') throw new Error('Unsupported SSH launcher platform')
  return {
    name: 'easypaper-connect.sh',
    content: `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' 'Keep this terminal open. Open ${url} after SSH connects.'\nexec ${command}\n`,
  }
}
