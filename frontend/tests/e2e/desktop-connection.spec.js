import { test, expect } from '@playwright/test'
import { mockBaseRoutes } from './helpers.js'

const localOrigin = 'http://localhost:8934'
const remoteOrigin = 'http://127.0.0.1:8934'

async function desktop(page, initial = {}) {
  await mockBaseRoutes(page)
  await page.addInitScript(() => {
    localStorage.setItem('easypaper_ui_locale', 'ko')
    localStorage.setItem('easypaper_onboarding_version', '1')
    localStorage.setItem('easypaper_tauri_update_check_interval', 'never')
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async () => null,
    }
  })
  const state = { enabled: false, onboarded: false, server_url: '', ...initial }
  const saves = []
  await page.route('**/desktop/connection', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON()
      saves.push(body)
      Object.assign(state, body, { onboarded: true })
    }
    const remote = new URL(route.request().url()).origin === remoteOrigin
    await route.fulfill({ json: {
      ...state, remote, error: null, local_url: localOrigin + '/',
      destination: (state.enabled ? remoteOrigin : localOrigin) + '/',
    } })
  })
  await page.route('**/desktop/download', route => route.fulfill({ json: { status: 'idle' } }))
  return { state, saves }
}

test('onboarding asks for local or remote before loading library data', async ({ page }) => {
  const { saves } = await desktop(page)
  const calls = []
  page.on('request', request => { if (request.url().includes('/api/')) calls.push(request.url()) })
  await page.goto('/index.html')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('EasyPaper를 어디에서 사용할까요?')).toBeVisible()
  await expect(dialog.locator('[value=local]')).toBeChecked()
  await expect(dialog.locator('[data-url]')).toBeDisabled()
  expect(calls).toEqual([])
  await page.screenshot({ path: '/tmp/easypaper-desktop-onboarding.png' })
  await dialog.locator('[data-apply]').click()
  await expect(page.locator('.desktop-connection-badge')).toHaveText('연결: 로컬')
  expect(saves[0].enabled).toBe(false)
})

test('remote selection isolates browser data and switching off restores local data', async ({ page }) => {
  await desktop(page)
  await page.goto('/index.html')
  await page.evaluate(() => localStorage.setItem('local-library-marker', 'preserve me'))
  const dialog = page.getByRole('dialog')
  await dialog.locator('[value=remote]').check()
  await dialog.locator('[data-url]').fill('https://papers.example.com')
  await dialog.locator('[data-apply]').click()
  await expect(page).toHaveURL(new RegExp('^' + remoteOrigin.replaceAll('.', '\\.') + '/'))
  await expect(page.locator('.desktop-connection-badge')).toHaveText('연결: 원격 서버')
  expect(await page.evaluate(() => localStorage.getItem('local-library-marker'))).toBeNull()
  await page.evaluate(() => localStorage.setItem('remote-library-marker', 'server data'))
  await page.locator('.desktop-connection-badge').click()
  await dialog.locator('[value=local]').check()
  await dialog.locator('[data-apply]').click()
  await expect(page.locator('.desktop-connection-badge')).toHaveText('연결: 로컬')
  expect(await page.evaluate(() => localStorage.getItem('local-library-marker'))).toBe('preserve me')
  expect(await page.evaluate(() => localStorage.getItem('remote-library-marker'))).toBeNull()
})

test('settings exposes server connection and failed saves can be retried', async ({ page }) => {
  await desktop(page, { onboarded: true })
  await page.goto('/index.html')
  await expect(page.locator('.desktop-connection-section')).toBeAttached()
  await page.locator('.desktop-connection-badge').click()
  await page.route('**/desktop/connection', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 409, json: { detail: 'Connection port is in use' } }) : route.fallback())
  const dialog = page.getByRole('dialog')
  await dialog.locator('[value=remote]').check()
  await dialog.locator('[data-url]').fill('https://papers.example.com')
  await dialog.locator('[data-apply]').click()
  await expect(dialog.locator('[data-status]')).toHaveText('Connection port is in use')
  await expect(dialog.locator('[data-apply]')).toBeEnabled()
  await expect(page).toHaveURL(/localhost/)
})

test('download shows progress, blocks mode changes, and enables local use on completion', async ({ page }) => {
  await desktop(page, { onboarded: true, enabled: true, server_url: 'https://papers.example.com' })
  let job = { status: 'idle' }
  let downloads = 0
  await page.route('**/desktop/download', route => {
    if (route.request().method() === 'POST') {
      downloads++
      job = { status: 'downloading', bytes: 1024 ** 2 }
    }
    return route.fulfill({ json: job })
  })
  page.on('dialog', dialog => dialog.accept())
  await page.goto(remoteOrigin + '/index.html')
  await expect(page.locator('#page-dashboard.active')).toBeVisible()
  await page.locator('.desktop-connection-badge').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('[data-download]').click()
  await expect(dialog.locator('[data-status]')).toContainText('1.0 MiB')
  await expect(dialog.locator('[data-apply]')).toBeDisabled()
  await expect(dialog.locator('[data-download]')).toBeDisabled()
  job = { status: 'completed', documents: 3 }
  await expect(dialog.locator('[data-status]')).toContainText('문서 3개')
  await expect(dialog.locator('[data-apply]')).toBeEnabled()
  expect(downloads).toBe(1)
})

test('connection controls remain available when the server is offline', async ({ page }) => {
  await desktop(page, { onboarded: true, enabled: true, server_url: 'https://offline.example.com' })
  await page.route('**/api/**', route => route.fulfill({ status: 502, json: { detail: 'Remote server offline' } }))
  await page.goto(remoteOrigin + '/index.html')
  await page.locator('.desktop-connection-badge').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('[value=local]')).toBeEnabled()
  await dialog.locator('[value=local]').check()
  await dialog.locator('[data-apply]').click()
  await expect(page.locator('.desktop-connection-badge')).toHaveText('연결: 로컬')
})

test('web deployments skip desktop controls', async ({ page }) => {
  await mockBaseRoutes(page)
  const controls = []
  page.on('request', request => { if (request.url().includes('/desktop/')) controls.push(request.url()) })
  await page.goto('/index.html')
  await expect(page.locator('#page-dashboard.active')).toBeVisible()
  await expect(page.locator('.desktop-connection-badge')).toHaveCount(0)
  expect(controls).toEqual([])
})
