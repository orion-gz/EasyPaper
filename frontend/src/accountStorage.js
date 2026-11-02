// Keep browser-only drafts/preferences separate on a shared server origin.
// Archives live outside localStorage so user-data export cannot include another
// account's retired browser state. Authentication cookies are never copied.
const marker = '__easypaper_active_account'
const owned = key => key.startsWith('easypaper_')
let activeAccount = null

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('easypaper-account-storage', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('accounts')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function activateAccountStorage(account) {
  if (!account) return false // Backward-compatible servers have no stable ID.
  const previous = localStorage.getItem(marker)
  if (!previous || previous === account) {
    localStorage.setItem(marker, account)
    activeAccount = account
    return false
  }
  const db = await database()
  let restored
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('accounts', 'readwrite')
      const store = transaction.objectStore('accounts')
      const current = Object.fromEntries(Object.keys(localStorage).filter(owned).map(key => [key, localStorage.getItem(key)]))
      store.put(current, previous)
      const request = store.get(account)
      request.onsuccess = () => { restored = request.result || {} }
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    // Snapshot persisted before any browser state is removed.
    for (const key of Object.keys(localStorage).filter(owned)) localStorage.removeItem(key)
    for (const [key, value] of Object.entries(restored)) if (owned(key) && typeof value === 'string') localStorage.setItem(key, value)
    sessionStorage.clear()
    activeAccount = account
    localStorage.setItem(marker, account)
    return true
  } finally {
    db.close()
  }
}

window.addEventListener('storage', event => {
  if (event.key === marker && activeAccount && event.newValue !== activeAccount) location.reload()
})
