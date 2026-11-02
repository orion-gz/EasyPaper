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
    await expect(page.locator('#lab-status')).toContainText('alice')
    await expect(page.locator('#lab-personal-model')).toHaveValue('test')
    if (role === 'master') {
      await expect(page.locator('#lab-admin')).toBeVisible()
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
