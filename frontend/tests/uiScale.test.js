import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_UI_SCALE, UI_SCALE_STORAGE_KEY, applyUiScale, loadUiScale, normalizeUiScale, saveUiScale, syncUiScaleControl } from '../src/uiScale.js'

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries))
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

test('지원하는 UI 배율만 허용한다', () => {
  assert.equal(normalizeUiScale('0.8'), 0.8)
  assert.equal(normalizeUiScale('1.25'), 1.25)
  assert.equal(normalizeUiScale('1.5'), DEFAULT_UI_SCALE)
  assert.equal(normalizeUiScale('invalid'), DEFAULT_UI_SCALE)
})

test('저장된 UI 배율을 불러오고 정규화해 저장한다', () => {
  const storage = memoryStorage({ [UI_SCALE_STORAGE_KEY]: '1.1' })
  assert.equal(loadUiScale(storage), 1.1)
  assert.equal(saveUiScale('0.9', storage), 0.9)
  assert.equal(storage.getItem(UI_SCALE_STORAGE_KEY), '0.9')
})

test('전체 문서 루트에 UI 배율을 적용한다', () => {
  const root = { style: {} }
  assert.equal(applyUiScale('1.25', root), 1.25)
  assert.equal(root.style.zoom, '1.25')
})

test('저장된 UI 배율을 설정 드롭다운의 현재 값으로 동기화한다', () => {
  const control = { value: '1' }
  const storage = memoryStorage({ [UI_SCALE_STORAGE_KEY]: '0.8' })

  assert.equal(syncUiScaleControl(control, storage), 0.8)
  assert.equal(control.value, '0.8')
})
