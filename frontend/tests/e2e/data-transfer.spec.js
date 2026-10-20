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
  await page.addInitScript(() => { window.confirm = () => { throw new Error('Native confirm is unavailable') } })
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
  await page.locator('#user-data-file').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from('ZIP') })
  await page.locator('.custom-confirm-modal .confirm-btn').click()
  await expect(page.locator('#user-data-reload')).toBeVisible()
  expect(uploaded).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('easypaper_memos_new'))).toBe('{"1":[{"text":"memo"}]}')
  await expect(page.locator('#user-data-import')).toBeEnabled()
})

test('shows invalid archive errors and permits retry without reloading', async ({ page }) => {
  await mockBaseRoutes(page)
  await page.route('**/api/user-data/import', route => route.fulfill({ status: 400, json: { detail: 'Invalid backup checksum' } }))
  await openTransfer(page)
  await page.locator('#user-data-file').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('bad') })
  await page.locator('.custom-confirm-modal .confirm-btn').click()
  await expect(page.locator('#user-data-status')).toContainText('Invalid backup checksum')
  await expect(page.locator('#user-data-import')).toBeEnabled()
  await expect(page.locator('#user-data-reload')).toBeHidden()
})

for (const exportSucceeds of [true, false]) {
  test(`pending settings recovery survives ${exportSucceeds ? 'successful' : 'failed'} export and blocks duplicate import`, async ({ page }) => {
    await mockBaseRoutes(page)
    let imports = 0
    let settingsSaves = 0
    let failSettings = true
    let exports = 0
    let releaseExport
    const exportGate = new Promise(resolve => { releaseExport = resolve })
    await page.route('**/api/user-data/import', route => {
      imports++
      return route.fulfill({ json: {
        documents: 1, id_map: { source: 'restored' },
        browser_data: { easypaper_memos_source: '{"1":[{"text":"backup memo"}]}' },
        system_settings: { ollama_host: 'http://localhost:11434' },
      } })
    })
    await page.route('**/api/settings/system', async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      settingsSaves++
      return route.fulfill(failSettings
        ? { status: 500, json: { detail: 'write failed' } }
        : { json: { status: 'success' } })
    })
    await page.route('**/api/user-data/export', async route => {
      exports++
      await exportGate
      return route.fulfill(exportSucceeds
        ? { contentType: 'application/zip', body: Buffer.from('ZIP') }
        : { status: 500, json: { detail: 'export failed' } })
    })
    await openTransfer(page)
    await page.locator('#user-data-system-settings').check()
    const archive = { name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from('ZIP') }
    await page.locator('#user-data-file').setInputFiles(archive)
    await page.locator('.custom-confirm-modal .confirm-btn').click()
    await expect(page.locator('#user-data-status')).toContainText('write failed')
    await expect(page.locator('#user-data-retry')).toBeEnabled()
    await expect(page.locator('#user-data-import')).toBeDisabled()
    await page.locator('#user-data-export').dispatchEvent('click')
    await expect.poll(() => exports).toBe(1)
    await expect(page.locator('#user-data-retry')).toBeDisabled()
    // Even programmatic events must respect the in-flight operation.
    await page.locator('#user-data-retry').dispatchEvent('click')
    expect(settingsSaves).toBe(1)
    releaseExport()
    await expect(page.locator('#user-data-export')).toBeEnabled()
    await expect(page.locator('#user-data-import')).toBeDisabled()
    await expect(page.locator('#user-data-file')).toBeDisabled()
    await expect(page.locator('#user-data-retry')).toBeEnabled()
    // Removing an HTML disabled attribute must not bypass the controller guard.
    await page.locator('#user-data-file').evaluate(input => { input.disabled = false })
    await page.locator('#user-data-file').setInputFiles(archive)
    expect(imports).toBe(1)
    failSettings = false
    await page.locator('#user-data-retry').dispatchEvent('click')
    await expect(page.locator('#user-data-reload')).toBeVisible()
    await expect(page.locator('#user-data-retry')).toBeHidden()
    await expect(page.locator('#user-data-import')).toBeEnabled()
    await expect(page.locator('#user-data-file')).toBeEnabled()
    expect(imports).toBe(1)
    expect(settingsSaves).toBe(2)
    expect(await page.evaluate(() => localStorage.getItem('easypaper_memos_restored'))).toBe('{"1":[{"text":"backup memo"}]}')
  })
}

test('cancelled import can select the same ZIP again through the import button', async ({ page }) => {
  await mockBaseRoutes(page)
  let imports = 0
  await page.route('**/api/user-data/import', route => {
    imports++
    return route.fulfill({ json: { documents: 0, id_map: {}, browser_data: {}, system_settings: {} } })
  })
  await openTransfer(page)
  const archive = { name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from('ZIP') }
  for (const accept of [false, true]) {
    const chooser = page.waitForEvent('filechooser')
    await page.locator('#user-data-import').click()
    await (await chooser).setFiles(archive)
    await expect(page.locator('.custom-confirm-modal')).toBeVisible()
    await expect(page.locator('#user-data-import')).toBeDisabled()
    expect(imports).toBe(0)
    await page.locator(`.custom-confirm-modal .${accept ? 'confirm' : 'cancel'}-btn`).click()
    await expect(page.locator('#user-data-import')).toBeEnabled()
    await expect(page.locator('#user-data-file')).toHaveValue('')
  }
  await expect(page.locator('#user-data-reload')).toBeVisible()
  expect(imports).toBe(1)
})

test('data transfer uses settings typography and keeps recovery actions hidden', async ({ page }) => {
  await mockBaseRoutes(page)
  await openTransfer(page)
  for (const light of [false, true]) {
    await page.evaluate(light => document.body.classList.toggle('light-theme', light), light)
    const description = page.locator('[data-i18n="settings:dataTransfer.description"]')
    await expect(description).toHaveCSS('font-size', '12.5px')
    const color = await description.evaluate(el => getComputedStyle(el).getPropertyValue('--text-secondary').trim())
    expect(await description.evaluate(el => getComputedStyle(el).color)).toBe(await description.evaluate((el, color) => {
      const probe = document.createElement('span'); probe.style.color = color; el.append(probe)
      const result = getComputedStyle(probe).color; probe.remove(); return result
    }, color))
    await expect(page.locator('#user-data-system-settings')).toHaveCSS('width', '16px')
    await expect(page.locator('#user-data-retry')).toBeHidden()
    await expect(page.locator('#user-data-reload')).toBeHidden()
    const fonts = await page.locator('#user-data-export').evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(document.body).fontFamily])
    expect(fonts[0]).toBe(fonts[1])
  }
})
