import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

test('processing badge appears only in the library detail panel', async ({ page }) => {
  const doc = {
    id: 'doc-external-transfer',
    filename: 'external-transfer.pdf',
    total_pages: 12,
    created_at: '2026-08-26T00:00:00Z',
    metadata: { title: 'External Transfer Paper' },
    translated_pages: [],
    processing: {
      badge: 'external_transfer',
      transfer_items: ['document_text'],
      document_policy: 'inherit',
    },
  }
  await mockBaseRoutes(page, { documents: [doc] })

  await gotoApp(page)

  const card = page.locator('.doc-card[data-id="doc-external-transfer"]')
  await expect(card).toBeVisible()
  await expect(card.locator('.processing-badge')).toHaveCount(0)

  await card.click()

  const detailPanel = page.locator('#lib-detail-panel')
  await expect(detailPanel).toHaveClass(/open/)
  await expect(detailPanel.locator('#lib-detail-processing-badge .processing-badge')).toHaveText('외부 전송')
})
