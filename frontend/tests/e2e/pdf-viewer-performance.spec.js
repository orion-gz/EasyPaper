import { test, expect } from '@playwright/test'
import { activeReader, evaluateReader, readerPoint, mockBaseRoutes, gotoApp } from './helpers.js'

test.use({ deviceScaleFactor: 2 })

// Generate a real multipage PDF without an additional fixture dependency.
function multipagePdf(count, contentForPage) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (let i = 0; i < count; i++) {
    const content = contentForPage?.(i + 1) ?? `BT /F1 18 Tf 50 700 Td (Performance page ${i + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

test('long PDF loads lazily, bounds canvases and restores evicted pages', async ({ page }) => {
  const doc = { id: 'performance', filename: 'Long.pdf', total_pages: 24, metadata: { title: 'Long PDF' }, translated_pages: [1] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/performance/pdf', route => route.fulfill({ contentType: 'application/pdf', body: multipagePdf(24) }))
  await page.route('**/api/pdf-text/**', route => route.fulfill({ json: { recovery: null } }))
  await page.route('**/api/library/performance/translation/1**', route => route.fulfill({ json: { translation: 'Cached page one.', sentences: [] } }))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_hydrated_performance', '1')
    localStorage.setItem('easypaper_memos_performance', JSON.stringify({ page_1: [{
      id: 'retained-memo', pageNum: 1, sentenceIdx: 0, sentenceText: 'Performance page 1', content: 'Keep this memo', x: 10, y: 10,
    }] }))
    location.hash = '#viewer?id=performance'
  })
  const wrapper = number => activeReader(page).locator(`.pdf-page-wrapper[data-page="${number}"]`)
  const text = number => wrapper(number).locator('.textLayer')
  await expect(text(1)).toContainText('Performance page 1')
  await expect(activeReader(page).locator('.floating-memo[data-id="retained-memo"]')).toBeVisible()
  await expect(activeReader(page).locator('.pdf-page-wrapper')).toHaveCount(24)
  expect(await activeReader(page).locator('.pdf-page-wrapper canvas').count()).toBeLessThanOrEqual(3)
  const originalHeight = await wrapper(1).evaluate(node => node.getBoundingClientRect().height)

  for (const number of [4, 7, 10, 13, 16, 19, 22, 24]) {
    await wrapper(number).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
    await expect(text(number)).toContainText(`Performance page ${number}`)
  }
  await expect(wrapper(1).locator('canvas')).toHaveCount(0)
  await expect(activeReader(page).locator('.floating-memo[data-id="retained-memo"]')).toHaveCount(0)
  expect(await activeReader(page).locator('.pdf-page-wrapper canvas').count()).toBeLessThanOrEqual(8)
  expect(await wrapper(1).evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(originalHeight, 0)

  await wrapper(1).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await expect(text(1)).toContainText('Performance page 1')
  expect(await wrapper(1).locator('canvas').evaluate(canvas => canvas.width)).toBeGreaterThan(0)
  await expect(activeReader(page).locator('.floating-memo[data-id="retained-memo"]')).toContainText('Keep this memo')
  await expect(activeReader(page).locator('.page-render-error')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('rapid jumps cancel stale text requests and finish the destination page', async ({ page }) => {
  const doc = { id: 'rapid', filename: 'Rapid.pdf', total_pages: 24, metadata: { title: 'Rapid PDF' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/rapid/pdf', route => route.fulfill({ contentType: 'application/pdf', body: multipagePdf(24) }))
  let releaseText
  const textGate = new Promise(resolve => { releaseText = resolve })
  await page.route('**/api/pdf-text/**', async route => {
    await textGate
    await new Promise(resolve => setTimeout(resolve, 400))
    await route.fulfill({ json: { recovery: null } }).catch(() => {})
  })
  await page.addInitScript(() => {
    const originalFetch = window.fetch
    window.pdfTextRequests = { active: 0, max: 0, cancelled: 0 }
    window.fetch = async (...args) => {
      if (!String(args[0]).includes('/api/pdf-text/')) return originalFetch(...args)
      const stats = window.pdfTextRequests
      stats.active++
      stats.max = Math.max(stats.max, stats.active)
      try { return await originalFetch(...args) }
      catch (error) { if (args[1]?.signal?.aborted) stats.cancelled++; throw error }
      finally { stats.active-- }
    }
  })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=rapid' })
  await expect.poll(() => evaluateReader(page, () => window.pdfTextRequests.active)).toBeGreaterThan(0)
  for (const number of [8, 16, 24]) {
    await activeReader(page).locator(`.pdf-page-wrapper[data-page="${number}"]`).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
    await page.waitForTimeout(50)
  }
  await expect.poll(() => evaluateReader(page, () => window.pdfTextRequests.cancelled)).toBeGreaterThan(0)
  releaseText()
  await expect(activeReader(page).locator('.pdf-page-wrapper[data-page="24"] .textLayer')).toContainText('Performance page 24')
  const stats = await evaluateReader(page, () => window.pdfTextRequests)
  expect(stats.max).toBeLessThanOrEqual(2)
  expect(stats.cancelled).toBeGreaterThan(0)
  await expect(activeReader(page).locator('.page-render-error')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('dense page overlays batch layout and page hover keeps reading geometry stable', async ({ page, context, browserName }) => {
  const doc = { id: 'dense', filename: 'Dense.pdf', total_pages: 4, metadata: { title: 'Dense PDF' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [doc] })
  const pdf = multipagePdf(4, () => Array.from({ length: 45 }, (_, i) =>
    `BT /F1 10 Tf 15 ${750 - i * 15} Td (${100 + i}) Tj ET\nBT /F1 10 Tf 60 ${750 - i * 15} Td (Reading line ${i + 1} cites [1] and Figure 1.) Tj ET`
  ).join('\n'))
  await page.route('**/api/library/dense/pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
  await page.route('**/api/pdf-text/**', route => route.fulfill({ json: { recovery: null } }))
  await page.route('**/api/library/dense/references', route => route.fulfill({ json: { references: { '1': 'Example reference.' } } }))
  await page.route('**/api/library/dense/images', route => route.fulfill({ json: { images: [
    { page: 1, label: 'Figure 1', left: 75, top: 90, width: 10, height: 5 },
  ] } }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=dense' })
  // Exercise a newly rendered page reached by scrolling, not just startup.
  const wrapper = activeReader(page).locator('.pdf-page-wrapper[data-page="4"]')
  await wrapper.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await expect(wrapper.locator('.citation-marker-box')).toHaveCount(45)
  await expect(wrapper.locator('.figure-ref-marker-box')).toHaveCount(45)
  await expect(wrapper.locator('.pdf-line-number-noise')).toHaveCount(45)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(500)

  // Chromium's layout counter measures forced layout, without a machine-speed
  // dependent millisecond threshold. Rebuild the same dense page synchronously.
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    const layoutCount = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'LayoutCount').value
    const before = await layoutCount()
    await wrapper.locator('.textLayer').evaluate(layer => window.onTextLayerRendered(layer, 4))
    const layouts = await layoutCount() - before
    console.log(`Dense page overlay rebuild: ${layouts} layouts`)
    expect(layouts).toBeLessThan(15)
    await cdp.detach()
  } else {
    await wrapper.locator('.textLayer').evaluate(layer => window.onTextLayerRendered(layer, 4))
  }
  await expect(wrapper.locator('.citation-marker-box')).toHaveCount(45)
  await expect(wrapper.locator('.figure-ref-marker-box')).toHaveCount(45)

  const card = wrapper.locator('..')
  const original = await card.boundingBox()
  const hoverPoint = await wrapper.evaluate(node => {
    const page = node.getBoundingClientRect()
    const viewport = node.closest('#viewer-scroll-container').getBoundingClientRect()
    return { x: Math.max(page.left, viewport.left) + 30, y: Math.max(page.top, viewport.top) + 30 }
  })
  const pointer = await readerPoint(page, hoverPoint.x, hoverPoint.y)
  await page.mouse.move(pointer.x, pointer.y)
  await page.waitForTimeout(500)
  expect(await card.evaluate(node => node.matches(':hover'))).toBe(true)
  const hovered = await card.boundingBox()
  expect(hovered.y).toBeCloseTo(original.y, 1)
  expect(await card.evaluate(node => getComputedStyle(node).transitionProperty)).not.toBe('all')
})


test('scrolling a loaded page does not revisit closed library folder menus', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('easypaper_ui_scale', '0.9') })
  const doc = { id: 'steady', filename: 'Steady.pdf', total_pages: 2, metadata: { title: 'Steady' }, translated_pages: [] }
  const folders = Array.from({ length: 100 }, (_, index) => ({ id: `folder-${index}`, name: `Folder ${index}`, color: '#888888', parent_id: null }))
  await mockBaseRoutes(page, { documents: [doc], folders })
  await page.route('**/api/library/steady/pdf', route => route.fulfill({ contentType: 'application/pdf', body: multipagePdf(2) }))
  await page.route('**/api/pdf-text/**', route => route.fulfill({ json: { recovery: null } }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=steady' })
  await expect(activeReader(page).locator('.textLayer').first()).toContainText('Performance page 1')
  await expect(page.locator('.folder-card-actions')).toHaveCount(100)
  await expect(activeReader(page).locator('.citation-marker-box, .figure-ref-marker-box')).toHaveCount(0)
  const viewer = activeReader(page).locator('#viewer-scroll-container')
  await page.evaluate(() => {
    window.steadyScroll = { events: 0, menuScans: 0, menuMutations: 0 }
    const query = document.querySelectorAll.bind(document)
    document.querySelectorAll = selector => {
      if (selector.includes('.folder-card-actions')) window.steadyScroll.menuScans++
      return query(selector)
    }
    const observer = new MutationObserver(records => { window.steadyScroll.menuMutations += records.length })
    for (const menu of query('.folder-card-actions')) observer.observe(menu, { attributes: true })
  })
  await viewer.evaluate(node => {
    window.steadyScrollEvents = 0
    node.addEventListener('scroll', () => window.steadyScrollEvents++, { passive: true })
  })
  const bounds = await viewer.boundingBox()
  await page.mouse.move(bounds.x + 100, bounds.y + 100)
  for (const delta of [100, 100, -100]) {
    const previous = await viewer.evaluate(node => node.scrollTop)
    await page.mouse.wheel(0, delta)
    await expect.poll(() => viewer.evaluate(node => node.scrollTop)).not.toBe(previous)
  }
  const stats = await page.evaluate(() => window.steadyScroll)
  expect(await evaluateReader(page, () => window.steadyScrollEvents)).toBeGreaterThanOrEqual(3)
  expect(stats.menuScans).toBe(0)
  expect(stats.menuMutations).toBe(0)
})

// Match the reported light theme, UI scale and Retina display. Wheel over the
// translation itself: scrolling dispatches hover events without mouse movement.
test('translation scrolling pauses hover repaint and hover resumes after scrolling', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('easypaper_ui_scale', '0.9')
    localStorage.setItem('easypaper_theme_research', 'light')
  })
  const doc = { id: 'hover-scroll', filename: 'Hover.pdf', total_pages: 2, metadata: { title: 'Hover' }, translated_pages: [1] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/hover-scroll/pdf', route => route.fulfill({ contentType: 'application/pdf', body: multipagePdf(2) }))
  await page.route('**/api/pdf-text/**', route => route.fulfill({ json: { recovery: null } }))
  await page.route('**/api/library/hover-scroll/translation/1**', route => route.fulfill({ json: {
    translation: Array.from({ length: 50 }, (_, i) => `Paragraph ${i + 1} describes the scientific findings in detail. Another sentence explains the methods and results.`).join('\n\n'), sentences: [],
  } }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=hover-scroll' })
  const sentence = activeReader(page).locator('.trans-sentence').first()
  const pane = activeReader(page).locator('#trans-content-1')
  await expect(sentence).toBeVisible()
  await sentence.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await sentence.hover()
  await expect(sentence).toHaveClass(/sentence-highlight/)
  const initial = await pane.evaluate(node => node.scrollTop)
  await page.mouse.wheel(0, 40)
  await expect.poll(() => pane.evaluate(node => node.scrollTop)).toBeGreaterThan(initial)
  await expect(activeReader(page).locator('.trans-sentence.sentence-highlight')).toHaveCount(0)
  await pane.evaluate(node => {
    window.hoverWritesDuringScroll = 0
    new MutationObserver(records => {
      window.hoverWritesDuringScroll += records.filter(record => record.target.classList?.contains('trans-sentence')).length
    }).observe(node, { subtree: true, attributes: true, attributeFilter: ['class'] })
  })
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 35)
    await page.waitForTimeout(30)
  }
  expect(await evaluateReader(page, () => window.hoverWritesDuringScroll)).toBe(0)
  // A real mouse move over the same sentence after scrolling must restore hover,
  // even if the pointer never left that sentence's DOM element.
  await pane.evaluate(node => { node.scrollTop = 0 })
  await page.waitForTimeout(200)
  await sentence.hover()
  await expect(sentence).toHaveClass(/sentence-highlight/)
})
