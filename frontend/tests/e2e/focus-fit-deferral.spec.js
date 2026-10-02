import { test, expect } from '@playwright/test'
import { activeReader, evaluateReader, mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

test('fit waits for the body-level focus overlay to close', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const doc = { id: 'focus-fit', filename: 'Focus.pdf', total_pages: 1, metadata: {}, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/focus-fit/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=focus-fit' })
  const reader = activeReader(page)
  await expect(reader.locator('#viewer-screen:not(.document-workspace-loading) .textLayer')).toBeVisible()
  await expect(reader.locator('#document-fit-width')).toHaveAttribute('aria-pressed', 'true')
  const width = await reader.locator('.pdf-page-wrapper').evaluate(node => node.getBoundingClientRect().width)
  // The focus controller appends its layer directly to body, outside viewer-screen.
  await evaluateReader(page, () => {
    const layer = document.createElement('div'); layer.className = 'focus-mode-layer'; document.body.append(layer)
  })
  await page.setViewportSize({ width: 1300, height: 1000 })
  // Wait beyond the fit debounce to prove it remains deferred.
  await page.waitForTimeout(350)
  expect(await reader.locator('.pdf-page-wrapper').evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(width, 0)
  await evaluateReader(page, () => document.querySelector('.focus-mode-layer').remove())
  await expect.poll(() => reader.locator('.pdf-page-wrapper').evaluate(node => node.getBoundingClientRect().width)).toBeLessThan(width - 20)
})
