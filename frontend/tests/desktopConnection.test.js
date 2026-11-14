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

for (const action of ['replace_local', 'replace_remote']) {
  test(`offline conflict preview respects ${action} without auto-confirming`, async () => {
    const nodes = new Map()
    const node = selector => {
      if (!nodes.has(selector)) nodes.set(selector, {
        value: '', checked: false, dataset: {}, hidden: false, textContent: '',
        setAttribute() {}, focus() {},
      })
      return nodes.get(selector)
    }
    node('[data-action]').value = action
    node('[data-url]').value = 'https://server.example'
    node('[value=remote]').checked = true
    const calls = []
    const context = vm.createContext({
      t: key => key,
      fakeDialog: { querySelector: node, querySelectorAll: () => [] },
      request: async (path, options) => {
        const body = JSON.parse(options.body)
        calls.push({ path, body })
        return path === 'connection'
          ? { enabled: true, remote: true, access_mode: 'offline', server_url: 'https://server.example', sync: body.sync }
          : { plan_id: 'confirmed-preview', action, local_documents: 2, remote_documents: 2 }
      },
    })
    vm.runInContext(source, context)
    vm.runInContext(`
      connection = { enabled: true, remote: true, access_mode: 'offline', server_url: 'https://server.example', sync: { automatic: false } };
      dialog = fakeDialog;
      connectionRequest = request;
    `, context)
    await context.prepareSync(false)
    assert.deepEqual(calls.map(call => call.path), ['connection', 'sync/preview'])
    assert.equal(calls[1].body.action, action)
    assert.equal(node('[data-preview]').dataset.destructive, 'true')
    assert.equal(node('[data-preview-warning]').textContent, 'desktop:offlineResolveHelp')
  })
}

 test('unsaved connection changes block synchronization before any request', async () => {
  const status = { dataset: {} }
  const context = vm.createContext({ t: key => key, fakeDialog: { querySelector: selector => selector === '[data-status]' ? status : { value: 'merge' } } })
  vm.runInContext(source, context)
  vm.runInContext(`dialog = fakeDialog; connectionDirty = true; connectionRequest = () => { throw Error('must not send') };`, context)
  await context.prepareSync()
  assert.equal(status.textContent, 'desktop:saveAddressFirst')
})
