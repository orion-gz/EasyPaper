import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSelectionRect,
  resolveDragSelection,
  selectionRectsIntersect,
} from '../src/library-selection.js'

test('어느 방향으로 드래그해도 정규화된 선택 영역을 만든다', () => {
  assert.deepEqual(createSelectionRect(80, 70, 20, 10), {
    left: 20,
    top: 10,
    right: 80,
    bottom: 70,
    width: 60,
    height: 60,
  })
})

test('선택 사각형과 겹치는 논문만 선택한다', () => {
  const selection = createSelectionRect(0, 0, 100, 100)
  const items = [
    { id: 'inside', rect: { left: 10, top: 10, right: 40, bottom: 40 } },
    { id: 'edge', rect: { left: 100, top: 20, right: 130, bottom: 50 } },
    { id: 'outside', rect: { left: 110, top: 110, right: 140, bottom: 140 } },
  ]

  assert.equal(selectionRectsIntersect(selection, items[0].rect), true)
  assert.deepEqual([...resolveDragSelection([], items, selection)], ['inside', 'edge'])
})

test('Cmd/Ctrl 드래그는 기존 선택을 기준으로 겹친 항목을 토글한다', () => {
  const selection = createSelectionRect(0, 0, 100, 100)
  const items = [
    { id: 'selected', rect: { left: 10, top: 10, right: 40, bottom: 40 } },
    { id: 'added', rect: { left: 50, top: 50, right: 80, bottom: 80 } },
    { id: 'untouched', rect: { left: 150, top: 150, right: 180, bottom: 180 } },
  ]

  const result = resolveDragSelection(
    ['selected', 'untouched'],
    items,
    selection,
    true,
  )

  assert.deepEqual([...result].sort(), ['added', 'untouched'])
})
