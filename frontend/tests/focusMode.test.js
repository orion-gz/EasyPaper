import test from 'node:test'
import assert from 'node:assert/strict'
import { createFocusMask, focusCssVariables, isFocusKeyboardExcluded, mergeClientRects, normalizeFocusSettings } from '../src/focusMode.js'

test('Focus 설정은 손상값과 범위를 정규화한다', () => {
  assert.deepEqual(normalizeFocusSettings({ enabled: true, blurStrength: 99, dimOpacity: 23, scale: 'bad' }), { enabled: true, blurStrength: 16, dimOpacity: 25, scale: 104 })
  assert.deepEqual(normalizeFocusSettings({ blurStrength: 0, dimOpacity: 0, scale: 100 }), { enabled: false, blurStrength: 0, dimOpacity: 0, scale: 100 })
})

test('여러 DOM 조각을 같은 행 단위로 병합한다', () => {
  assert.deepEqual(mergeClientRects([{ left: 10, top: 10, width: 20, height: 10 }, { left: 31, top: 11, width: 9, height: 9 }, { left: 10, top: 30, width: 15, height: 10 }]), [
    { left: 10, top: 10, right: 40, bottom: 20, width: 30, height: 10 },
    { left: 10, top: 30, right: 25, bottom: 40, width: 15, height: 10 },
  ])
})

test('마스크와 CSS 값은 0 값도 그대로 보존한다', () => {
  const mask = createFocusMask([{ left: 10, top: 20, width: 30, height: 40 }], 800, 600)
  assert.match(mask, /data:image\/svg\+xml/)
  assert.deepEqual(focusCssVariables({ blurStrength: 0, dimOpacity: 0, scale: 100 }), { '--focus-blur': '0px', '--focus-dim': '0', '--focus-scale': '1' })
})

test('편집 및 메뉴 컨텍스트는 키보드 탐색에서 제외한다', () => {
  assert.equal(isFocusKeyboardExcluded({ closest: selector => selector.includes('input') ? {} : null }), true)
  assert.equal(isFocusKeyboardExcluded({ closest: () => null }), false)
})
