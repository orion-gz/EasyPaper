import test from 'node:test'
import assert from 'node:assert/strict'
import { saveUserLanguagePreferences, saveDocumentLanguageOverride } from '../src/languagePreferences.js'

test('user defaults do not patch the open document override', async () => {
  const calls = { settings: [], documents: [] }
  const storage = { setItem: (key, value) => calls.storage = [key, value] }
  await saveUserLanguagePreferences({ uiLocale: 'en', sourceLanguage: 'de', targetLanguage: 'fr' }, { storage, saveSettings: async payload => calls.settings.push(payload) })
  assert.deepEqual(calls.settings, [{ ui_locale: 'en', default_source_language: 'de', target_language: 'fr' }])
  assert.deepEqual(calls.documents, [])
})

test('document override does not mutate user defaults', async () => {
  const calls = []
  const result = await saveDocumentLanguageOverride('doc-1', { sourceLanguage: 'ja', targetLanguage: 'ko' }, async (id, payload) => { calls.push([id, payload]); return payload })
  assert.deepEqual(calls, [['doc-1', { source_language: 'ja', preferred_target_language: 'ko' }]])
  assert.equal(result.source_language, 'ja')
})
