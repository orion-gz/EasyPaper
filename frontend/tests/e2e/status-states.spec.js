import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

for (const theme of ['dark', 'light']) {
  test(`document failure keeps an accessible retry in ${theme} theme`, async ({ page }) => {
    await mockBaseRoutes(page, { documents: [{ id: 'state-doc', filename: 'Example.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] }] })
    await page.route('**/api/library/state-doc', route => route.fulfill({ status: 500, json: { detail: 'Temporary failure' } }))
    await gotoApp(page)
    await page.evaluate(() => { location.hash = '#viewer?id=state-doc' })
    const reader = page.frameLocator('iframe[data-document-id="state-doc"]')
    const panel = reader.locator('.workspace-load-error')
    await expect(panel).toBeVisible({ timeout: 20000 })
    if (theme === 'light') await page.locator('#sidebar-theme-toggle-btn').click()
    await expect(panel.getByRole('button')).toHaveAccessibleName('다시 시도')
    await panel.getByRole('button').focus()
    await expect(panel.getByRole('button')).toBeFocused()
    expect(await panel.locator('.status-state-icon svg').count()).toBe(1)
    await panel.screenshot({ path: `/tmp/easypaper-status-${theme}.png` })
  })
}

test('notes failure stays embedded and retry remains usable', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [{ id: 'state-note', filename: 'Note.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] }] })
  await page.route('**/api/library/state-note/primer?*', route => route.fulfill({ status: 503, json: { detail: 'Temporary failure' } }))
  await gotoApp(page)
  await page.locator('.sidebar-nav-item[data-page="notes"]').click()
  const state = page.locator('.notes-empty').filter({ has: page.locator('.notes-summary-retry') })
  await expect(state).toBeVisible()
  await expect(state).toHaveCSS('border-top-width', '0px')
  await expect(state.locator('svg')).toHaveCount(1)
  await expect(state.getByRole('button')).toHaveCSS('min-height', '40px')
  await state.screenshot({ path: '/tmp/easypaper-status-notes.png' })
})
