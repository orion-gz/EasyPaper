import assert from 'node:assert/strict'
import test from 'node:test'
import { getTauriHostWindow, mountNativePdf } from '../src/nativePdfPreview.js'

test('getTauriHostWindow resolves Tauri internals from parent/top window when running inside document iframe', () => {
  const hostWin = { __TAURI_INTERNALS__: { invoke: () => {} } }
  const iframeWin = { top: hostWin, parent: hostWin }
  assert.equal(getTauriHostWindow(iframeWin), hostWin)
})

test('mountNativePdf invokes top-level Tauri IPC with host Uint8Array and iframe-offset coordinates', async () => {
  const calls = []
  class HostArrayBuffer extends ArrayBuffer {}
  class HostUint8Array extends Uint8Array {}

  const hostWin = {
    Uint8Array: HostUint8Array,
    ArrayBuffer: HostArrayBuffer,
    __TAURI_INTERNALS__: {
      invoke: async (cmd, payload, options) => {
        calls.push({ cmd, payload, options })
      },
    },
  }

  const frameEl = {
    ownerDocument: { defaultView: hostWin },
    getBoundingClientRect: () => ({ x: 60, y: 48, width: 1200, height: 800 }),
  }

  const iframeWin = {
    top: hostWin,
    parent: hostWin,
    frameElement: frameEl,
    innerWidth: 1200,
    innerHeight: 800,
  }

  const originalWindow = globalThis.window
  const originalResizeObserver = globalThis.ResizeObserver
  let resizeCallback = null
  globalThis.window = iframeWin
  globalThis.ResizeObserver = class {
    constructor(cb) { resizeCallback = cb }
    observe() {}
    disconnect() {}
  }

  try {
    const container = {
      dataset: {},
      ownerDocument: { defaultView: iframeWin },
      getBoundingClientRect: () => ({ x: 20, y: 30, width: 500, height: 700 }),
    }
    const pdfDoc = {
      getData: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }

    const dispose = await mountNativePdf(container, pdfDoc, () => true)
    assert.equal(container.dataset.nativePdf, 'mounted')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].cmd, 'native_pdf')
    assert.ok(calls[0].payload instanceof HostUint8Array)
    assert.deepEqual([...calls[0].payload], [0x25, 0x50, 0x44, 0x46])
    assert.deepEqual(calls[0].options.headers, {
      'x-left': '80',
      'x-top': '78',
      'x-width': '500',
      'x-height': '700',
    })

    resizeCallback?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(calls.length, 2)
    assert.equal(calls[1].payload.byteLength, 0)

    await dispose()
    assert.equal(container.dataset.nativePdf, undefined)
    assert.equal(calls.length, 3)
    assert.equal(calls[2].options.headers['x-close'], '1')

    // A stale dispose from an older renderScrollView generation must not send x-close
    // after a newer mountNativePdf call (e.g. triggered by Fit Width) has superseded it.
    let resolveFirstData
    const slowDoc = {
      getData: () => new Promise(resolve => { resolveFirstData = resolve }),
    }
    let firstActive = true
    const firstMountPromise = mountNativePdf(container, slowDoc, () => firstActive)
    firstActive = false
    const secondDispose = await mountNativePdf(container, pdfDoc, () => true)
    resolveFirstData(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    const firstDispose = await firstMountPromise
    assert.equal(firstDispose, null)
    assert.equal(container.dataset.nativePdf, 'mounted')
    const closeCalls = calls.filter(c => c.options.headers['x-close'] === '1')
    assert.equal(closeCalls.length, 1)
    await secondDispose()
    assert.equal(calls.filter(c => c.options.headers['x-close'] === '1').length, 2)
  } finally {
    globalThis.window = originalWindow
    globalThis.ResizeObserver = originalResizeObserver
  }
})
