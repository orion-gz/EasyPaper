import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDesktopUpdate } from '../src/desktopUpdate.js'

function scenario(failure) {
  const calls = []
  const step = name => async () => {
    calls.push(name)
    if (failure === name) throw new Error(name)
  }
  return {
    calls,
    update: { download: step('download'), install: step('install') },
    options: { stopBackend: step('stop'), relaunch: step('relaunch') },
  }
}
test('download failure keeps the backend running', async () => {
  const s = scenario('download')
  await assert.rejects(applyDesktopUpdate(s.update, s.options), /download/)
  assert.deepEqual(s.calls, ['download'])
})
test('install waits for confirmed backend shutdown', async () => {
  const s = scenario('stop')
  await assert.rejects(applyDesktopUpdate(s.update, s.options), /stop/)
  assert.deepEqual(s.calls, ['download', 'stop'])
})
test('installation failure restarts the app to recover the backend', async () => {
  const s = scenario('install')
  await assert.rejects(applyDesktopUpdate(s.update, s.options), /install/)
  assert.deepEqual(s.calls, ['download', 'stop', 'install', 'relaunch'])
})
test('successful update stops the backend only after download', async () => {
  const s = scenario()
  await applyDesktopUpdate(s.update, s.options)
  assert.deepEqual(s.calls, ['download', 'stop', 'install', 'relaunch'])
})
