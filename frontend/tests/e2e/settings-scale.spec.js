import { test, expect } from '@playwright/test'
import { gotoApp, mockBaseRoutes } from './helpers.js'

test('배율 드롭다운의 표시값과 펼친 목록 선택값을 동일하게 유지한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await page.addInitScript(() => {
    localStorage.setItem('easypaper_ui_scale', '0.8')
    localStorage.setItem('easypaper_default_zoom', '1.0')
  })
  await gotoApp(page)

  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('#settings-modal')).toBeVisible()

  const uiScale = page.locator('#setting-ui-scale')
  await expect(uiScale).toHaveValue('0.8')
  await expect(uiScale.locator('option[selected]')).toHaveAttribute('value', '0.8')
  await expect(uiScale.locator('option[selected]')).toHaveCount(1)

  await uiScale.selectOption('0.9')
  await expect(uiScale).toHaveValue('0.9')
  await expect(uiScale.locator('option[selected]')).toHaveAttribute('value', '0.9')
  expect(await page.evaluate(() => localStorage.getItem('easypaper_ui_scale'))).toBe('0.9')

  await page.locator('#settings-nav-viewer').click()
  const pdfZoom = page.locator('#setting-default-zoom')
  await expect(pdfZoom).toHaveValue('1.0')
  await expect(pdfZoom.locator('option[selected]')).toHaveAttribute('value', '1.0')
  await expect(pdfZoom.locator('option[selected]')).toHaveCount(1)

  await pdfZoom.selectOption('2.0')
  await expect(pdfZoom).toHaveValue('2.0')
  await expect(pdfZoom.locator('option[selected]')).toHaveAttribute('value', '2.0')
  expect(await page.evaluate(() => localStorage.getItem('easypaper_default_zoom'))).toBe('2.0')
})
