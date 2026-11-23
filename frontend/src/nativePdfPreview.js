// Serialize mount and teardown when switching documents or tabs.
let queue = Promise.resolve()

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

function getViewportRect(container) {
  const local = container.getBoundingClientRect()
  let x = local.x
  let y = local.y
  let width = local.width
  let height = local.height

  // Document tabs run inside an iframe (.workspace-document-frame) that may also
  // have CSS zoom applied. Map the container rect into the top-level WKWebView's
  // coordinate space so PDFView.frame aligns with the visible container.
  try {
    let currentWin = container.ownerDocument?.defaultView || window
    while (currentWin && currentWin.frameElement) {
      const frameEl = currentWin.frameElement
      const frameRect = frameEl.getBoundingClientRect()
      const scaleX = currentWin.innerWidth ? frameRect.width / currentWin.innerWidth : 1
      const scaleY = currentWin.innerHeight ? frameRect.height / currentWin.innerHeight : 1
      x = frameRect.x + x * scaleX
      y = frameRect.y + y * scaleY
      width *= scaleX
      height *= scaleY
      currentWin = frameEl.ownerDocument?.defaultView
    }
  } catch {}

  return { x, y, width, height }
}

function toHostBytes(hostWin, bytes) {
  const HostUint8Array = hostWin?.Uint8Array || Uint8Array
  if (!bytes || !bytes.byteLength) return new HostUint8Array(0)
  if (bytes instanceof HostUint8Array) return bytes
  if (bytes.buffer instanceof (hostWin?.ArrayBuffer || ArrayBuffer)) {
    return new HostUint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength)
  }
  const copy = new HostUint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

async function update(rect, bytes, close = false) {
  const hostWin = getTauriHostWindow()
  const invoke = hostWin?.__TAURI_INTERNALS__?.invoke
    ? (cmd, args, options) => hostWin.__TAURI_INTERNALS__.invoke(cmd, args, options)
    : (await import('@tauri-apps/api/core')).invoke
  const headers = {
    'x-left': String(rect.x), 'x-top': String(rect.y),
    'x-width': String(rect.width), 'x-height': String(rect.height),
  }
  if (close) headers['x-close'] = '1'
  const payload = toHostBytes(hostWin, bytes)
  const task = queue.then(() => invoke('native_pdf', payload, { headers }))
  queue = task.catch(() => {})
  return task
}

export async function mountNativePdf(container, document, current) {
  const bytes = await document.getData()
  if (!current()) return null
  const rect = () => getViewportRect(container)
  await update(rect(), bytes)
  container.dataset.nativePdf = 'mounted'
  const observer = new ResizeObserver(() => {
    if (current()) update(rect(), null).catch(console.error)
  })
  observer.observe(container)
  return () => {
    observer.disconnect()
    delete container.dataset.nativePdf
    return update(rect(), null, true)
  }
}

