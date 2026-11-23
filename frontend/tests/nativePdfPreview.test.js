import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computePdfColumnViewportRect,
  getTauriHostWindow,
  isMacNativePdfAvailable,
  mountNativePdf,
  syncNativePdfAnnotations,
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

test('mountNativePdf bounds PDFView to left PDF column and bridges page/selection/annotations', async () => {
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
    getBoundingClientRect: () => ({ x: 50, y: 40, width: 1600, height: 900 }),
  }

  const iframeWin = {
    top: hostWin,
    parent: hostWin,
    frameElement: frameEl,
    innerWidth: 1600,
    innerHeight: 900,
    getComputedStyle: () => ({ display: 'flex' }),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  }

  const firstPdfWrapper = {
    getBoundingClientRect: () => ({ left: 80, right: 780, top: 60, width: 700, height: 900 }),
  }
  const firstTransBlock = {
    getBoundingClientRect: () => ({ left: 820, right: 1440, top: 60, width: 620, height: 900 }),
  }
  const firstPair = {
    querySelector: (sel) => {
      if (sel === '.pdf-page-wrapper') return firstPdfWrapper
      if (sel === '.trans-page-block') return firstTransBlock
      return null
    },
  }

  const doc = {
    defaultView: iframeWin,
    body: {
      dataset: {},
      classList: { add() {}, remove() {} },
    },
    getElementById: () => null,
    querySelector: () => null,
  }

  const container = {
    dataset: {},
    ownerDocument: doc,
    getBoundingClientRect: () => ({ left: 20, right: 1550, top: 60, width: 1530, height: 840 }),
    querySelector: (sel) => {
      if (sel === '.page-pair') return firstPair
      if (sel === '.pdf-page-wrapper') return firstPdfWrapper
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const originalWindow = globalThis.window
  const originalResizeObserver = globalThis.ResizeObserver
  const originalMutationObserver = globalThis.MutationObserver
  globalThis.window = iframeWin
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }

  try {
    const colRect = computePdfColumnViewportRect(container)
    // Left PDF wrapper (80..780) + 8px padding = (72..788), offset by frame (x:50, y:40) => x:122, y:100, width:716, height:840
    assert.deepEqual(colRect, { x: 122, y: 100, width: 716, height: 840 })

    let reportedPage = null
    let reportedSelection = null
    const pdfDoc = {
      getData: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }

    const dispose = await mountNativePdf(container, pdfDoc, () => true, {
      onNativePageChange(p) { reportedPage = p },
      onNativeSelectionChange(sel) { reportedSelection = sel },
    })

    assert.equal(container.dataset.nativePdf, 'mounted')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.headers['x-left'], '122')
    assert.equal(calls[0].options.headers['x-width'], '716')

    // Native PDFView event bridge
    hostWin.__easypaperNativePdfDispatch({ type: 'page', page: 5 })
    assert.equal(reportedPage, 5)

    hostWin.__easypaperNativePdfDispatch({
      type: 'selection',
      empty: false,
      page: 5,
      text: 'Transformer architecture',
      startOffset: 10,
      endOffset: 34,
      rect: { left: 250, top: 340, width: 180, height: 22 },
    })
    assert.equal(reportedSelection.page, 5)
    assert.equal(reportedSelection.text, 'Transformer architecture')
    assert.equal(reportedSelection.rect.left, 200)
    assert.equal(reportedSelection.rect.top, 300)

    syncNativePdfAnnotations({ page_5: [{ type: 'highlight', text: 'Transformer', color: '#eab308' }] }, {})
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(calls.length, 2)
    assert.equal(calls[1].options.headers['x-action'], 'annotations')

    await dispose()
    assert.equal(calls.length, 3)
    assert.equal(calls[2].options.headers['x-close'], '1')
  } finally {
    globalThis.window = originalWindow
    globalThis.ResizeObserver = originalResizeObserver
    globalThis.MutationObserver = originalMutationObserver
  }
})
