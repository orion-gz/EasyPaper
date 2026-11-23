// macOS native PDFKit page rasterizer via Tauri IPC.
// Keeps EasyPaper's DOM/translation/annotation/memo layout intact while offloading
// PDF page rasterization (and dark-mode pixel inversion) to macOS PDFKit + CoreGraphics.

const loadedDocuments = new WeakMap()
let nextDocId = 1

export function getTauriHostWindow(win = window) {
  if (win?.__TAURI_INTERNALS__?.invoke) return win
  try {
    if (win?.top && win.top !== win && win.top.__TAURI_INTERNALS__?.invoke) return win.top
  } catch {}
  try {
    if (win?.parent && win.parent !== win && win.parent.__TAURI_INTERNALS__?.invoke) return win.parent
  } catch {}
  return null
}

export function isMacNativePdfAvailable(win = window) {
  const nav = win?.navigator || globalThis.navigator
  return Boolean(
    getTauriHostWindow(win) &&
    nav &&
    (/Mac/.test(nav.platform || '') || /Macintosh|Mac OS X/.test(nav.userAgent || ''))
  )
}

function toHostArrayBuffer(hostWin, bytes) {
  const HostArrayBuffer = hostWin?.ArrayBuffer || ArrayBuffer
  const HostUint8Array = hostWin?.Uint8Array || Uint8Array
  if (!bytes || !bytes.byteLength) return new HostArrayBuffer(0)
  const copy = new HostUint8Array(bytes.byteLength)
  copy.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  return copy.buffer
}

async function tauriInvoke(cmd, payload, options) {
  const hostWin = getTauriHostWindow()
  if (hostWin?.__TAURI_INTERNALS__?.invoke) {
    return hostWin.__TAURI_INTERNALS__.invoke(cmd, payload, options)
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(cmd, payload, options)
}

export async function ensureNativePdfDocument(pdfDoc) {
  if (!pdfDoc) throw new Error('No PDF document')
  let state = loadedDocuments.get(pdfDoc)
  if (state?.promise) return state.promise

  const docKey = pdfDoc.fingerprints?.[0] || `ep_doc_${nextDocId++}`
  const promise = (async () => {
    const hostWin = getTauriHostWindow()
    const bytes = await pdfDoc.getData()
    const payload = toHostArrayBuffer(hostWin, bytes)
    await tauriInvoke('native_pdf', payload, {
      headers: {
        'x-action': 'load',
        'x-doc-key': String(docKey),
      },
    })
    return docKey
  })()

  state = { docKey, promise }
  loadedDocuments.set(pdfDoc, state)
  try {
    return await promise
  } catch (err) {
    loadedDocuments.delete(pdfDoc)
    throw err
  }
}

function toUint8Array(raw) {
  if (!raw) return null
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer || (raw.byteLength !== undefined && raw.slice)) {
    return new Uint8Array(raw)
  }
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }
  if (Array.isArray(raw)) {
    return new Uint8Array(raw)
  }
  return null
}

export async function renderNativePdfPageToCanvas(pdfDoc, pageNum, canvas, pixelWidth, pixelHeight, { darkMode = false, signal } = {}) {
  const docKey = await ensureNativePdfDocument(pdfDoc)
  if (signal?.aborted) return false
  const hostWin = getTauriHostWindow()
  const emptyPayload = toHostArrayBuffer(hostWin, null)
  const w = Math.max(1, Math.min(4096, Math.floor(pixelWidth)))
  const h = Math.max(1, Math.min(4096, Math.floor(pixelHeight)))
  const raw = await tauriInvoke('native_pdf', emptyPayload, {
    headers: {
      'x-action': 'render',
      'x-doc-key': String(docKey),
      'x-page': String(pageNum),
      'x-width': String(w),
      'x-height': String(h),
      'x-dark': darkMode ? '1' : '0',
    },
  })
  if (signal?.aborted) return false
  const pngBytes = toUint8Array(raw)
  if (!pngBytes || !pngBytes.byteLength) {
    throw new Error('Empty PNG response from native_pdf')
  }

  const blob = new Blob([pngBytes], { type: 'image/png' })
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    try {
      if (signal?.aborted) return false
      const ctx = canvas.getContext('2d')
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      ctx.restore()
    } finally {
      bitmap.close?.()
    }
  } else {
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      await img.decode()
      if (signal?.aborted) return false
      const ctx = canvas.getContext('2d')
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      ctx.restore()
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  canvas.dataset.nativeRendered = 'true'
  if (darkMode) {
    canvas.dataset.nativeDark = 'true'
  } else {
    delete canvas.dataset.nativeDark
  }
  return true
}



