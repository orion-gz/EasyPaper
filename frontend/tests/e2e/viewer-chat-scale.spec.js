import { test, expect } from '@playwright/test'
import { activeReader, gotoApp, mockBaseRoutes, SAMPLE_PDF_A } from './helpers.js'

for (const uiScale of [0.8, 0.9]) {
  test(`reader and AI assistant fit their workspace at ${uiScale * 100}% UI scale`, async ({ page }) => {
    const doc = { id: `doc-chat-scale-${uiScale}`, filename: 'Chat scale.pdf', total_pages: 1, metadata: { title: 'Chat scale' }, translated_pages: [] }
    await mockBaseRoutes(page, { documents: [doc] })
    await page.addInitScript(scale => localStorage.setItem('easypaper_ui_scale', String(scale)), uiScale)
    await page.route(`**/api/library/${doc.id}/pdf`, route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
    await gotoApp(page)
    await page.evaluate(id => { location.hash = `#viewer?id=${id}` }, doc.id)
    await expect(activeReader(page).locator('#workspace-reading-mode')).toBeVisible()
    const host = await page.locator('#workspace-tab-panel').boundingBox()
    const frame = await page.locator('.workspace-document-frame:not([hidden])').boundingBox()
    expect(Math.abs(host.height - frame.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(host.width - frame.width)).toBeLessThanOrEqual(1)
    const sidebar = activeReader(page).locator('#chat-sidebar')
    await expect(sidebar).toBeVisible()
    const box = await sidebar.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(host.x)
    expect(box.y).toBeGreaterThan(host.y)
    // The mockup has a 10 CSS pixel gutter around the reader.
    expect(Math.abs(box.y + box.height - (host.y + host.height - 10 * uiScale))).toBeLessThanOrEqual(2)
    expect(Math.abs(box.x + box.width - (host.x + host.width - 10 * uiScale))).toBeLessThanOrEqual(2)
  })
}
