/** Align the native selectable spans with PDF advances, using DOM font metrics.
 * PDF.js measures at a DPR-dependent canvas font size. Those metrics can differ
 * from browser layout; 6.3.289 also retains its font cache after resetting the
 * ascent canvas. Measuring the rendered spans avoids both sources of drift.
 */
export function alignTextLayer(textLayer, textContent, viewport, container) {
  // On macOS, PDF.js can round its 1px probe to zero under CSS zoom < 1.
  // Repair the CSS value before measuring: its reciprocal drives span transforms.
  const minimum = Number.parseFloat(container.style.getPropertyValue('--min-font-size'))
  if (!Number.isFinite(minimum) || minimum < 1) {
    container.style.setProperty('--min-font-size', '1')
  }
  const items = textContent.items.filter(item => typeof item.str === 'string')
  // OCR supplies ink boxes, not font baselines. Generic font ascent metrics
  // must not shift those boxes away from their measured page coordinates.
  for (const [index, span] of textLayer.textDivs.entries()) {
    const item = items[index]
    if (item?.fontName !== 'ocr') continue
    const { pageY, pageHeight } = viewport.rawDims
    const top = pageHeight - (item.transform[5] - pageY) - item.height
    span.style.top = `${100 * top / pageHeight}%`
    span.style.height = `calc(var(--text-scale-factor) * ${item.height}px)`
  }
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

export function recoveredTextContent(spans, viewport) {
  const { pageX, pageY, pageHeight } = viewport.rawDims
  const unit = viewport.userUnit || 1
  return {
    styles: { ocr: { fontFamily: 'sans-serif', ascent: 1, descent: 0, vertical: false } },
    items: spans.filter(span => span.text && span.bbox?.length === 4).map(span => {
      const [x0, y0, x1, y1] = span.bbox.map(value => value / unit)
      const height = y1 - y0
      return { str: span.text, dir: /[\u0590-\u08ff]/u.test(span.text) ? 'rtl' : 'ltr',
        width: x1 - x0, height, fontName: 'ocr', hasEOL: !!span.hasEOL,
        transform: [height, 0, 0, height, pageX + x0, pageY + pageHeight - y1] }
    }),
  }
}
