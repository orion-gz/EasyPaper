// Serialize mount and teardown when switching documents or tabs.
let queue = Promise.resolve()
async function update(rect, bytes, close = false) {
  const { invoke } = await import('@tauri-apps/api/core')
  const headers = {
    'x-left': String(rect.x), 'x-top': String(rect.y),
    'x-width': String(rect.width), 'x-height': String(rect.height),
  }
  if (close) headers['x-close'] = '1'
  const task = queue.then(() => invoke('native_pdf', bytes, { headers }))
  queue = task.catch(() => {})
  return task
}

export async function mountNativePdf(container, document, current) {
  const bytes = await document.getData()
  if (!current()) return null
  const rect = () => container.getBoundingClientRect()
  await update(rect(), bytes)
  const observer = new ResizeObserver(() => {
    if (current()) update(rect(), new Uint8Array()).catch(console.error)
  })
  observer.observe(container)
  return () => {
    observer.disconnect()
    return update(rect(), new Uint8Array(), true)
  }
}
