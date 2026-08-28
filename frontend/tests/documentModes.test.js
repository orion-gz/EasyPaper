import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultDocumentType,
  documentTypeLabel,
  getDocumentTypes,
  isWorkspaceModeAvailable,
  loadDocumentTypeOptions,
  normalizeWorkspaceMode,
  saveDocumentTypeOptions,
  storeWorkspaceMode,
  WORKSPACE_PURPOSE_SELECTED_KEY,
} from '../src/documentModes.js'
import { parseStructuredVocabulary, renderStructuredVocabulary } from '../src/vocabularyView.js'


function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}


test('workspace mode only accepts research or general', () => {
  assert.equal(normalizeWorkspaceMode('general'), 'general')
  assert.equal(normalizeWorkspaceMode('unexpected'), 'research')
  const storage = memoryStorage()
  assert.equal(storeWorkspaceMode('general', storage), 'general')
  assert.equal(storage.getItem('easypaper_workspace_mode'), 'general')
})


test('document types use registry and safe fallback', () => {
  const registry = { modes: [{ value: 'general', types: [{ value: 'manual', label: '매뉴얼' }] }] }
  assert.deepEqual(getDocumentTypes(registry, 'general'), [{ value: 'manual', label: '매뉴얼' }])
  assert.equal(documentTypeLabel(registry, 'general', 'manual'), '매뉴얼')
  assert.equal(defaultDocumentType('research'), 'research_paper')
  assert.ok(getDocumentTypes(null, 'general').some(item => item.value === 'technical'))
  const fallbackTypes = getDocumentTypes(null, 'general')
  assert.equal(fallbackTypes.length, 10)
  assert.ok(fallbackTypes.some(item => item.value === 'academic_book'))
  assert.ok(!fallbackTypes.some(item => item.value === 'book'))
  assert.equal(documentTypeLabel(null, 'general', 'book'), '책(재분류 필요)')
})


test('upload options are isolated by document type', () => {
  const storage = memoryStorage()
  saveDocumentTypeOptions('manual', { ignoreTable: false }, storage)
  saveDocumentTypeOptions('book', { style: 'literal' }, storage)
  const all = loadDocumentTypeOptions(storage)
  assert.deepEqual(all.manual, { ignoreTable: false })
  assert.deepEqual(all.book, { style: 'literal' })
})


test('structured vocabulary keeps location metadata and non-English notice', () => {
  const parsed = parseStructuredVocabulary(JSON.stringify({
    advanced_words: [{ term: 'ubiquitous', meaning: '편재하는', level: 'GRE', page_num: 7, char_start: 12, char_end: 22, occurrence: 2 }],
    technical_terms: [],
  }))
  assert.equal(parsed.advanced_words[0].page_num, 7)
  const html = renderStructuredVocabulary(parsed)
  assert.match(html, /data-page-num="7"/)
  assert.match(html, /data-char-start="12"/)
  const noticeHtml = renderStructuredVocabulary({
    advanced_words: [], technical_terms: [], advanced_words_notice: '영어 원문이 아닙니다.',
  })
  assert.match(noticeHtml, /영어 원문이 아닙니다/)
})


test('server rollout can disable general workspace mode', () => {
  assert.equal(isWorkspaceModeAvailable({ rollout: { general_document_mode: false } }, 'general'), false)
  assert.equal(isWorkspaceModeAvailable({ rollout: { general_document_mode: true } }, 'general'), true)
  assert.equal(isWorkspaceModeAvailable(null, 'research'), true)
})
