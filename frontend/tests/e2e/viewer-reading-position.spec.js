import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

// Short landscape pages make the difference from the 841pt placeholder visible.
function makePDF(pageCount, mixedSizes) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: pageCount }, (_, i) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 ${mixedSizes && i % 2 ? 800 : 400}] /Resources << >> >>`),
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

for (const mixedSizes of [false, true]) {
  test(`읽던 페이지가 최초 복원, 새로고침, 재진입 후에도 유지된다 (${mixedSizes ? '혼합 크기' : '가로 페이지'})`, async ({ page }) => {
    const doc = { id: 'reading-position', filename: 'Landscape.pdf', total_pages: 30, metadata: { last_page: 15 }, translated_pages: [] }
    await mockBaseRoutes(page, { documents: [doc] })
    await page.route('**/api/library/reading-position/pdf', route => route.fulfill({ contentType: 'application/pdf', body: makePDF(30, mixedSizes) }))
    const savedPages = []
    let expectedPage = 15
    await page.route('**/api/library/reading-position/metadata', async route => {
      const metadata = route.request().postDataJSON()
      if (metadata.last_page != null) {
        savedPages.push(metadata.last_page)
        Object.assign(doc.metadata, metadata)
      }
      await route.fulfill({ json: doc })
    })
    const expectRestored = async () => {
      await expect(page.locator(`.pdf-page-wrapper[data-page="${expectedPage}"] canvas`)).toBeAttached()
      // Allow lazy rendering, smooth scrolling and the bookmark debounce to settle.
      await page.waitForTimeout(2200)
      await expect(page.locator('#page-input')).toHaveValue(String(expectedPage))
      expect(savedPages.every(pageNum => pageNum === 15 || pageNum === 19)).toBe(true)
      const offset = await page.locator(`.page-pair[data-page="${expectedPage}"]`).evaluate(pair =>
        pair.getBoundingClientRect().top - document.querySelector('#viewer-scroll-container').getBoundingClientRect().top)
      expect(Math.abs(offset)).toBeLessThan(50)
    }
    await gotoApp(page)
    await page.evaluate(() => { location.hash = '#viewer?id=reading-position' })
    await expectRestored()
    expectedPage = 19
    await page.locator('.page-pair[data-page="19"]').evaluate(pair => pair.scrollIntoView({ behavior: 'instant', block: 'start' }))
    await expect.poll(() => doc.metadata.last_page).toBe(19)
    await page.reload()
    await expectRestored()
    await page.locator('#back-btn').click()
    await expect(page.locator('#viewer-screen')).not.toHaveClass(/active/)
    await page.evaluate(() => { location.hash = '#viewer?id=reading-position' })
    await expectRestored()
  })
}
