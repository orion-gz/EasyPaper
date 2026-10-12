import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

test('emptying the trash sends the displayed workspace scope', async ({ page }) => {
  await mockBaseRoutes(page)
  let deletion
  await page.route('**/api/library/trash**', route => {
    if (route.request().method() === 'DELETE') {
      deletion = new URL(route.request().url()).searchParams.get('document_mode')
      return route.fulfill({ json: { message: 'ok' } })
    }
    return route.fulfill({ json: { documents: [{ id: 'trashed', filename: 'paper.pdf', total_pages: 1, metadata: {} }], total: 1 } })
  })
  await gotoApp(page)
  await page.click('#lib-tab-trash')
  await page.click('#lib-empty-trash-btn')
  await page.locator('.custom-confirm-modal .confirm-btn').click()
  await expect.poll(() => deletion).toBe('research')
})
