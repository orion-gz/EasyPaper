import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { defaultGuideParameters, installationScenes, validGuideParameters } from '../src/labGuideFlow.js'

for (const deployment of ['docker', 'systemd']) {
  for (const method of ['ssh', 'https']) {
    test(`${deployment}/${method}: complete setup order and safe shell commands`, () => {
      const [install, choice, access] = installationScenes(deployment, method, defaultGuideParameters)
      assert.deepEqual(choice, [])
      const commands = install.flatMap(scene => scene.commands?.map(([command]) => command) || [])
      assert.ok(commands.some(command => command.includes('ollama.com/install.sh')))
      assert.ok(commands.some(command => command.includes('OLLAMA_HOST=') && command.includes('90-easypaper.conf')))
      assert.ok(commands.some(command => command.includes('systemctl restart ollama')))
      assert.ok(commands.at(-1).includes('ollama pull qwen3:4b'))
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
      const binding = commands.find(command => command.includes('90-easypaper.conf'))
      assert.ok(!binding.includes('0.0.0.0'))
      assert.equal(binding.includes('docker network inspect bridge'), deployment === 'docker')
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
