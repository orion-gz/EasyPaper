import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'
// Keep the mocked SSE connection open; fulfill() would immediately close it.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__labEvents = []
    window.EventSource = class {
      constructor(url) { this.url = url; window.__labEvents.push(this) }
      close() { this.closed = true }
    }
  })
})


test('Lab selection excludes personal models and restores personal controls', async ({ page }) => {
  await mockBaseRoutes(page)
  let enabled = true
  let preference = { provider: 'ollama', server_id: 'shared', model: 'shared-model' }
  const models = [{ server_id: 'shared', provider: 'ollama', model: 'shared-model', name: 'Lab GPU', state: 'idle', available: true, active_requests: 0, queued_requests: 0 }]
  await page.route('**/api/auth/me', route => route.fulfill({ json: { username: 'alice', role: 'member', lab_mode: enabled } }))
  await page.route('**/api/lab/models', route => route.fulfill({ json: { enabled, models } }))
  await page.route('**/api/lab/models/events', route => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ enabled, models })}\n\n` }))
  await page.route('**/api/me/model-settings', route => {
    if (route.request().method() === 'PUT') preference = route.request().postDataJSON()
    return route.fulfill({ json: preference })
  })
  await page.route('**/api/me/providers/codex', route => route.fulfill({ json: { status: 'disconnected' } }))
  await gotoApp(page)
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easypaper:open-settings', { detail: { category: 'tab-model' } })))
  await expect(page.locator('#lab-model-settings')).toBeVisible()
  await expect(page.locator('#setting-default-ai-provider')).toBeHidden()
  await expect(page.locator('#lab-personal-form')).toBeHidden()
  const select = page.locator('#lab-model-selection')
  await expect(select.locator('option')).not.toContainText(['qwen3.5:9b'])
  await expect(select).toContainText('Codex')
  await expect(select).toContainText('Claude Code')
  await expect(select).toContainText('Antigravity')
  await expect(select).toContainText('shared-model')
  const codex = await select.locator('option').evaluateAll(options => options.find(option => option.textContent.startsWith('Codex')).value)
  await select.selectOption(codex)
  await expect(page.locator('#lab-model-settings > p')).toContainText('로그인')
  expect(preference.provider).toBe('codex')
  await page.evaluate(() => window.__labEvents.at(-1).onerror())
  await expect(select.locator('option').filter({ hasText: 'shared-model' })).toBeDisabled()
  await page.evaluate(models => window.__labEvents.at(-1).onmessage({ data: JSON.stringify({ enabled: true, models }) }), models)
  await expect(select.locator('option').filter({ hasText: 'shared-model' })).toBeEnabled()
  enabled = false
  await page.evaluate(() => window.dispatchEvent(new Event('lab-mode-changed')))
  await expect(page.locator('#lab-model-settings')).toBeHidden()
  await expect(page.locator('#setting-default-ai-provider')).toBeVisible()
})

test('authentication input reaches only the chosen provider', async ({ page }) => {
  await mockBaseRoutes(page)
  await page.route('**/api/auth/me', route => route.fulfill({ json: { username: 'alice', role: 'member', lab_mode: true } }))
  await page.route('**/api/lab/models', route => route.fulfill({ json: { enabled: true, models: [] } }))
  await page.route('**/api/lab/models/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }))
  await page.route('**/api/me/model-settings', route => route.fulfill({ json: {} }))
  await page.route('**/api/me/providers/codex/login', route => route.fulfill({ json: { status: 'pending', instructions: 'Enter the code from your browser.' } }))
  let sent
  await page.route('**/api/me/providers/codex/input', route => { sent = route.request().postDataJSON(); return route.fulfill({ json: { accepted: true } }) })
  await gotoApp(page)
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easypaper:open-settings', { detail: { category: 'tab-model' } })))
  const card = page.locator('#lab-model-settings > div').filter({ has: page.getByRole('heading', { name: 'Codex', exact: true }) })
  await card.locator('button').nth(1).click()
  await expect(card.locator('pre')).toContainText('Enter the code')
  await card.locator('input').fill('private-code')
  await card.locator('input').press('Enter')
  await expect(card.locator('input')).toHaveValue('')
  await expect.poll(() => sent).toEqual({ text: 'private-code\n' })
  await expect(page.locator('#lab-model-settings')).not.toContainText('private-code')
})
