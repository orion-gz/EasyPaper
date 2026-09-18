// Reference markers and sentence ranges use the same PDF text-map offsets.
export function previewBelongsToSentence(anchor, current, sourceRange) {
  if (!anchor?.isConnected || !current || !sourceRange) return false
  const { focusPage, focusStart, focusEnd } = anchor.dataset
  const start = Number(focusStart), end = Number(focusEnd)
  return Number(focusPage) === current.pageNum && Number.isFinite(start) && Number.isFinite(end)
    && end > start && start >= sourceRange.charStart && end <= sourceRange.charEnd
}

// Find a free viewport rectangle. Prefer keeping the requested size, then the
// nearest placement; constrain oversized previews instead of covering text.
export function placeFocusPreview(preview, obstacles, width, height, gap = 10) {
  const edge = 8
  const blocks = obstacles.map(r => ({ left: r.left - gap, top: r.top - gap,
    right: r.left + r.width + gap, bottom: r.top + r.height + gap }))
  const xs = [edge, ...blocks.map(r => r.right)].filter(x => x >= edge && x < width - edge)
  const ys = [edge, ...blocks.map(r => r.bottom)].filter(y => y >= edge && y < height - edge)
  let best = null
  for (const left of xs) for (const top of ys) {
    const rights = [width - edge, ...blocks.filter(r => r.left > left).map(r => r.left)]
    for (const right of rights) {
      if (right <= left || right > width - edge) continue
      const intersecting = blocks.filter(r => r.left < right && r.right > left && r.bottom > top)
      if (intersecting.some(r => r.top <= top)) continue
      const bottom = Math.min(height - edge, ...intersecting.map(r => r.top))
      const w = Math.min(preview.width, right - left), h = Math.min(preview.height, bottom - top)
      if (w < Math.min(160, preview.width) || h < Math.min(80, preview.height)) continue
      const x = Math.max(left, Math.min(preview.left, right - w))
      const y = Math.max(top, Math.min(preview.top, bottom - h))
      const area = w * h, distance = Math.hypot(x - preview.left, y - preview.top)
      if (!best || area > best.area || (area === best.area && distance < best.distance)) {
        best = { left: x, top: y, width: w, height: h, maxWidth: right - x, maxHeight: bottom - y, area, distance }
      }
    }
  }
  return best
}
