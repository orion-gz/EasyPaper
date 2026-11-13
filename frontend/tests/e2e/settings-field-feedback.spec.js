import { test, expect } from '@playwright/test'
import { mockBaseRoutes } from './helpers.js'

for (const width of [390, 1280]) {
  test(`SSH errors stay below aligned inputs at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await mockBaseRoutes(page)
    const server = { id: 'ssh', name: 'GPU', engine: 'ollama', url: 'http://localhost:11434', models: ['model'], model: 'model', transport: 'ssh', ssh: { host: 'gpu', port: 22, username: 'user', auth: 'password', host_key: 'confirmed' } }
    await page.route('**/api/auth/me', r => r.fulfill({ json: { username: 'admin', role: 'master', lab_mode: false } }))
    await page.route('**/api/lab/users', r => r.fulfill({ json: [] }))
    await page.route('**/api/lab/inference', r => r.fulfill({ json: server }))
    await page.route('**/api/inference/servers', r => r.fulfill({ json: { servers: [server], default_id: 'ssh' } }))
    await page.goto('/index.html')
    await page.locator('#sidebar-settings-btn').click()
    await page.locator('#settings-nav-lab').click()
    const editor = page.locator('#lab-inference-form .ssh-connection-form')
    const host = editor.locator('[id$="-host"]')
    await expect(host).toHaveValue('gpu')
    await host.fill('')
    await editor.locator('button.btn-secondary').click()
    await expect(host).toHaveAttribute('aria-invalid', 'true')
    const feedback = host.locator('..').locator('.field-feedback')
    await expect(feedback).toBeVisible()
    const inputRect = await host.boundingBox(), errorRect = await feedback.boundingBox()
    expect(errorRect.y).toBeGreaterThanOrEqual(inputRect.y + inputRect.height)
    expect(Math.abs(errorRect.x - inputRect.x)).toBeLessThan(2)
    const portRect = await editor.locator('[id$="-port"]').boundingBox()
    expect(Math.abs(portRect.x + portRect.width - inputRect.x - inputRect.width)).toBeLessThan(2)
    await page.screenshot({ path: testInfo.outputPath('settings-feedback.png'), fullPage: true })
    await host.fill('gpu')
    await expect(feedback).toBeHidden()
    await expect(host).not.toHaveAttribute('aria-invalid', 'true')
  })
}
