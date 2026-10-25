export const readerPreferenceKey = name => `easypaper_reader_${name}`
export function readerFeatureEnabled(name, storage = localStorage) {
  try { return storage.getItem(readerPreferenceKey(name)) !== 'false' } catch { return true }
}

export function getMemoLayoutPreferences(storage = localStorage) {
  const read = (name, values, fallback) => {
    try { const value = storage.getItem(readerPreferenceKey(name)); return values.includes(value) ? value : fallback } catch { return fallback }
  }
  return {
    rightPosition: read('memoRightPosition', ['outside', 'between'], 'outside'),
    overflow: read('memoOverflow', ['expand', 'scroll'], 'expand'),
  }
}
