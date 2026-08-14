import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

test('card title edit persists after reload', async ({ page }) => {
  const doc = {
    id: 'doc-title',
    filename: 'paper.pdf',
    total_pages: 3,
    created_at: '2026-08-11T00:00:00Z',
    metadata: { title: 'Original title' },
    translated_pages: [],
  }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/doc-title/title', async route => {
    expect(route.request().method()).toBe('PUT')
    const payload = route.request().postDataJSON()
    doc.metadata = { ...doc.metadata, title: payload.title }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', title: payload.title, metadata: doc.metadata }),
    })
  })

  await gotoApp(page)
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await expect(page.locator('#library-screen')).toHaveClass(/active/)
  const card = page.locator('.doc-card[data-id="doc-title"]')
  await expect(card.locator('.doc-card-title')).toHaveText('Original title')

  await card.locator('.doc-edit-btn').click()
  const input = card.locator('.doc-card-title input')
  await input.fill('Persisted title')
  await input.press('Enter')
  await expect(card.locator('.doc-card-title')).toHaveText('Persisted title')

  await page.reload()
  await page.waitForTimeout(600)
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await expect(page.locator('#library-screen')).toHaveClass(/active/)
  await expect(page.locator('.doc-card[data-id="doc-title"] .doc-card-title'))
    .toHaveText('Persisted title')
})
