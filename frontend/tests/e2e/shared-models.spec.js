import { test, expect } from '@playwright/test'
import { mockBaseRoutes } from './helpers.js'

async function setup(page, role = 'master') {
  await mockBaseRoutes(page, { languageSettings: { ui_locale: 'en', default_source_language: 'auto', target_language: 'ko' } })
  const server = { id: 'gpu', name: 'Lab GPU', engine: 'ollama', url: 'http://gpu:11434', models: [], model: '', transport: 'https' }
  const rows = []
  const requests = []
  const maintenance = { allowed: false }
  await page.route('**/api/auth/me', route => route.fulfill({ json: { username: role, role, lab_mode: true } }))
  await page.route('**/api/lab/users', route => route.fulfill({ json: [] }))
  await page.route('**/api/lab/inference', route => route.fulfill({ json: server }))
  await page.route('**/api/me/model-settings', route => route.fulfill({ json: {} }))
  await page.route('**/api/inference/servers', route => route.fulfill({ json: { servers: [server], default_id: 'gpu' } }))
  await page.route('**/api/inference/servers/gpu/model-catalog', route => route.fulfill({ json: { models: [{ model_id: 'qwen3.5:4b', name: 'Qwen 3.5 4B', parameters: '4B', provider: 'Qwen', engine: 'ollama', quantization: 'Q4', estimated_vram_gb: 6 }] } }))
  await page.route('**/api/inference/servers/gpu/shared-models*', async route => {
    if (route.request().method() === 'POST') {
      requests.push(route.request().postDataJSON())
      rows.push({ id: 'job', model_id: requests.at(-1).model_id, engine: 'ollama', status: 'Downloading', enabled: false, total: 1024 ** 3, completed: 512 * 1024 ** 2, percent: 50 })
      return route.fulfill({ json: rows.at(-1), status: 202 })
    }
    return route.fulfill({ json: { models: rows, file_deletion: maintenance } })
  })
  await page.route('**/api/inference/servers/gpu/shared-models/job', async route => {
    if (route.request().method() === 'DELETE') rows.length = 0
    else {
      const { action } = route.request().postDataJSON()
      if (action === 'disable') { rows[0].enabled = false; server.models = []; server.model = '' }
      if (action === 'retry') { rows[0].status = 'Downloading'; rows[0].error = null }
      if (action === 'cancel') rows[0].status = 'Cancelled'
    }
    return route.fulfill({ json: rows[0] || {} })
  })
  await page.goto('/index.html')
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('#settings-nav-lab').click()
  await expect(page.locator('#lab-inference-form')).not.toHaveAttribute('inert', '')
  return { server, rows, requests, maintenance }
}

test('master adds a recommendation, returns to progress, and disables sharing', async ({ page }) => {
  const { server, rows, requests } = await setup(page)
  await expect(page.locator('#lab-models')).toHaveCount(0)
  await page.locator('#lab-model-recommendation').selectOption('qwen3.5:4b', { force: true })
  await expect(page.locator('#lab-model-id')).toHaveValue('qwen3.5:4b')
  await page.getByRole('button', { name: 'Add and download', exact: true }).click()
  await expect(page.locator('#lab-shared-model-list')).toContainText('50%')
  expect(requests).toEqual([{ model_id: 'qwen3.5:4b' }])
  await expect(page.locator('#lab-personal-shared-model option')).toHaveCount(0)
  await page.locator('#settings-nav-account').click()
  await page.locator('#settings-nav-lab').click()
  await expect(page.locator('#lab-shared-model-list')).toContainText('Downloading')
  rows[0] = { ...rows[0], status: 'Completed', enabled: true, verified: true, completed: 1024 ** 3, percent: 100, available: true }
  server.models = ['qwen3.5:4b']; server.model = 'qwen3.5:4b'
  await expect(page.locator('#lab-shared-model-list')).toContainText('Completed', { timeout: 10000 })
  await expect(page.locator('#lab-personal-shared-model')).toHaveValue('qwen3.5:4b')
  await page.locator('#lab-shared-model-list').getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(page.locator('#lab-personal-shared-model option')).toHaveCount(0)
  await page.locator('#lab-shared-model-list').getByRole('button', { name: 'Remove sharing (keep files)' }).click()
  await expect(page.locator('#lab-shared-model-list')).toContainText('No shared models')
})

test('direct input displays failures safely and allows retry and cancellation', async ({ page }) => {
  const { rows } = await setup(page)
  await page.locator('#lab-model-id').fill('custom:tag')
  await expect(page.locator('#lab-model-id')).toHaveValue('custom:tag')
  await page.getByRole('button', { name: 'Add and download', exact: true }).click()
  await expect(page.locator('#lab-shared-model-list')).toContainText('custom:tag')
  rows[0].status = 'Failed'; rows[0].error = '<script>invalid model</script>'
  await expect(page.locator('#lab-shared-model-list')).toContainText('<script>invalid model</script>')
  await expect(page.locator('#lab-shared-model-list script')).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry / verify' }).click()
  await expect(page.locator('#lab-shared-model-list')).toContainText('Downloading')
  await page.getByRole('button', { name: 'Cancel download' }).click()
  await expect(page.locator('#lab-shared-model-list')).toContainText('Cancelled')
})

test('member model choices synchronize without management controls', async ({ page }) => {
  const { server } = await setup(page, 'member')
  await page.locator('#settings-nav-model').click()
  await expect(page.locator('#lab-admin')).toBeHidden()
  server.models = ['qwen3.5:4b']; server.model = 'qwen3.5:4b'
  await expect(page.locator('#lab-personal-shared-model')).toHaveValue('qwen3.5:4b', { timeout: 10000 })
  server.models = []; server.model = ''
  await expect(page.locator('#lab-personal-shared-model option')).toHaveCount(0, { timeout: 10000 })
})

test('switching to personal CLI providers preserves a usable text input', async ({ page }) => {
  await setup(page, 'member')
  await page.locator('#settings-nav-model').click()
  await expect(page.locator('#lab-personal-form')).not.toHaveAttribute('inert', '')
  await page.locator('#lab-personal-provider').selectOption('codex', { force: true })
  await expect(page.locator('#lab-personal-model')).toBeVisible()
  await page.locator('#lab-personal-model').fill('personal-model')
  await page.locator('#lab-personal-provider').selectOption('ollama', { force: true })
  await expect(page.locator('#lab-personal-model')).toBeHidden()
  await page.locator('#lab-personal-provider').selectOption('codex', { force: true })
  await expect(page.locator('#lab-personal-model')).toHaveValue('personal-model')
  await expect(page.locator('#lab-personal-model')).toBeEditable()
})


test('file deletion requires maintenance and disabled sharing, then explicit confirmation', async ({ page }) => {
  const { rows, maintenance } = await setup(page)
  rows.push({ id: 'job', model_id: 'custom:tag', engine: 'ollama', status: 'Completed', enabled: true })
  const button = page.getByRole('button', { name: 'Delete model files', exact: true })
  await expect(button).toBeDisabled()
  maintenance.allowed = true
  await expect(button).toBeDisabled()
  rows[0].enabled = false
  await expect(button).toBeEnabled()
  let deleted = false
  await page.route('**/shared-models/job?delete_files=true', route => {
    expect(route.request().method()).toBe('DELETE')
    deleted = true; rows.length = 0
    return route.fulfill({ json: { deleted: true, files_deleted: true } })
  })
  page.once('dialog', dialog => dialog.dismiss())
  await button.click()
  expect(deleted).toBe(false)
  page.once('dialog', dialog => dialog.accept())
  await button.click()
  await expect(page.locator('#lab-shared-model-list')).toContainText('No shared models')
  expect(deleted).toBe(true)
})
