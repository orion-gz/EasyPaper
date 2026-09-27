import { test, expect } from '@playwright/test'
import fs from 'node:fs'

// Use the production CSP verbatim; Python tests check the web/desktop parity.
const config = JSON.parse(fs.readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url)))
const csp = config.app.security.csp

test('production CSP permits same-origin frames and blocks external ancestors', async ({ page }) => {
  await page.route('**/workspace-csp-child', route => route.fulfill({
    contentType: 'text/html', headers: { 'Content-Security-Policy': csp },
    body: '<!doctype html><title>CSP child</title><p id="ready">Embedded reader</p>',
  }))
  await page.route('**/workspace-csp-host', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>CSP host</title><iframe title="reader" src="http://localhost:8934/workspace-csp-child"></iframe>',
  }))
  await page.goto('/workspace-csp-host')
  await expect(page.frameLocator('iframe').locator('#ready')).toHaveText('Embedded reader')
  const violations = []
  page.on('console', message => { if (/frame-ancestors|ancestor violates|refused to frame/i.test(message.text())) violations.push(message.text()) })
  await page.goto('http://127.0.0.1:8934/workspace-csp-host')
  await expect.poll(() => violations.length).toBeGreaterThan(0)
  await expect(page.frameLocator('iframe').locator('#ready')).toHaveCount(0)
})
