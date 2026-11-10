import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { defaultGuideParameters, installationScenes, connectionScenes, validGuideParameters } from '../src/labGuideFlow.js'

for (const deployment of ['docker', 'systemd']) {
  for (const method of ['ssh', 'https']) {
    test(`${deployment}/${method}: complete setup order and safe shell commands`, () => {
      const [install, choice, access] = installationScenes(deployment, method, defaultGuideParameters)
      assert.deepEqual(choice, [])
      assert.equal(install[0].commands[0][0], `sudo bash deploy/lab/install-${deployment}.sh`)
      assert.equal(install.filter(scene => scene.title.startsWith('EasyPaper')).length, 1)
      assert.ok(!JSON.stringify(install).includes(deployment === 'docker' ? 'install-systemd.sh' : 'install-docker.sh'))
      assert.ok(!JSON.stringify(install).includes('apt-get'))
      const commands = install.flatMap(scene => scene.commands?.map(([command]) => command) || [])
      assert.ok(commands.some(command => command.includes(`install-inference.sh --deployment ${deployment} --model qwen3:4b`)))
      assert.ok(commands.at(-1).includes(`diagnose.sh --deployment ${deployment} --model qwen3:4b`))
      assert.equal(access[0].title, 'SSH')
      assert.equal(access[1].kind, 'admin-login')
      assert.equal(access[2].kind, 'account')
      assert.equal(access.at(-3).kind, 'inference')
      assert.equal(access.at(-3).url, deployment === 'docker' ? 'http://host.docker.internal:11434' : 'http://127.0.0.1:11434')
      assert.equal(access.at(-2).kind, 'enable')
      assert.equal(access.at(-1).kind, 'invite')
      assert.equal(access.some(scene => scene.kind === 'network'), method === 'https')
      // Parse every generated command with Bash without executing installations.
      for (const scene of [...install, ...access]) {
        for (const [command] of scene.commands || []) execFileSync('bash', ['-n', '-c', command])
      }
      if (method === 'https') {
        const command = access.find(scene => scene.title === 'Caddy · HTTPS').commands[0][0]
        assert.ok(command.includes('install-https.sh --domain lab.example.com --public-ip 203.0.113.10'))
      }
    })
  }
}

test('model names cannot inject shell syntax', () => {
  for (const model of ['qwen3:4b', 'namespace/model:tag', 'qwen3:8b']) {
    assert.ok(validGuideParameters({ ...defaultGuideParameters, model }, ['model']))
  }
  for (const model of ['', '-x', 'qwen3;id', '$(id)', 'qwen3\nwhoami', "qwen3'", 'qwen3 model']) {
    assert.equal(validGuideParameters({ ...defaultGuideParameters, model }, ['model']), false)
  }
})


test('HTTPS check uses GET and reports HTTP failures', async () => {
  const methods = []
  let status = 200
  const server = createServer((request, response) => {
    methods.push(request.method)
    response.writeHead(request.method === 'HEAD' ? 405 : status)
    response.end('EasyPaper')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const generated = installationScenes('docker', 'https', defaultGuideParameters)[2]
      .find(scene => scene.title === 'HTTPS').commands[0][0]
    // Only substitute the origin; execute the exact copied curl options.
    const command = generated.replace('https://lab.example.com', `http://127.0.0.1:${server.address().port}`)
    const run = promisify(execFile)
    const success = await run('bash', ['-c', command])
    assert.equal(success.stdout, 'HTTP 200\n')
    status = 503
    await assert.rejects(run('bash', ['-c', command]), error => error.code === 22)
    assert.deepEqual(methods, ['GET', 'GET'])
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('SSH URL reflects the tunnel port but cannot edit it independently', () => {
  const values = { ...defaultGuideParameters, localPort: '19000' }
  const [tunnel, connection] = connectionScenes('ssh', values)[0]
  assert.ok(tunnel.parameters.includes('localPort'))
  assert.ok(tunnel.commands[0][0].includes('-L 127.0.0.1:19000:'))
  assert.equal(connection.copy, 'http://localhost:19000')
  assert.deepEqual(connection.readOnlyParameters, ['localPort'])
  const https = connectionScenes('https', values)[0][0]
  assert.deepEqual(https.parameters, ['domain'])
  assert.deepEqual(https.readOnlyParameters, [])
})
