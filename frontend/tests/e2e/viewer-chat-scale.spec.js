import { test, expect } from '@playwright/test'
import { gotoApp, mockBaseRoutes, SAMPLE_PDF_A } from './helpers.js'

for (const uiScale of [0.8, 0.9]) {
  test(`AI assistant fills the viewer height at ${uiScale * 100}% UI scale`, async ({ page }) => {
    const doc = {
      id: `doc-chat-scale-${uiScale}`,
      filename: 'Chat scale.pdf',
      total_pages: 1,
      metadata: { title: 'Chat scale' },
      translated_pages: [],
    }
    await mockBaseRoutes(page, { documents: [doc] })
    await page.addInitScript(scale => {
      localStorage.setItem('easypaper_ui_scale', String(scale))
    }, uiScale)
    await page.route(`**/api/library/${doc.id}/pdf`, route => route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: SAMPLE_PDF_A,
    }))
    await gotoApp(page)
    await page.evaluate(id => { location.hash = `#viewer?id=${id}` }, doc.id)
    await expect(page.locator('#viewer-screen')).toHaveClass(/active/)

    await page.locator('#chat-toggle-btn').click()
    const chatSidebar = page.locator('#chat-sidebar')
    await expect(chatSidebar).toBeVisible()

    const bottomGap = await chatSidebar.evaluate(element =>
      window.innerHeight - element.getBoundingClientRect().bottom)
    expect(Math.abs(bottomGap)).toBeLessThanOrEqual(1)
  })
}
