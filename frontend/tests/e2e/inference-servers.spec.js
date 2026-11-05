import { test, expect } from '@playwright/test'
import { mockBaseRoutes } from './helpers.js'

test('administrator selects and edits independent inference servers', async ({ page }) => {
  await mockBaseRoutes(page)
  const servers = [
    { id: 'one', name: 'GPU one', engine: 'ollama', url: 'http://one:11434', models: ['model'], model: 'model', transport: 'https' },
    { id: 'two', name: 'GPU two', engine: 'vllm', url: 'https://two/v1', models: ['model'], model: 'model', transport: 'https' },
  ]
  let personal = {}
  await page.route('**/api/auth/me', route => route.fulfill({ json: { username: 'admin', role: 'master', lab_mode: true } }))
  await page.route('**/api/lab/users', route => route.fulfill({ json: [] }))
  await page.route('**/api/lab/inference', route => route.fulfill({ json: servers[0] }))
  await page.route('**/api/inference/servers', route => route.fulfill({ json: { servers, default_id: 'one' } }))
  await page.route('**/api/me/model-settings', async route => {
    if (route.request().method() === 'PUT') personal = route.request().postDataJSON()
    await route.fulfill({ json: personal })
  })
  await page.goto('/index.html')
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('#settings-nav-lab').click()
  await expect(page.locator('#lab-url')).toHaveValue('http://one:11434')
  await page.locator('#lab-server-select').selectOption('two', { force: true })
  await expect(page.locator('#lab-url')).toHaveValue('https://two/v1')
  await page.locator('#lab-personal-server').selectOption('two', { force: true })
  await page.locator('#lab-personal-form button[type=submit]').click()
  await expect.poll(() => personal.server_id).toBe('two')
  expect(personal.provider).toBe('vllm')
  expect(personal.model).toBe('model')
})
