import { test, expect } from '@playwright/test'
import { gotoApp, mockBaseRoutes } from './helpers.js'

async function openTransfer(page) {
  await gotoApp(page)
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('#settings-nav-data-system').click()
}

test('exports browser settings with the user archive and starts a ZIP download', async ({ page }) => {
  await mockBaseRoutes(page)
  let payload
  await page.route('**/api/user-data/export', async route => {
    payload = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/zip', body: Buffer.from('ZIP') })
  })
  await openTransfer(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_ui_scale', '0.9')
    localStorage.setItem('easypaper_token', 'never-export')
  })
  const download = page.waitForEvent('download')
  await page.locator('#user-data-export').click()
  expect((await download).suggestedFilename()).toMatch(/^easypaper-user-data-.*\.zip$/)
  expect(payload.easypaper_ui_scale).toBe('0.9')
  expect(payload.easypaper_token).toBeUndefined()
  await expect(page.locator('#user-data-export')).toBeEnabled()
})

test('imports a ZIP and remaps local notes without changing shared settings by default', async ({ page }) => {
  await mockBaseRoutes(page)
  let uploaded = false
  await page.route('**/api/user-data/import', async route => {
    uploaded = route.request().headers()['content-type'] === 'application/zip'
    await route.fulfill({ json: {
      documents: 1, id_map: { old: 'new' }, browser_data: { easypaper_memos_old: '{"1":[{"text":"memo"}]}' },
      system_settings: {},
    } })
  })
  await openTransfer(page)
  await expect(page.locator('#user-data-system-settings')).not.toBeChecked()
  page.on('dialog', dialog => dialog.accept())
  await page.locator('#user-data-file').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from('ZIP') })
  await expect(page.locator('#user-data-reload')).toBeVisible()
  expect(uploaded).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('easypaper_memos_new'))).toBe('{"1":[{"text":"memo"}]}')
  await expect(page.locator('#user-data-import')).toBeEnabled()
})

test('shows invalid archive errors and permits retry without reloading', async ({ page }) => {
  await mockBaseRoutes(page)
  await page.route('**/api/user-data/import', route => route.fulfill({ status: 400, json: { detail: 'Invalid backup checksum' } }))
  await openTransfer(page)
  page.on('dialog', dialog => dialog.accept())
  await page.locator('#user-data-file').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('bad') })
  await expect(page.locator('#user-data-status')).toContainText('Invalid backup checksum')
  await expect(page.locator('#user-data-import')).toBeEnabled()
  await expect(page.locator('#user-data-reload')).toBeHidden()
})
