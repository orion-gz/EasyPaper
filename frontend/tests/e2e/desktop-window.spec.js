import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

async function mockDesktop(page, platform, scale = 1) {
  await page.addInitScript(({ platform, scale }) => {
    Object.defineProperty(navigator, 'userAgent', { get: () => platform === 'windows' ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    if (window.parent !== window) return
    localStorage.setItem('easypaper_ui_scale', String(scale))
    localStorage.setItem('easypaper_tauri_update_check_interval', 'never')
    window.windowCommands = []
    const callbacks = new Map()
    const listeners = new Map()
    let callbackId = 0
    window.nativeWindowState = { maximized: false, fullscreen: false }
    window.emitWindowResize = () => {
      for (const [event, handler] of listeners) if (event === 'tauri://resize') callbacks.get(handler)({ event, id: handler, payload: { width: 800, height: 600 } })
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: callback => { callbacks.set(++callbackId, callback); return callbackId },
      invoke: async (command, args) => {
        window.windowCommands.push(command)
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler }
        if (command === 'plugin:window|is_maximized') return window.nativeWindowState.maximized
        if (command === 'plugin:window|is_fullscreen') return window.nativeWindowState.fullscreen
        if (command === 'plugin:window|toggle_maximize') window.nativeWindowState.maximized = !window.nativeWindowState.maximized
        if (command === 'plugin:app|version') return '1.1.0'
        return null
      },
    }
  }, { platform, scale })
}

const commands = page => page.evaluate(() => window.windowCommands.filter(command => /\|(start_dragging|toggle_maximize|minimize|close)$/.test(command)))

test('Windows integrates controls, preserves tab clicks, and tracks native maximize state', async ({ page }) => {
  await mockDesktop(page, 'windows')
  await mockBaseRoutes(page)
  await gotoApp(page)
  const controls = page.locator('#tab-workspace .desktop-window-controls')
  await expect(controls).toBeVisible()
  await expect(page.locator('.desktop-window-titlebar')).toBeHidden()
  const nav = await page.locator('#tab-workspace .workspace-topnav').boundingBox()
  const sidebar = await page.locator('#app-sidebar').boundingBox()
  expect(nav.x).toBe(0)
  expect(sidebar.y).toBe(nav.y + nav.height)
  await page.evaluate(() => { window.windowCommands = [] })
  await page.locator('.workspace-tab [role=tab]').first().click()
  await page.locator('.workspace-topnav-actions').click({ position: { x: 1, y: 1 } })
  expect(await commands(page)).toEqual([])
  await page.locator('.desktop-workspace-drag').dblclick()
  await expect(controls.locator('[data-window-action=maximize]')).toHaveAttribute('aria-label', '창 복원')
  await controls.locator('[data-window-action=maximize]').click()
  await expect(controls.locator('[data-window-action=maximize]')).toHaveAttribute('aria-label', '창 최대화')
  await page.evaluate(() => { window.nativeWindowState.maximized = true; window.emitWindowResize() })
  await expect(controls.locator('[data-window-action=maximize]')).toHaveAttribute('aria-label', '창 복원')
  await page.locator('#workspace-search-input').focus()
  await page.screenshot({ path: '/tmp/easypaper-window-windows.png' })
  await controls.locator('[data-window-action=minimize]').click()
  await controls.locator('[data-window-action=close]').click()
  expect(await commands(page)).toEqual(['plugin:window|start_dragging', 'plugin:window|toggle_maximize', 'plugin:window|toggle_maximize', 'plugin:window|minimize', 'plugin:window|close'])
})

test('Windows controls stay available on login and return to tabs after login', async ({ page }) => {
  await mockDesktop(page, 'windows')
  await mockBaseRoutes(page)
  await gotoApp(page)
  await page.route('**/api/desktop-test-auth-expired', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }))
  await page.evaluate(() => fetch('/api/desktop-test-auth-expired'))
  await expect(page.locator('#login-screen')).toBeVisible()
  await expect(page.locator('.desktop-window-titlebar .desktop-window-controls')).toBeVisible()
  await page.locator('.desktop-window-drag').click()
  expect(await commands(page)).toContain('plugin:window|start_dragging')
  await page.route('**/api/auth/login', route => route.fulfill({ contentType: 'application/json', body: '{}' }))
  await page.locator('#login-username').fill('admin')
  await page.locator('#login-password').fill('test-password')
  await page.locator('#login-form button[type=submit]').click()
  await expect(page.locator('#tab-workspace .desktop-window-controls')).toBeVisible()
  await expect(page.locator('.desktop-window-titlebar')).toBeHidden()
})

for (const scale of [0.8, 1.25]) test(`macOS reserves native controls at UI scale ${scale} and follows fullscreen`, async ({ page }) => {
  await mockDesktop(page, 'macos', scale)
  await mockBaseRoutes(page)
  await gotoApp(page)
  await expect(page.locator('body')).toHaveClass(/desktop-macos/)
  await expect(page.locator('.desktop-window-controls button')).toHaveCount(0)
  const nav = await page.locator('#tab-workspace .workspace-topnav').boundingBox()
  const tabs = await page.locator('.workspace-tab-controls').boundingBox()
  expect(nav.height).toBeCloseTo(48, 0)
  expect(tabs.x).toBeGreaterThanOrEqual(87)
  await page.evaluate(() => { window.nativeWindowState.fullscreen = true; window.emitWindowResize() })
  await expect(page.locator('body')).toHaveClass(/desktop-fullscreen/)
  expect((await page.locator('.workspace-tab-controls').boundingBox()).x).toBeLessThan(20)
})

test('browser retains its existing sidebar layout and has no window controls', async ({ page }) => {
  await mockBaseRoutes(page)
  await gotoApp(page)
  await expect(page.locator('body')).not.toHaveClass(/desktop-window/)
  await expect(page.locator('.desktop-window-titlebar, .desktop-window-controls')).toHaveCount(0)
  expect((await page.locator('#app-sidebar').boundingBox()).y).toBe(0)
})

test('backend loading screen supports native Windows window actions', async ({ page }) => {
  await mockDesktop(page, 'windows')
  const html = fs.readFileSync(new URL('../../../src-tauri/loading-page/index.html', import.meta.url), 'utf8')
  await page.route('**/loading.html', route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('/loading.html')
  await expect(page.locator('#window-controls button')).toHaveCount(3)
  await page.locator('#window-drag').dblclick()
  for (const button of await page.locator('#window-controls button').all()) await button.click()
  expect(await commands(page)).toEqual(['plugin:window|start_dragging', 'plugin:window|toggle_maximize', 'plugin:window|minimize', 'plugin:window|toggle_maximize', 'plugin:window|close'])
})

for (const scale of [0.8, 1.25]) test(`Windows keeps buttons reachable with a focused search at UI scale ${scale}`, async ({ page }) => {
  await mockDesktop(page, 'windows', scale)
  await page.setViewportSize({ width: 800, height: 600 })
  await mockBaseRoutes(page)
  await gotoApp(page)
  await page.locator('#workspace-search-input').focus()
  const controls = page.locator('#tab-workspace .desktop-window-controls')
  await controls.locator('[data-window-action=minimize]').click()
  const bounds = await controls.boundingBox()
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(801)
  expect(Math.abs(bounds.height - 48)).toBeLessThanOrEqual(1)
  expect(await commands(page)).toEqual(['plugin:window|minimize'])
})

test('desktop reader has one window control group and keeps tab drag separate', async ({ page }) => {
  await mockDesktop(page, 'windows')
  await mockBaseRoutes(page, { documents: [{ id: 'desktop-doc', filename: 'Desktop.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] }] })
  await page.route('**/api/library/desktop-doc/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=desktop-doc' })
  const reader = page.frameLocator('iframe[data-document-id=desktop-doc]')
  await expect(reader.locator('#document-find')).toBeVisible({ timeout: 20000 })
  await expect(reader.locator('.desktop-window-controls, .desktop-window-titlebar')).toHaveCount(0)
  await expect(page.locator('.desktop-window-controls')).toHaveCount(1)
  await page.evaluate(() => { window.windowCommands = [] })
  await page.locator('.workspace-tab[data-tab-id="document:desktop-doc"]').dragTo(page.locator('.workspace-tab[data-tab-id="page:dashboard"]'))
  expect(await commands(page)).toEqual([])
  await page.locator('.workspace-tab[data-tab-id="document:desktop-doc"] .workspace-tab-close').click()
  await expect(page.locator('iframe[data-document-id=desktop-doc]')).toHaveCount(0)
  expect(await commands(page)).toEqual([])
})

for (const platform of ['windows', 'macos']) {
  test(`minimal workspace fills the desktop content area on ${platform}`, async ({ page }) => {
    await mockDesktop(page, platform)
    await page.addInitScript(() => localStorage.setItem('easypaper_minimal_ui', 'true'))
    await mockBaseRoutes(page)
    await gotoApp(page, { navigateToLibrary: false })
    await expect(page.locator('#tab-workspace')).toBeVisible()
    await expect(page.locator('#app-sidebar')).toBeHidden()
    await expect(page.locator('#workspace-mode-switch-compact')).toBeVisible()
    const panel = await page.locator('#workspace-tab-panel').boundingBox()
    expect(panel.x).toBe(0)
    expect(panel.width).toBe(page.viewportSize().width)
    if (platform === 'windows') {
      const controls = page.locator('#tab-workspace .desktop-window-controls')
      await expect(controls).toBeVisible()
      const actions = await page.locator('#minimal-shell-actions').boundingBox()
      const bounds = await controls.boundingBox()
      expect(actions.x + actions.width).toBeLessThanOrEqual(bounds.x)
    }
  })
}
