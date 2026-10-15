export const readerPreferenceKey = name => `easypaper_reader_${name}`
export function readerFeatureEnabled(name, storage = localStorage) {
  try { return storage.getItem(readerPreferenceKey(name)) !== 'false' } catch { return true }
}
