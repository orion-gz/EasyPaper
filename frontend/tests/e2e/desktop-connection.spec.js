import { test, expect } from '@playwright/test'
import { mockBaseRoutes, activeReader, SAMPLE_PDF_A } from './helpers.js'

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
  await dialog.locator('.desktop-copy-option summary').click()
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

test('sync defaults to defer and offers explicit local or server replacement', async ({ page }) => {
  await desktop(page, { onboarded: true, enabled: true, server_url: 'https://papers.example.com' })
  await page.goto(remoteOrigin + '/index.html')
  await page.locator('.desktop-connection-badge').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('[data-action]')).toHaveValue('defer')
  await expect(dialog.locator('[data-sync]')).toBeDisabled()
  await expect(dialog.locator('[data-automatic]')).toBeDisabled()
  await expect(dialog.locator('[data-action] option')).toHaveCount(4)
  await dialog.locator('[data-action]').selectOption('merge')
  await expect(dialog.locator('[data-sync]')).toBeEnabled()
  await expect(dialog.locator('[data-automatic]')).toBeEnabled()
  await dialog.locator('[data-automatic]').check()
  await dialog.locator('[data-action]').selectOption('replace_remote')
  await expect(dialog.locator('[data-automatic]')).not.toBeChecked()
  await expect(dialog.locator('[data-automatic]')).toBeDisabled()
})

for (const action of ['merge', 'replace_local', 'replace_remote']) {
  test(`${action} previews counts and only starts after confirmation`, async ({ page }) => {
    await desktop(page, { onboarded: true, enabled: true, server_url: 'https://papers.example.com' })
    let started = 0
    let job = { status: 'idle' }
    await page.route('**/desktop/sync/preview', route => route.fulfill({ json: {
      plan_id: 'plan-123', action: route.request().postDataJSON().action,
      local_documents: 2, remote_documents: 5,
    } }))
    await page.route('**/desktop/sync', route => {
      expect(route.request().postDataJSON()).toMatchObject({ plan_id: 'plan-123', confirmed: true })
      started++
      job = { kind: 'sync', status: 'uploading', bytes: 0 }
      return route.fulfill({ status: 202, json: job })
    })
    await page.route('**/desktop/download', route => route.fulfill({ json: job }))
    await page.goto(remoteOrigin + '/index.html')
    await expect(page.locator('#page-dashboard.active')).toBeVisible()
    await page.locator('.desktop-connection-badge').click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('[data-action]').selectOption(action)
    await dialog.locator('[data-sync]').click()
    await expect(dialog.locator('[data-preview-summary]')).toContainText('문서 2개')
    await expect(dialog.locator('[data-preview-summary]')).toContainText('문서 5개')
    expect(started).toBe(0)
    await expect(dialog.locator('[data-action]')).toBeDisabled()
    await dialog.locator('[data-cancel-sync]').click()
    await expect(dialog.locator('[data-preview]')).toBeHidden()
    expect(started).toBe(0)
    await dialog.locator('[data-sync]').click()
    if (action.startsWith('replace_')) {
      await expect(dialog.locator('[data-confirm-sync]')).toBeDisabled()
      await expect(dialog.locator('[data-acknowledge]')).toBeFocused()
      await dialog.locator('[data-acknowledge]').check()
    }
    await expect(dialog.locator('[data-confirm-sync]')).toBeEnabled()
    await page.screenshot({ path: `/tmp/easypaper-sync-${action}.png` })
    await dialog.locator('[data-confirm-sync]').click()
    await expect(dialog.locator('[data-status]')).toContainText('서버로 보내는 중')
    await expect(dialog.locator('[data-action]')).toBeDisabled()
    job = { kind: 'sync', status: 'completed', documents: 7 }
    await expect(dialog.locator('[data-status]')).toContainText('양방향 동기화를 완료')
    await expect(dialog.locator('[data-action]')).toHaveValue('merge')
    await expect(dialog.locator('[data-policy] .provider-picker-btn')).toContainText('병합')
    await expect(dialog.locator('[data-reload]')).toBeVisible()
    expect(started).toBe(1)
  })
}

test('sync conflicts stop automatic progress and preserve an explicit choice', async ({ page }) => {
  await desktop(page, { onboarded: true, enabled: true, server_url: 'https://papers.example.com', sync: { action: 'merge', automatic: true } })
  await page.route('**/desktop/download', route => route.fulfill({ json: {
    kind: 'sync', status: 'conflict', conflicts: [{ table: 'memos', key: 'paper', document: '<script>Paper A</script>' }],
  } }))
  await page.goto(remoteOrigin + '/index.html')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-status]')).toContainText('양쪽 변경이 충돌')
  await expect(page.getByRole('dialog').locator('[data-action]')).toBeEnabled()
  await expect(page.getByRole('dialog').locator('[data-automatic]')).not.toBeChecked()
  await expect(page.getByRole('dialog').locator('[data-conflicts]')).toContainText('메모·주석 · <script>Paper A</script>')
  await expect(page.getByRole('dialog').locator('[data-conflicts] script')).toHaveCount(0)
})

test('cancelling a preview does not enable newly selected automatic sync', async ({ page }) => {
  const { state } = await desktop(page, { onboarded: true, enabled: true, server_url: 'https://papers.example.com' })
  await page.route('**/desktop/sync/preview', route => route.fulfill({ json: {
    plan_id: 'preview', action: 'merge', local_documents: 2, remote_documents: 5,
  } }))
  await page.goto(remoteOrigin + '/index.html')
  await expect(page.locator('#page-dashboard.active')).toBeVisible()
  await page.locator('.desktop-connection-badge').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('[data-action]').selectOption('merge')
  await dialog.locator('[data-automatic]').check()
  await dialog.locator('[data-sync]').click()
  await dialog.locator('[data-cancel-sync]').click()
  expect(state.sync.automatic).toBe(false)
})

test('automatic merge runs on an idle remote workspace without a destructive policy', async ({ page }) => {
  await desktop(page, { onboarded: true, enabled: true, server_url: 'https://papers.example.com', sync: { action: 'merge', automatic: true } })
  let started = 0
  await page.route('**/desktop/sync/preview', route => {
    expect(route.request().postDataJSON().action).toBe('merge')
    return route.fulfill({ json: { plan_id: 'auto', action: 'merge', local_documents: 1, remote_documents: 1 } })
  })
  await page.route('**/desktop/sync', route => {
    expect(route.request().postDataJSON()).toMatchObject({ plan_id: 'auto', confirmed: true, automatic: true })
    started++
    return route.fulfill({ status: 202, json: { kind: 'sync', status: 'uploading' } })
  })
  await page.route('**/desktop/download', route => route.fulfill({ json: { kind: 'sync', status: 'completed', documents: 1 } }))
  await page.clock.install()
  await page.goto(remoteOrigin + '/index.html')
  await expect(page.locator('#page-dashboard.active')).toBeVisible()
  await page.clock.fastForward(5 * 60 * 1000)
  await expect.poll(() => started).toBe(1)
})

for (const theme of ['dark', 'light']) {
  test(`connection preview is accessible and fits narrow windows in ${theme} mode`, async ({ page }) => {
    const { default: AxeBuilder } = await import('@axe-core/playwright')
    await desktop(page, { onboarded: true, enabled: true, server_url: 'https://papers.example.com' })
    await page.route('**/desktop/sync/preview', route => route.fulfill({ json: {
      plan_id: 'layout', action: 'replace_remote', local_documents: 1234, remote_documents: 5678,
    } }))
    await page.setViewportSize({ width: 390, height: 720 })
    await page.goto(remoteOrigin + '/index.html')
    await expect(page.locator('#page-dashboard.active')).toBeVisible()
    if (theme === 'light') await page.locator('#sidebar-theme-toggle-btn').click()
    await expect(page.locator('body')).toHaveClass(theme === 'light' ? /light-theme/ : /^(?!.*light-theme).*$/)
    await page.locator('.desktop-connection-badge').click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('[data-action]').selectOption('replace_remote')
    await dialog.locator('[data-sync]').click()
    await expect(dialog.locator('[data-acknowledge]')).toBeFocused()
    await expect(dialog.locator('[data-direction]')).toHaveText('→')
    await expect(dialog.locator('[data-confirm-sync]')).toBeDisabled()
    await expect(dialog.locator('[data-close]')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    const result = await new AxeBuilder({ page }).include('.desktop-connection-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(result.violations).toEqual([])
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/easypaper-connection-${theme}-narrow.png` })
    await dialog.locator('[data-cancel-sync]').click()
    await expect(dialog.locator('[data-sync]')).toBeFocused()
    await dialog.locator('[data-close]').click()
    await expect(page.locator('.desktop-connection-badge')).toBeFocused()
  })
}

for (const action of ['replace_local', 'replace_remote']) {
  test(`offline ${action} resolves user-data conflicts only after confirmation`, async ({ page }) => {
    await desktop(page, {
      onboarded: true, enabled: true, access_mode: 'offline', server_url: 'https://papers.example.com',
      sync: { action: 'merge', automatic: false, offline_ready: true },
    })
    let started = 0
    await page.route('**/desktop/sync/preview', route => {
      expect(route.request().postDataJSON().action).toBe(action)
      return route.fulfill({ json: { plan_id: 'offline-resolution', action, local_documents: 2, remote_documents: 2 } })
    })
    await page.route('**/desktop/sync', route => {
      started++
      return route.fulfill({ status: 202, json: { kind: 'sync', status: 'uploading' } })
    })
    await page.goto(remoteOrigin + '/index.html')
    await page.locator('.desktop-connection-badge').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('[data-access-mode]')).toHaveValue('offline')
    await dialog.locator('[data-action]').selectOption(action)
    await dialog.locator('[data-sync]').click()
    await expect(dialog.locator('[data-preview-warning]')).toContainText('사용자 데이터만')
    await expect(dialog.locator('[data-confirm-sync]')).toBeDisabled()
    expect(started).toBe(0)
    await dialog.locator('[data-acknowledge]').check()
    await dialog.locator('[data-confirm-sync]').click()
    await expect.poll(() => started).toBe(1)
  })
}

test('remote desktop opens a document without recent WebView APIs', async ({ page }) => {
  await desktop(page, { onboarded: true, enabled: true, server_url: 'https://papers.example.com' })
  await page.addInitScript(() => {
    delete Promise.withResolvers
    delete Promise.try
    delete Map.prototype.getOrInsertComputed
    delete Uint8Array.prototype.toBase64
  })
  // addInitScript does not run in workers. Remove the APIs from the actual
  // built worker entry as well, before its compatibility code executes.
  let workerRequested = false
  await page.route('**/assets/pdfWorker-*.js', async route => {
    workerRequested = true
    const response = await route.fetch()
    await route.fulfill({ response, body: `delete Promise.withResolvers; delete Promise.try; delete Map.prototype.getOrInsertComputed; delete Uint8Array.prototype.toBase64;\n${await response.text()}` })
  })
  const doc = { id: 'remote-doc', filename: 'Remote.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] }
  await page.route('**/api/library/remote-doc', route => route.fulfill({ json: doc }))
  await page.route('**/api/library/remote-doc/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  const workerStarted = page.waitForEvent('worker', worker => worker.url().includes('/pdfWorker-'))
  await page.goto(remoteOrigin + '/#viewer?id=remote-doc')
  await expect(activeReader(page).locator('.pdf-page-wrapper canvas')).toBeAttached({ timeout: 15000 })
  expect(workerRequested).toBe(true)
  const worker = await workerStarted
  expect(await worker.evaluate(() => [Promise.withResolvers, Promise.try, Map.prototype.getOrInsertComputed, Uint8Array.prototype.toBase64].every(api => typeof api === 'function'))).toBe(true)
  await expect(activeReader(page).locator('.textLayer span').first()).toBeAttached()
})

test('SSH connection confirms host key and submits password without persisting by default', async ({ page }) => {
  const { saves } = await desktop(page)
  await page.route('**/desktop/ssh/host-key', route => route.fulfill({ json: { host_key: 'ssh-ed25519 TEST', fingerprint: 'SHA256:verified' } }))
  await page.goto('/index.html')
  const dialog = page.getByRole('dialog')
  await dialog.locator('[value=remote]').check()
  await dialog.locator('[data-url]').fill('http://127.0.0.1:8000')
  await dialog.getByRole('combobox', { name: /연결 방식/ }).selectOption('ssh')
  await dialog.getByLabel('호스트', { exact: true }).fill('gpu.example.com')
  await dialog.getByLabel('사용자명', { exact: true }).fill('researcher')
  await dialog.getByLabel('비밀번호', { exact: true }).fill('test-password')
  page.once('dialog', confirmation => confirmation.accept())
  await dialog.getByRole('button', { name: '호스트 키 확인', exact: true }).click()
  await expect(dialog.getByText('SHA256:verified')).toBeVisible()
  await dialog.locator('[data-apply]').click()
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0].transport).toBe('ssh')
  expect(saves[0].ssh.host_key).toBe('ssh-ed25519 TEST')
  expect(saves[0].credentials.password).toBe('test-password')
  expect(saves[0].save_credentials).toBe(false)
})
