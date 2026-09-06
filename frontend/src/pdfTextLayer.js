/** Align the native selectable spans with PDF advances, using DOM font metrics.
 * PDF.js measures at a DPR-dependent canvas font size. Those metrics can differ
 * from browser layout; 6.3.289 also retains its font cache after resetting the
 * ascent canvas. Measuring the rendered spans avoids both sources of drift.
 */
export function alignTextLayer(textLayer, textContent, viewport) {
  const items = textContent.items.filter(item => typeof item.str === 'string')
  const corrections = []
  for (const [index, span] of textLayer.textDivs.entries()) {
    const item = items[index]
    if (!item?.str || !span.isConnected) continue
    const style = getComputedStyle(span)
    // Computed width is the fractional, untransformed layout width, even under
    // CSS zoom or PDF rotation. offsetWidth would round away small font advances.
    const width = Number.parseFloat(style.width)
    const minFontSize = Number.parseFloat(style.getPropertyValue('--min-font-size')) || 1
    const vertical = textContent.styles[item.fontName]?.vertical
    const advance = vertical ? item.height : item.width
    if (width > 0 && advance > 0) {
      corrections.push([span, advance * viewport.scale * viewport.userUnit * minFontSize / width])
    }
  }
  // Batch reads before writes to avoid laying out the page once per span.
  for (const [span, scaleX] of corrections) span.style.setProperty('--scale-x', scaleX)
}

export async function collectTextContent(stream) {
  const reader = stream.getReader()
  const content = { items: [], styles: Object.create(null) }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return content
      content.items.push(...value.items)
      Object.assign(content.styles, value.styles)
      if (value.lang != null) content.lang = value.lang
    }
  } finally {
    reader.releaseLock()
  }
}
