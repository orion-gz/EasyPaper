import test from 'node:test'
import assert from 'node:assert/strict'
import { createFocusBackdropRects, createFocusMask, focusCssVariables, focusSvgCoordinateScale, isFocusKeyboardExcluded, mergeClientRects, normalizeFocusSettings } from '../src/focusMode.js'

test('SVG 필터 좌표 배율은 WebKit과 Chromium의 차이를 보정한다', () => {
  assert.equal(focusSvgCoordinateScale(1.25, 'AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15'), 1)
  assert.equal(focusSvgCoordinateScale(0.8, 'AppleWebKit/605.1.15 CriOS/140.0 Mobile Safari/604.1'), 1)
  assert.equal(focusSvgCoordinateScale(1.25, 'AppleWebKit/537.36 Chrome/149.0 Safari/537.36'), 1.25)
  assert.equal(focusSvgCoordinateScale(0.8, 'Gecko/20100101 Firefox/140.0'), 0.8)
})

test('배경 영역은 겹치는 문장 구멍을 제외하고 한 번만 덮는다', () => {
  const regions = createFocusBackdropRects([
    { left: 10, top: 10, width: 20, height: 20 },
    { left: 20, top: 20, width: 20, height: 20 },
  ], 50, 50, 0)
  for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) {
    const hole = (x >= 10 && x < 30 && y >= 10 && y < 30) || (x >= 20 && x < 40 && y >= 20 && y < 40)
    assert.equal(regions.filter(r => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height).length, hole ? 0 : 1)
  }
})

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
