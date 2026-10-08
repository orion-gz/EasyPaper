import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A, openReaderTools } from './helpers.js'

const documents = [{ id: 'minimal-a', filename: 'Minimal.pdf', total_pages: 1,
  metadata: { title: 'Minimal paper', categories: ['hidden-tag'], primer_shown: true }, translated_pages: [] }]
async function setup(page, minimal = true, folders = []) {
  await page.addInitScript(enabled => {
    if (localStorage.getItem('easypaper_minimal_ui') === null) localStorage.setItem('easypaper_minimal_ui', String(enabled))
    localStorage.setItem('easypaper_library_view', 'list')
  }, minimal)
  await mockBaseRoutes(page, { documents, folders })
  await page.route('**/api/library/minimal-a/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await gotoApp(page, { navigateToLibrary: !minimal })
}
async function toggle(page, checked) {
  await page.locator(checked ? '#sidebar-settings-btn' : '#minimal-shell-actions button').first().click()
  await page.locator('label[for="setting-minimal-ui"]').click()
  await expect(page.locator('#setting-minimal-ui')).toBeChecked({ checked })
  await page.locator('#close-settings-btn').click()
}

test('minimal library hides metadata and blocks feature routes, preserving document tools', async ({ page }) => {
  await setup(page)
  await expect(page.locator('#app-sidebar')).toBeHidden()
  await expect(page.locator('#workspace-mode-switch-compact')).toBeVisible()
  await expect(page.locator('.minimal-doc-card')).toHaveCount(1)
  await expect(page.locator('.minimal-doc-card .doc-card-tags, .minimal-doc-card .doc-card-meta, .minimal-doc-card .lib-card-progress')).toHaveCount(0)
  await expect(page.locator('#library-grid')).not.toHaveClass(/list-view/)
  for (const route of ['#dashboard', '#notes', '#chat?id=minimal-a', '#compare?ids=a,b', '#heatmap']) {
    await page.evaluate(hash => { location.hash = hash }, route)
    await expect(page).toHaveURL(/#library$/)
    await expect(page.locator('.workspace-tab')).toHaveCount(1)
  }
  await page.locator('.minimal-card-open').click()
  const reader = page.frameLocator('iframe[data-document-id="minimal-a"]')
  await expect(reader.locator('#document-find')).toBeVisible({ timeout: 20000 })
  await expect(reader.locator('#document-tool-chat')).toBeAttached()
  await expect(reader.locator('#document-tool-notes')).toBeAttached()
  await page.locator('.workspace-tab[data-tab-id="document:minimal-a"] .workspace-tab-close').click()
  await expect(page.locator('.workspace-tab[data-tab-id="page:library"] [role=tab]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.workspace-tab[data-tab-id="page:library"] .workspace-tab-close')).toHaveCount(0)
})

test('live toggle restores hidden feature tabs and original library view', async ({ page }) => {
  await setup(page, false)
  await page.locator('.sidebar-nav-item[data-page="notes"]').click()
  await expect(page.locator('.workspace-tab[data-tab-id="page:notes"]')).toBeVisible()
  await toggle(page, true)
  await expect(page.locator('.workspace-tab[data-tab-id="page:notes"]')).toHaveCount(0)
  await expect(page.locator('.minimal-doc-card')).toHaveCount(1)
  await toggle(page, false)
  await expect(page.locator('.workspace-tab[data-tab-id="page:notes"]')).toBeVisible()
  await expect(page.locator('#app-sidebar')).toBeVisible()
  await expect(page.locator('.doc-list-row')).toHaveCount(1)
})

test('mode switching, reload, shortcuts and narrow layouts keep library reachable', async ({ page }) => {
  await setup(page)
  const library = page.locator('.workspace-tab[data-tab-id="page:library"] [role=tab]')
  await expect(library).toHaveAttribute('aria-selected', 'true')
  await library.focus()
  await page.keyboard.press('Control+w')
  await expect(library).toBeVisible()
  await page.keyboard.press('Control+b')
  await expect(page.locator('#app-sidebar')).toBeHidden()
  await page.locator('#workspace-mode-switch-compact [data-workspace-mode=general]').click()
  await expect(page.locator('body')).toHaveAttribute('data-workspace-mode', 'general')
  await expect(library).toHaveAttribute('aria-selected', 'true')
  await page.locator('#workspace-mode-switch-compact [data-workspace-mode=research]').click()
  await page.reload()
  await expect(page.locator('.minimal-doc-card')).toBeVisible()
  await page.setViewportSize({ width: 600, height: 800 })
  const bounds = await page.locator('#minimal-shell-actions').boundingBox()
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(600)
  await expect(page.locator('#workspace-mode-switch-compact')).toBeVisible()
  await page.screenshot({ path: '/tmp/easypaper-minimal-ui.png' })
})

test('reader settings synchronize without replacing the iframe or losing its draft', async ({ page }) => {
  await setup(page)
  await page.locator('.minimal-card-open').click()
  const frame = page.frameLocator('iframe[data-document-id="minimal-a"]')
  await expect(frame.locator('#document-find')).toBeVisible({ timeout: 20000 })
  await frame.locator('body').evaluate(() => { window.minimalIdentity = 'keep' })
  await openReaderTools(frame)
  await frame.locator('#chat-input').fill('Unsaved draft')
  // The reader's settings use the same immediate preference control.
  await frame.locator('#setting-minimal-ui').evaluate(input => {
    input.checked = false
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#app-sidebar')).toBeVisible()
  expect(await frame.locator('body').evaluate(() => window.minimalIdentity)).toBe('keep')
  await expect(frame.locator('#chat-input')).toHaveValue('Unsaved draft')
  await frame.locator('#setting-minimal-ui').evaluate(input => {
    input.checked = true
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#app-sidebar')).toBeHidden()
  await expect(page.locator('.workspace-tab[data-tab-id="document:minimal-a"] [role=tab]')).toHaveAttribute('aria-selected', 'true')
  expect(await frame.locator('body').evaluate(() => window.minimalIdentity)).toBe('keep')
  await expect(frame.locator('#chat-input')).toHaveValue('Unsaved draft')
})

test('hidden filters are ignored and search and trash use minimal cards', async ({ page }) => {
  await setup(page, false)
  await page.locator('#library-status-tabs [data-status=finished]').click()
  await expect(page.locator('.doc-list-row')).toHaveCount(0)
  await toggle(page, true)
  await expect(page.locator('.minimal-doc-card')).toHaveCount(1)
  await page.route('**/api/library/search?**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ documents }) }))
  await page.locator('#library-search-input').fill('Minimal')
  await expect(page.locator('#library-search-status')).toContainText('1')
  await expect(page.locator('.minimal-doc-card .doc-card-meta')).toHaveCount(0)
  await page.route('**/api/library/trash**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ documents }) }))
  await page.reload()
  await expect(page.locator('#lib-tab-trash')).toBeVisible()
  await page.locator('#lib-tab-trash').click()
  await expect(page.locator('.minimal-doc-card')).toHaveCount(1)
  await page.locator('.minimal-doc-card .doc-card-kebab-btn').click()
  await expect(page.locator('.minimal-doc-card .doc-restore-btn')).toBeVisible()
  await expect(page.locator('.minimal-doc-card .minimal-move-btn')).toHaveCount(0)
})

test('minimal card menus rename, move and delete through existing APIs', async ({ page }) => {
  await setup(page, true, [{ id: 'folder-one', name: 'Reading', parent_id: null, color: '#2563eb' }])
  await page.route('**/api/library/minimal-a/title', route => route.fulfill({ contentType: 'application/json', body: '{}' }))
  await page.locator('.doc-card-kebab-btn').click()
  await page.locator('.minimal-doc-card .doc-edit-btn').click()
  await page.locator('.minimal-doc-card .doc-card-title input').fill('Renamed')
  const renamed = page.waitForRequest(request => request.url().includes('/minimal-a/title') && request.method() === 'PUT')
  await page.locator('.minimal-doc-card .doc-card-title input').press('Enter')
  expect((await renamed).postDataJSON()).toEqual({ title: 'Renamed' })
  await expect(page.locator('.minimal-doc-card .doc-card-title input')).toHaveCount(0)
  await page.route('**/api/library/documents/move', route => route.fulfill({ contentType: 'application/json', body: '{}' }))
  await page.locator('.doc-card-kebab-btn').click()
  await page.locator('.minimal-move-btn').click()
  await expect(page.locator('.minimal-move-dialog')).toBeVisible()
  const picker = page.locator('.minimal-move-dialog .provider-picker-btn')
  await expect(picker).toBeFocused()
  await picker.click()
  await page.locator('.minimal-move-dialog [role=option][data-value="folder-one"]').click()
  await expect(picker).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('.minimal-move-dialog [data-move]')).toBeFocused()
  const moved = page.waitForRequest('**/api/library/documents/move')
  await page.locator('.minimal-move-dialog [data-move]').click()
  expect((await moved).postDataJSON()).toEqual({ doc_ids: ['minimal-a'], folder_id: 'folder-one' })
  await expect(page.locator('.minimal-move-dialog')).toHaveCount(0)
  await page.route('**/api/library/minimal-a', async route => {
    if (route.request().method() === 'DELETE') return route.fulfill({ contentType: 'application/json', body: '{}' })
    return route.fallback()
  })
  await page.locator('.doc-card-kebab-btn').click()
  await page.locator('.minimal-doc-card .doc-card-delete-btn').click()
  const deleted = page.waitForRequest(request => request.url().endsWith('/api/library/minimal-a') && request.method() === 'DELETE')
  await page.locator('.custom-confirm-modal-wrapper .confirm-btn').click()
  await deleted
})
