import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sshLauncher } from '../src/labSshLauncher.js'
import { defaultGuideParameters, validGuideParameters } from '../src/labGuideFlow.js'

test('Unix launcher executes OpenSSH with a loopback-only tunnel and keeps host verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-ssh-'))
  try {
    const file = sshLauncher(defaultGuideParameters, 'unix')
    const stub = join(dir, 'ssh')
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@" > "$LAB_SSH_ARGS"\n')
    chmodSync(stub, 0o755)
    writeFileSync(join(dir, file.name), file.content)
    execFileSync('bash', [join(dir, file.name)], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LAB_SSH_ARGS: join(dir, 'args') } })
    const args = readFileSync(join(dir, 'args'), 'utf8')
    assert.ok(args.includes('127.0.0.1:18000:127.0.0.1:8000'))
    assert.ok(args.includes('ExitOnForwardFailure=yes'))
    assert.ok(!args.includes('StrictHostKeyChecking'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('both launcher formats reject command injection and invalid ports', () => {
  for (const platform of ['unix', 'windows']) {
    for (const changed of [{ host: 'host&whoami' }, { user: '%PATH%' }, { user: 'a$(id)' }, { port: '65536' }, { localPort: '0' }]) {
      assert.throws(() => sshLauncher({ ...defaultGuideParameters, ...changed }, platform))
    }
  }
  const windows = sshLauncher(defaultGuideParameters, 'windows')
  assert.equal(windows.name, 'easypaper-connect.cmd')
  assert.ok(windows.content.includes('ssh.exe '))
  assert.ok(!windows.content.includes('ExecutionPolicy'))
})

test('public IPv4 fields reject shell expressions and out-of-range octets', () => {
  assert.ok(validGuideParameters(defaultGuideParameters, ['publicIp']))
  for (const publicIp of ['999.1.1.1', '1.2.3.4;id', '1.2.3', '$(id)']) {
    assert.equal(validGuideParameters({ ...defaultGuideParameters, publicIp }, ['publicIp']), false)
  }
})
