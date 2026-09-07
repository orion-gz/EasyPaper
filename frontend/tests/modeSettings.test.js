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

test('추천 질문 설정은 모드별 불리언 값으로 저장한다', () => {
  const storage = memoryStorage()
  setModeSetting('disableSuggestedQuestions', 'research', true, storage)

  assert.equal(getModeSetting('disableSuggestedQuestions', 'research', storage), true)
  assert.equal(getModeSetting('disableSuggestedQuestions', 'general', storage), false)
})

test('기존 테마 설정은 두 모드의 최초 값으로 승계한다', () => {
  const storage = memoryStorage({
    theme: 'light',
    easypaper_accent_color: '#e0677a',
  })

  assert.equal(getModeSetting('theme', 'research', storage), 'light')
  assert.equal(getModeSetting('theme', 'general', storage), 'light')
  assert.equal(getModeSetting('accentColor', 'research', storage), '#e0677a')
  assert.equal(getModeSetting('accentColor', 'general', storage), '#e0677a')
})

test('일반 문서는 자연스러운 문체와 필요 시 번역을 기본으로 사용한다', () => {
  const defaults = getModeDefaults('general')

  assert.equal(defaults.style, 'natural')
  assert.equal(defaults.translationMode, 'scroll')
  assert.equal(defaults.ignoreTable, false)
  assert.equal(defaults.disableSuggestedQuestions, false)
  assert.equal(defaults.focusModeEnabled, false)
  assert.equal(defaults.focusBlurStrength, 6)
  assert.equal(defaults.focusDimOpacity, 20)
  assert.equal(defaults.focusScale, 104)
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

test('모드별 테마와 강조색이 서로 덮어쓰지 않는다', () => {
  const storage = memoryStorage()
  setModeSetting('theme', 'research', 'light', storage)
  setModeSetting('theme', 'general', 'dark', storage)
  setModeSetting('accentColor', 'research', '#e0677a', storage)
  setModeSetting('accentColor', 'general', '#1c9c6b', storage)

  assert.equal(storage.getItem(modeSettingStorageKey('theme', 'research')), 'light')
  assert.equal(storage.getItem(modeSettingStorageKey('theme', 'general')), 'dark')
  assert.equal(getModeSetting('theme', 'research', storage), 'light')
  assert.equal(getModeSetting('theme', 'general', storage), 'dark')
  assert.equal(getModeSetting('accentColor', 'research', storage), '#e0677a')
  assert.equal(getModeSetting('accentColor', 'general', storage), '#1c9c6b')
})

test('Focus 설정은 모드별로 독립 저장되고 허용 범위로 정규화된다', () => {
  const storage = memoryStorage()
  setModeSetting('focusModeEnabled', 'research', true, storage)
  setModeSetting('focusBlurStrength', 'research', 99, storage)
  setModeSetting('focusDimOpacity', 'research', 23, storage)
  setModeSetting('focusScale', 'general', 90, storage)
  assert.equal(getModeSetting('focusModeEnabled', 'research', storage), true)
  assert.equal(getModeSetting('focusModeEnabled', 'general', storage), false)
  assert.equal(getModeSetting('focusBlurStrength', 'research', storage), 16)
  assert.equal(getModeSetting('focusDimOpacity', 'research', storage), 25)
  assert.equal(getModeSetting('focusScale', 'general', storage), 100)
})
