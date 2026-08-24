export async function saveUserLanguagePreferences({ uiLocale, sourceLanguage, targetLanguage }, { saveSettings, storage, setTarget }) {
  storage.setItem('easypaper_default_source_language', sourceLanguage)
  setTarget?.(targetLanguage)
  return saveSettings({ ui_locale: uiLocale, default_source_language: sourceLanguage, target_language: targetLanguage })
}

export async function saveDocumentLanguageOverride(docId, { sourceLanguage, targetLanguage }, patchDocument) {
  if (!docId) throw new Error('A document must be open to save its language override.')
  return patchDocument(docId, { source_language: sourceLanguage, preferred_target_language: targetLanguage })
}
