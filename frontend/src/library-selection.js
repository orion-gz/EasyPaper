export function createSelectionRect(startX, startY, endX, endY) {
  const left = Math.min(startX, endX)
  const top = Math.min(startY, endY)
  const right = Math.max(startX, endX)
  const bottom = Math.max(startY, endY)
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

export function selectionRectsIntersect(first, second) {
  return !(
    first.right < second.left ||
    first.left > second.right ||
    first.bottom < second.top ||
    first.top > second.bottom
  )
}

export function resolveDragSelection(baseIds, items, selectionRect, toggle = false) {
  const selected = toggle ? new Set(baseIds) : new Set()
  for (const item of items) {
    if (!selectionRectsIntersect(selectionRect, item.rect)) continue
    if (toggle && selected.has(item.id)) {
      selected.delete(item.id)
    } else {
      selected.add(item.id)
    }
  }
  return selected
}
