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
  await page.locator('#settings-nav-model').click()
  await expect(page.locator('#lab-personal-form')).not.toHaveAttribute('inert')
  await page.locator('#lab-personal-server').selectOption('two', { force: true })
  await page.locator('#lab-personal-form button[type=submit]').click()
  await expect.poll(() => personal.server_id).toBe('two')
  expect(personal.provider).toBe('vllm')
  expect(personal.model).toBe('model')
})

test('SSH editor restores custom pickers and permits memory-only recovery', async ({ page }) => {
  await mockBaseRoutes(page)
  const server = { id: 'ssh', name: 'SSH GPU', engine: 'ollama', url: 'http://localhost:11434',
    models: ['model'], model: 'model', transport: 'ssh', save_credentials: true,
    ssh: { host: 'gpu', port: 22, username: 'user', auth: 'key', host_key: 'confirmed' } }
  await page.route('**/api/auth/me', route => route.fulfill({ json: { username: 'admin', role: 'master', lab_mode: false } }))
  await page.route('**/api/lab/users', route => route.fulfill({ json: [] }))
  await page.route('**/api/lab/inference', route => route.fulfill({ json: server }))
  await page.route('**/api/inference/servers', route => route.fulfill({ json: {
    servers: [server], default_id: 'ssh', credential_storage: { available: false } } }))
  let saved
  await page.route('**/api/inference/servers/ssh', async route => {
    saved = route.request().postDataJSON()
    await route.fulfill({ json: server })
  })
  let reset = false
  await page.route('**/api/me/model-settings', async route => {
    reset ||= route.request().method() === 'DELETE'
    await route.fulfill({ json: {} })
  })
  await page.goto('/index.html')
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('#settings-nav-lab').click()
  const editor = page.locator('#lab-inference-form .ssh-connection-form')
  const transport = editor.locator('select').first()
  const auth = editor.locator('select').last()
  await expect(transport).toHaveValue('ssh')
  await expect(transport.locator('..').locator('.picker-label')).toHaveText('SSH')
  await expect(auth.locator('..').locator('.provider-picker-btn')).toBeVisible()
  await expect(auth.locator('..').locator('.picker-label')).toHaveText('Private key')
  await expect(editor.locator('textarea')).toBeVisible()
  await expect(editor.locator('input[type=checkbox]')).not.toBeChecked()
  await page.locator('#lab-inference-form button[type=submit]').click()
  await expect.poll(() => saved?.save_credentials).toBe(false)
  await page.locator('#settings-nav-model').click()
  await page.getByRole('button', { name: 'Use existing personal model settings' }).click()
  await expect.poll(() => reset).toBe(true)
})
