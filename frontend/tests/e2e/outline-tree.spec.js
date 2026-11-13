import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, activeReader } from './helpers.js'

function outlinedPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 2 >>',
    '<< /Title (Introduction with a long heading for alignment) /Parent 5 0 R /First 7 0 R /Last 7 0 R /Count 1 /Dest [3 0 R /Fit] >>',
    '<< /Title (Nested methods) /Parent 6 0 R /Dest [3 0 R /Fit] >>',
  ]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n` })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
for (const withChapters of [false, true]) {
  test(`PDF hierarchy remains accessible with chapters=${withChapters}`, async ({ page }, testInfo) => {
    const doc = { id: 'outline-doc', filename: 'outline.pdf', total_pages: 1, metadata: { title: 'Outline paper' }, translated_pages: [] }
    await mockBaseRoutes(page, { documents: [doc] })
    await page.route('**/api/library/outline-doc/pdf', r => r.fulfill({ contentType: 'application/pdf', body: outlinedPdf() }))
    await page.route('**/api/library/outline-doc/chapters', r => r.fulfill({ json: { status: withChapters ? 'available' : 'unavailable', chapters: withChapters ? [{ id: 'ch1', title: 'Introduction', start_page: 1, end_page: 1 }] : [] } }))
    await gotoApp(page)
    await page.evaluate(() => { location.hash = '#viewer?id=outline-doc' })
    const reader = activeReader(page)
    await expect(reader.locator('.pdf-page-wrapper[data-page="1"] canvas').first()).toBeVisible()
    await reader.locator('#outline-toggle-btn').click()
    const tree = reader.locator('.outline-tree')
    await expect(tree).toBeVisible()
    const summary = tree.locator('summary').first()
    const child = tree.locator('button').last()
    await expect(child).toBeVisible()
    await summary.click()
    await expect(child).toBeHidden()
    await summary.press('Enter')
    await expect(child).toBeVisible()
    await summary.press('ArrowDown')
    await expect(tree.locator('button').first()).toBeFocused()
    await child.click()
    await expect(child).toHaveAttribute('aria-current', 'location')
    expect(await child.evaluate(node => getComputedStyle(node).justifyContent)).toBe('center')
    if (withChapters) await expect(reader.locator('.outline-summary-btn')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('outline-tree.png'), fullPage: true })
  })
}
