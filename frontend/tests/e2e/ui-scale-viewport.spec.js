import { test, expect } from '@playwright/test'
import { gotoApp, mockBaseRoutes } from './helpers.js'

for (const uiScale of [0.8, 0.9, 1, 1.25]) {
  test(`fixed UI fills the viewport at ${uiScale * 100}% UI scale`, async ({ page }) => {
    await mockBaseRoutes(page, { documents: [] })
    await page.addInitScript(scale => {
      localStorage.setItem('easypaper_ui_scale', String(scale))
    }, uiScale)
    await gotoApp(page)

    const viewport = page.viewportSize()
    const activeScreen = await page.locator('.screen.active').boundingBox()
    expect(activeScreen).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height })

    await page.locator('#sidebar-settings-btn').click()
    await expect(page.locator('#settings-modal')).toBeVisible()
    const modalOverlay = await page.locator('#settings-modal').boundingBox()
    expect(modalOverlay).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height })
    await page.locator('#close-settings-btn').click()

    await page.locator('#sidebar-logout-btn').click()
    const confirmOverlay = page.locator('.custom-confirm-modal-wrapper')
    await expect(confirmOverlay).toBeVisible()
    expect(await confirmOverlay.boundingBox()).toEqual({
      x: 0, y: 0, width: viewport.width, height: viewport.height,
    })
    const confirmDialog = await confirmOverlay.locator('.custom-confirm-modal').boundingBox()
    expect(confirmDialog.x).toBeGreaterThanOrEqual(0)
    expect(confirmDialog.y).toBeGreaterThanOrEqual(0)
    expect(confirmDialog.x + confirmDialog.width).toBeLessThanOrEqual(viewport.width)
    expect(confirmDialog.y + confirmDialog.height).toBeLessThanOrEqual(viewport.height)
  })
}
