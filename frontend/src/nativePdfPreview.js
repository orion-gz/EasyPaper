// Hybrid macOS native PDFView controller.
// Places a 120Hz native AppKit PDFView over ONLY the left PDF source column while
// leaving the right translation column, sidebars, topbar, floating nav, and memo cards
// visible in the web DOM. Bridges scroll/page changes, text selection, and annotations.

let queue = Promise.resolve()
let activeMountId = 0
let mountedDocument = null
let activeController = null

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

function mapLocalRectToHost(localRect, win = window) {
  let x = localRect.x ?? localRect.left ?? 0
  let y = localRect.y ?? localRect.top ?? 0
  let width = localRect.width ?? 0
  let height = localRect.height ?? 0
  try {
    let currentWin = win
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

function mapHostRectToLocal(hostRect, win = window) {
  let left = hostRect.left ?? hostRect.x ?? 0
  let top = hostRect.top ?? hostRect.y ?? 0
  let width = hostRect.width ?? 0
  let height = hostRect.height ?? 0
  try {
    const chain = []
    let currentWin = win
    while (currentWin && currentWin.frameElement) {
      chain.unshift({ win: currentWin, frameEl: currentWin.frameElement })
      currentWin = currentWin.frameElement.ownerDocument?.defaultView
    }
    for (const { win: childWin, frameEl } of chain) {
      const frameRect = frameEl.getBoundingClientRect()
      const scaleX = childWin.innerWidth ? frameRect.width / childWin.innerWidth : 1
      const scaleY = childWin.innerHeight ? frameRect.height / childWin.innerHeight : 1
      left = (left - frameRect.x) / (scaleX || 1)
      top = (top - frameRect.y) / (scaleY || 1)
      width /= (scaleX || 1)
      height /= (scaleY || 1)
    }
  } catch {}
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  }
}

export function computePdfColumnViewportRect(container) {
  const containerRect = container.getBoundingClientRect()
  const doc = container.ownerDocument || document
  const win = doc.defaultView || window

  let left = containerRect.left
  let right = containerRect.right
  const top = containerRect.top
  const height = containerRect.height

  // Only cover the left PDF column so the right translation column (.trans-page-block)
  // and floating controls stay completely uncovered and interactive.
  const firstPair = container.querySelector('.page-pair')
  const firstPdfWrapper = firstPair?.querySelector('.pdf-page-wrapper') || container.querySelector('.pdf-page-wrapper')
  const firstTransBlock = firstPair?.querySelector('.trans-page-block')

  if (firstPdfWrapper) {
    const pdfRect = firstPdfWrapper.getBoundingClientRect()
    if (pdfRect.width > 40) {
      left = Math.max(containerRect.left, pdfRect.left - 8)
      right = Math.min(containerRect.right, pdfRect.right + 8)
    }
  }
  if (firstTransBlock && win.getComputedStyle?.(firstTransBlock).display !== 'none') {
    const transRect = firstTransBlock.getBoundingClientRect()
    if (transRect.width > 40 && transRect.left > left + 120) {
      right = Math.min(right, transRect.left - 8)
    }
  }

  // Also respect outline sidebar on the left and chat/notes sidebar on the right.
  const outlineSidebar = doc.getElementById('outline-sidebar')
  if (outlineSidebar && !outlineSidebar.classList.contains('hidden')) {
    const oRect = outlineSidebar.getBoundingClientRect()
    if (oRect.width > 0 && oRect.right > left) {
      left = Math.max(left, oRect.right + 4)
    }
  }
  const chatSidebar = doc.getElementById('chat-sidebar')
  if (chatSidebar && !chatSidebar.classList.contains('hidden')) {
    const cRect = chatSidebar.getBoundingClientRect()
    if (cRect.width > 0 && cRect.left < right) {
      right = Math.min(right, cRect.left - 4)
    }
  }

  const width = Math.max(0, right - left)
  return mapLocalRectToHost({ x: left, y: top, width, height }, win)
}

function hasBlockingOverlayOpen(container) {
  const doc = container.ownerDocument || document
  if (doc.body?.dataset?.workspaceInactive === 'true' || doc.hidden) return true
  if (doc.querySelector('dialog[open], .modal-overlay:not(.hidden), #selection-menu:not(.hidden), #ann-hover-tooltip:not(.hidden), .document-search:not([hidden])')) {
    return true
  }
  try {
    const hostDoc = getTauriHostWindow(doc.defaultView || window)?.document
    if (hostDoc && hostDoc !== doc) {
      if (hostDoc.querySelector('dialog[open], .modal-overlay:not(.hidden)')) return true
    }
  } catch {}
  return false
}

async function sendNativePdfCommand(options = {}) {
  const hostWin = getTauriHostWindow()
  const invoke = hostWin?.__TAURI_INTERNALS__?.invoke
    ? (cmd, args, opts) => hostWin.__TAURI_INTERNALS__.invoke(cmd, args, opts)
    : (await import('@tauri-apps/api/core')).invoke

  const rect = options.rect || { x: 0, y: 0, width: 0, height: 0 }
  const headers = {
    'x-left': String(rect.x || 0),
    'x-top': String(rect.y || 0),
    'x-width': String(rect.width || 0),
    'x-height': String(rect.height || 0),
    'x-action': String(options.action || 'update'),
  }
  if (options.close) headers['x-close'] = '1'
  if (options.hidden) headers['x-hidden'] = '1'
  if (options.page) headers['x-page'] = String(options.page)

  const payload = toHostArrayBuffer(hostWin, options.bytes)
  const task = queue.then(() => invoke('native_pdf', payload, { headers }))
  queue = task.catch(() => {})
  return task
}

export function isNativePdfMounted() {
  return Boolean(activeController)
}

export function goToNativePdfPage(pageNum) {
  if (!activeController || !Number.isInteger(pageNum) || pageNum < 1) return false
  activeController.goToPage(pageNum)
  return true
}

export function syncNativePdfAnnotations(annotations = {}, memos = {}) {
  if (!activeController) return
  activeController.syncAnnotations(annotations, memos)
}

export function clearNativePdfSelection() {
  if (!activeController) return
  sendNativePdfCommand({ action: 'clear_selection' }).catch(() => {})
}

export async function mountNativePdf(container, pdfDoc, current, callbacks = {}) {
  const mountId = ++activeMountId
  const isLatest = () => mountId === activeMountId && current()
  const needsBytes = mountedDocument !== pdfDoc
  const bytes = needsBytes ? await pdfDoc.getData() : null
  if (!isLatest()) return null

  const doc = container.ownerDocument || document
  const win = doc.defaultView || window
  const hostWin = getTauriHostWindow(win)

  const rect = () => computePdfColumnViewportRect(container)
  const isHidden = () => hasBlockingOverlayOpen(container)

  await sendNativePdfCommand({
    rect: rect(),
    bytes,
    hidden: isHidden(),
  })
  mountedDocument = pdfDoc
  if (!isLatest()) return null

  container.dataset.nativePdf = 'mounted'
  doc.body?.classList.add('macos-native-pdf-split')

  const refreshLayout = () => {
    if (!isLatest() || mountedDocument !== pdfDoc) return
    sendNativePdfCommand({
      rect: rect(),
      hidden: isHidden(),
    }).catch(console.error)
  }

  // Register event bridge on top-level host window so Objective-C evaluateJavaScript
  // reaches the active document tab iframe.
  const handleNativeEvent = (event) => {
    if (!isLatest() || !event) return
    if (event.type === 'page' && Number.isInteger(event.page)) {
      callbacks.onNativePageChange?.(event.page)
    } else if (event.type === 'selection') {
      if (event.empty) {
        callbacks.onNativeSelectionChange?.(null)
      } else {
        const localRect = mapHostRectToLocal(event.rect || {}, win)
        callbacks.onNativeSelectionChange?.({
          page: event.page,
          text: event.text || '',
          startOffset: typeof event.startOffset === 'number' && event.startOffset >= 0 ? event.startOffset : null,
          endOffset: typeof event.endOffset === 'number' && event.endOffset > 0 ? event.endOffset : null,
          rect: localRect,
        })
      }
    }
  }

  if (hostWin) {
    hostWin.__easypaperNativePdfDispatch = handleNativeEvent
  }
  win.__easypaperNativePdfDispatch = handleNativeEvent

  const resizeObserver = new ResizeObserver(refreshLayout)
  resizeObserver.observe(container)
  const firstPair = container.querySelector('.page-pair')
  if (firstPair) resizeObserver.observe(firstPair)

  const mutationObserver = new MutationObserver(refreshLayout)
  if (doc.body) {
    mutationObserver.observe(doc.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['class', 'hidden', 'open', 'style', 'data-workspace-inactive'],
    })
  }
  const onScroll = () => refreshLayout()
  container.addEventListener('scroll', onScroll, { passive: true })
  win.addEventListener('resize', refreshLayout)

  const controller = {
    goToPage(pageNum) {
      if (!isLatest()) return
      sendNativePdfCommand({
        rect: rect(),
        hidden: isHidden(),
        page: pageNum,
      }).catch(console.error)
    },
    syncAnnotations(annotations, memos) {
      if (!isLatest()) return
      try {
        const json = JSON.stringify({ annotations: annotations || {}, memos: memos || {} })
        const encoded = new TextEncoder().encode(json)
        sendNativePdfCommand({
          action: 'annotations',
          bytes: encoded,
        }).catch(console.error)
      } catch (e) {
        console.warn('Failed to sync native PDF annotations:', e)
      }
    },
    refreshLayout,
  }
  activeController = controller

  // Ask main.js to push initial annotations & memos into native PDFKit
  win.dispatchEvent(new CustomEvent('easypaper:native-pdf-mounted'))

  return () => {
    resizeObserver.disconnect()
    mutationObserver.disconnect()
    container.removeEventListener('scroll', onScroll)
    win.removeEventListener('resize', refreshLayout)
    if (activeController === controller) activeController = null
    if (mountId !== activeMountId) return Promise.resolve()
    mountedDocument = null
    delete container.dataset.nativePdf
    doc.body?.classList.remove('macos-native-pdf-split')
    if (hostWin?.__easypaperNativePdfDispatch === handleNativeEvent) {
      delete hostWin.__easypaperNativePdfDispatch
    }
    return sendNativePdfCommand({ close: true })
  }
}




