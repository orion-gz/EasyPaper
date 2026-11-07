import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

for (const role of ['master', 'member']) {
  test(`Lab Mode displays ${role} controls on the connected server`, async ({ page }) => {
    await mockBaseRoutes(page)
    await page.route('**/api/auth/me', route => route.fulfill({ json: { username: 'alice', role, lab_mode: true } }))
    await page.route('**/api/lab/inference', route => route.fulfill({ json: { engine: 'ollama', url: 'http://localhost:11434', models: ['test'], model: 'test' } }))
    await page.route('**/api/me/model-settings', route => route.fulfill({ json: {} }))
    await page.route('**/api/lab/users', route => route.fulfill({ json: [{ id: 'member-id', username: '<script>alert(1)</script>', role: 'member', active: true }] }))
    await gotoApp(page)
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('easypaper:open-settings', { detail: { category: 'tab-general' } })))
    await page.locator('#settings-nav-lab').click()
    await expect(page.locator('#tab-lab')).toBeVisible()
    await expect(page.locator('#settings-nav-account + #settings-nav-lab')).toHaveCount(1)
    const openGuide = page.locator('#tab-lab .lab-introduction > button').first()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openGuide.click()
    const guide = page.locator('.lab-guide-dialog')
    const next = guide.locator('.lab-guide-footer button').last()
    const nextScene = guide.locator('.lab-guide-controls button').nth(3)
    await expect(guide).toBeVisible()
    await expect(guide.locator('.lab-guide-progress')).toHaveText('STEP 1 / 3')
    await expect(guide.locator('.lab-guide-footer button').first()).toBeDisabled()
    await expect(guide.locator('.lab-demo-transcript')).toContainText('install-docker.sh')
    await nextScene.click()
    await expect(guide.locator('.lab-demo-transcript')).toContainText('install-inference.sh')
    while (await nextScene.isEnabled()) await nextScene.click()
    await next.click()
    await expect(guide.locator('.lab-guide-progress')).toHaveText('STEP 2 / 3')
    await expect(guide.locator('.lab-guide-choices button').first()).toHaveAttribute('aria-pressed', 'true')
    await next.click()
    await expect(guide.locator('.lab-demo-transcript')).toContainText('ssh -o ExitOnForwardFailure')
    while (await nextScene.isEnabled()) await nextScene.click()
    await next.click()
    await expect(guide).not.toBeVisible()
    await expect(openGuide).toBeFocused()
    await openGuide.click()
    await expect(guide.locator('.lab-guide-progress')).toHaveText('STEP 1 / 3')
    await expect(guide.locator('.lab-guide-controls button').nth(1)).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(guide).not.toBeVisible()
    await page.locator('#lab-personal-form .lab-help-button').first().click()
    await expect(page.locator('#lab-personal-provider-help')).toBeVisible()
    await expect(page.locator('#lab-personal-form .lab-field-heading').first().locator('.lab-help-button')).toHaveCSS('width', '16px')
    await page.locator('#lab-personal-model').click()
    await expect(page.locator('#lab-personal-provider-help')).toBeHidden()
    await expect(page.locator('#lab-personal-form .lab-help-button').first()).toHaveAttribute('aria-expanded', 'false')
    await page.locator('#lab-personal-form .lab-help-button').first().click()
    await page.locator('#lab-personal-form .lab-help-button').last().click()
    await expect(page.locator('#lab-personal-provider-help')).toBeHidden()
    await expect(page.locator('#lab-personal-model-help')).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.keyboard.press('Escape')
    await page.locator('#lab-personal-form .lab-help-button').last().click()
    const popup = await page.locator('#lab-personal-model-help').boundingBox()
    expect(popup.x).toBeGreaterThanOrEqual(0)
    expect(popup.x + popup.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: `/tmp/lab-settings-${role}.png` })
    await page.keyboard.press('Escape')
    await expect(page.locator('#lab-personal-model-help')).toBeHidden()
    await expect(page.locator('#lab-status')).toContainText('alice')
    await expect(page.locator('#lab-personal-model')).toHaveValue('test')
    if (role === 'master') {
      await expect(page.locator('#lab-admin')).toBeVisible()
      const enabled = await page.locator('#lab-enabled').isChecked()
      await page.locator('#lab-mode-form .lab-help-button').first().click()
      await expect(page.locator('#lab-enabled-help')).toBeVisible()
      await expect(page.locator('#lab-enabled')).toBeChecked({ checked: enabled })
      await expect(page.locator('.lab-delete-button')).toHaveCount(1)
      await expect(page.locator('.lab-delete-button')).toHaveCSS('background-color', 'rgb(239, 68, 68)')
      await expect(page.locator('#lab-members')).toContainText('<script>alert(1)</script>')
      await expect(page.locator('#lab-members script')).toHaveCount(0)
    } else {
      await expect(page.locator('#lab-admin')).toBeHidden()
    }
  })
}

test('switching server accounts archives browser drafts outside exported localStorage', async ({ page }) => {
  await mockBaseRoutes(page)
  await page.route('**/api/auth/check', route => route.fulfill({ json: { status: 'authenticated', username: 'bob', account_id: 'bob-id' } }))
  await page.addInitScript(() => {
    if (!localStorage.getItem('__lab_test_seeded')) {
      localStorage.setItem('__lab_test_seeded', '1')
      localStorage.setItem('__easypaper_active_account', 'alice-id')
      localStorage.setItem('easypaper_test_draft', 'Alice private draft')
    }
  })
  await gotoApp(page)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('__easypaper_active_account'))).toBe('bob-id')
  expect(await page.evaluate(() => localStorage.getItem('easypaper_test_draft'))).toBeNull()
  const archived = await page.evaluate(async () => new Promise((resolve, reject) => {
    const open = indexedDB.open('easypaper-account-storage', 1)
    open.onsuccess = () => {
      const request = open.result.transaction('accounts').objectStore('accounts').get('alice-id')
      request.onsuccess = () => { resolve(request.result); open.result.close() }
      request.onerror = () => reject(request.error)
    }
  }))
  expect(archived.easypaper_test_draft).toBe('Alice private draft')
})

test('personal CLI login polls instructions and stops after switching to a common engine', async ({ page }) => {
  await mockBaseRoutes(page)
  await page.route('**/api/auth/me', route => route.fulfill({ json: { username: 'alice', role: 'member', lab_mode: true } }))
  await page.route('**/api/lab/inference', route => route.fulfill({ json: { engine: 'ollama', models: ['test'], model: 'test' } }))
  await page.route('**/api/me/model-settings', route => route.fulfill({ json: { provider: 'codex', model: 'test' } }))
  await page.route('**/api/me/providers/codex/login', route => route.fulfill({ json: { status: 'pending' } }))
  let polls = 0
  await page.route('**/api/me/providers/codex', route => {
    polls += 1
    return route.fulfill({ json: { status: 'pending', instructions: 'Enter code TEST-CODE in your browser' } })
  })
  await gotoApp(page)
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easypaper:open-settings', { detail: { category: 'tab-general' } })))
  await page.locator('#settings-nav-lab').click()
  await page.locator('#lab-cli-login').click()
  await expect(page.locator('#lab-cli-output')).toContainText('TEST-CODE')
  await page.evaluate(() => {
    const select = document.getElementById('lab-personal-provider')
    select.value = 'ollama'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#lab-cli-actions')).toBeHidden()
  const count = polls
  await page.waitForTimeout(2200)
  expect(polls).toBe(count)
})
