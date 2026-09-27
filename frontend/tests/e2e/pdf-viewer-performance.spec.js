import { test, expect } from '@playwright/test'
import { activeReader, evaluateReader, mockBaseRoutes, gotoApp } from './helpers.js'

// Generate a real multipage PDF without an additional fixture dependency.
function multipagePdf(count) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (let i = 0; i < count; i++) {
    const content = `BT /F1 18 Tf 50 700 Td (Performance page ${i + 1}) Tj ET`
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
