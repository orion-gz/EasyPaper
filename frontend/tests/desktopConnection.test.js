import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/desktopConnection.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '')
  .replace(/^export /gm, '')

function element() {
  return {
    children: [], textContent: '',
    append(...nodes) { this.children.push(...nodes) },
    prepend(node) { this.children.unshift(node) },
    replaceChildren(...nodes) { this.children = nodes },
  }
}

for (const readyState of ['loading', 'interactive', 'complete']) {
  test(`web device panel renders when document is ${readyState}`, async () => {
    const target = element()
    const listeners = new Map()
    const requests = []
    const timers = []
    const window = { addEventListener(name, callback, options) { listeners.set(name, { callback, options }) } }
    window.parent = window
    const context = vm.createContext({
      window,
      document: {
        readyState,
        addEventListener(name, callback, options) { listeners.set(name, { callback, options }) },
        getElementById(id) { assert.equal(id, 'tab-data-system'); return target },
        createElement: element,
      },
      initI18n: async () => {}, loadNamespaces: async () => {}, t: key => key,
      setTimeout(callback, delay) { timers.push({ callback, delay }) },
      fetch: async (url, options) => {
        requests.push({ url, options })
        return { ok: true, json: async () => ({ devices: [{
          id: 'desktop-1', name: 'My Desktop', online: true, status: 'idle',
          action: 'merge', automatic: true, seen: 1, requested: false,
        }] }) }
      },
    })
    vm.runInContext(source, context)
    assert.equal(await context.prepareDesktopConnection(), true)
    if (readyState === 'loading') {
      assert.equal(requests.length, 0)
      const listener = listeners.get('DOMContentLoaded')
      assert.equal(listener.options.once, true)
      await listener.callback()
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/api/user-data/devices')
    const row = target.children[0].children[0]
    assert.equal(row.children[0].textContent, 'My Desktop')
    assert.equal(row.children[3].disabled, false)
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 15000)
  })
}
