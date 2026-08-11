import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

test('many paper tags stay compact and keep card footer visible', async ({ page }) => {
  const categories = [
    'Large Language Models',
    'Harness Engineering Methodology',
    'Agentic Workflows',
    'Evaluation and Benchmarking',
    'Natural Language Processing',
    'Software Engineering',
    'Developer Tools',
  ]
  const doc = {
    id: 'doc-many-tags',
    filename: 'meta-harness.pdf',
    total_pages: 18,
    created_at: '2026-08-11T00:00:00Z',
    metadata: { title: 'Meta-Harness', categories },
    translated_pages: [],
  }
  await mockBaseRoutes(page, { documents: [doc] })

  await gotoApp(page)
  await page.locator('.sidebar-nav-item[data-page="library"]').click()

  const card = page.locator('.doc-card[data-id="doc-many-tags"]')
  const tags = card.locator('.doc-card-tags')
  await expect(card).toBeVisible()
  await expect(tags.locator('.doc-card-tag')).toHaveCount(3)
  await expect(tags.locator('.doc-card-tag')).toHaveText([
    'Large Language Models',
    'Harness Engineering Methodology',
    '+5',
  ])
  await expect(card.locator('.doc-card-footer')).toBeVisible()

  const [tagsBox, footerBox, cardBox] = await Promise.all([
    tags.boundingBox(),
    card.locator('.doc-card-footer').boundingBox(),
    card.boundingBox(),
  ])
  expect(tagsBox.height).toBeLessThan(30)
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height)
})
