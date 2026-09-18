// Import this helper and restart IPC before stopping the HTTP sidecar.
export async function applyDesktopUpdate(update, { stopBackend, relaunch, onEvent }) {
  await update.download(onEvent)
  await stopBackend()
  try {
    await update.install()
  } catch (error) {
    // Recover the backend if installation fails after it has been stopped.
    try { await relaunch() } catch (_) { /* caller displays the installation error */ }
    throw error
  }
  await relaunch()
}
