import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ensureNativePdfDocument,
  getTauriHostWindow,
  isMacNativePdfAvailable,
  renderNativePdfPageToCanvas,
} from '../src/nativePdfPreview.js'

test('getTauriHostWindow and isMacNativePdfAvailable detect macOS Tauri host across document iframe', () => {
  const hostWin = { __TAURI_INTERNALS__: { invoke: () => {} } }
  const iframeWin = {
    top: hostWin,
    parent: hostWin,
    navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' },
  }
  assert.equal(getTauriHostWindow(iframeWin), hostWin)
  assert.equal(isMacNativePdfAvailable(iframeWin), true)
})

test('ensureNativePdfDocument loads document once and renderNativePdfPageToCanvas draws native PNG onto canvas', async () => {
  const calls = []
  class HostArrayBuffer extends ArrayBuffer {}
  class HostUint8Array extends Uint8Array {
    constructor(arg) {
      if (typeof arg === 'number') {
        super(new HostArrayBuffer(arg))
      } else {
        super(arg)
      }
    }
  }

  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const hostWin = {
    Uint8Array: HostUint8Array,
    ArrayBuffer: HostArrayBuffer,
    __TAURI_INTERNALS__: {
      invoke: async (cmd, payload, options) => {
        calls.push({ cmd, payload, options })
        if (options?.headers?.['x-action'] === 'render') {
          return fakePng
        }
        return new Uint8Array(0)
      },
    },
  }

  const iframeWin = {
    top: hostWin,
    parent: hostWin,
    navigator: { platform: 'MacIntel' },
  }

  const originalWindow = globalThis.window
  const originalCreateImageBitmap = globalThis.createImageBitmap
  globalThis.window = iframeWin
  let closedBitmap = false
  globalThis.createImageBitmap = async (blob) => {
    assert.equal(blob.type, 'image/png')
    return {
      width: 1200,
      height: 1600,
      close() { closedBitmap = true },
    }
  }

  try {
    let getDataCalls = 0
    const pdfDoc = {
      fingerprints: ['doc-fingerprint-1'],
      getData: async () => {
        getDataCalls++
        return new Uint8Array([0x25, 0x50, 0x44, 0x46])
      },
    }

    const docKey1 = await ensureNativePdfDocument(pdfDoc)
    const docKey2 = await ensureNativePdfDocument(pdfDoc)
    assert.equal(docKey1, 'doc-fingerprint-1')
    assert.equal(docKey2, 'doc-fingerprint-1')
    assert.equal(getDataCalls, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.headers['x-action'], 'load')
    assert.ok(calls[0].payload instanceof HostArrayBuffer)

    let drawn = false
    const canvas = {
      width: 1200,
      height: 1600,
      dataset: {},
      getContext: () => ({
        save() {},
        setTransform() {},
        clearRect() {},
        drawImage() { drawn = true },
        restore() {},
      }),
    }

    const ok = await renderNativePdfPageToCanvas(pdfDoc, 3, canvas, 1200, 1600, { darkMode: true })
    assert.equal(ok, true)
    assert.equal(drawn, true)
    assert.equal(closedBitmap, true)
    assert.equal(canvas.dataset.nativeRendered, 'true')
    assert.equal(canvas.dataset.nativeDark, 'true')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].options.headers, {
      'x-action': 'render',
      'x-doc-key': 'doc-fingerprint-1',
      'x-page': '3',
      'x-width': '1200',
      'x-height': '1600',
      'x-dark': '1',
    })
  } finally {
    globalThis.window = originalWindow
    globalThis.createImageBitmap = originalCreateImageBitmap
  }
})
