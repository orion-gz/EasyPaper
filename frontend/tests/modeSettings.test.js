import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getModeDefaults,
  getModeSetting,
  modeSettingStorageKey,
  setModeSetting,
} from '../src/modeSettings.js'

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries))
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

test('기존 일반 설정을 연구 모드에 승계한다', () => {
  const storage = memoryStorage({
    easypaper_style: 'literal',
    easypaper_ignore_table: 'false',
    easypaper_disable_primer: 'true',
  })

  assert.equal(getModeSetting('style', 'research', storage), 'literal')
  assert.equal(getModeSetting('ignoreTable', 'research', storage), false)
  assert.equal(getModeSetting('disablePrimer', 'research', storage), true)
})

test('일반 문서는 자연스러운 문체와 필요 시 번역을 기본으로 사용한다', () => {
  const defaults = getModeDefaults('general')

  assert.equal(defaults.style, 'natural')
  assert.equal(defaults.translationMode, 'scroll')
  assert.equal(defaults.ignoreTable, false)
})

test('모드별 저장 값이 서로 덮어쓰지 않는다', () => {
  const storage = memoryStorage()
  setModeSetting('style', 'research', 'academic', storage)
  setModeSetting('style', 'general', 'summary', storage)


  assert.equal(storage.getItem(modeSettingStorageKey('style', 'research')), 'academic')
  assert.equal(storage.getItem(modeSettingStorageKey('style', 'general')), 'summary')
  assert.equal(getModeSetting('style', 'research', storage), 'academic')
  assert.equal(getModeSetting('style', 'general', storage), 'summary')
})

test('기존 표시명 언어 설정을 BCP 47 코드로 한 번 이전한다', () => {
  const storage = memoryStorage({ easypaper_target_lang: '한국어' })

  assert.equal(getModeSetting('targetLang', 'research', storage), 'ko')
  assert.equal(storage.getItem(modeSettingStorageKey('targetLang', 'research')), 'ko')
})
