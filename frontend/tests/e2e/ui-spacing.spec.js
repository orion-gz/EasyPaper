import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

for (const width of [1280, 600]) {
  test(`workspace pages fit their content area at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => localStorage.setItem('easypaper_minimal_ui', 'false'))
    await mockBaseRoutes(page, { documents: [{ id: 'spacing-paper', filename: 'Spacing.pdf', total_pages: 4, metadata: { title: 'A long document title for checking card spacing and responsive layout', categories: ['Layout', 'Research'] }, translated_pages: [] }] })
    await gotoApp(page)
    for (const route of ['dashboard', 'library', 'history', 'chats', 'notes', 'graph']) {
      await page.locator(`.sidebar-nav-item[data-page="${route}"]`).click()
      const content = page.locator(`#page-${route}`)
      await expect(content).toBeVisible()
      await expect.poll(() => content.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      if (route === 'dashboard') {
        const cards = content.locator('.dash-stat-card')
        await expect(cards).toHaveCount(6)
        const first = await cards.nth(0).boundingBox()
        const nextRow = await cards.nth(width === 1280 ? 3 : 2).boundingBox()
        expect(nextRow.y).toBeGreaterThan(first.y + first.height)
      }
      await page.screenshot({ path: `/tmp/easypaper-${route}-${width}.png` })
    }
  })
}
