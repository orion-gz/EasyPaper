import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

test('category filter chips stay collapsed after reload', async ({ page }) => {
  const doc = {
    id: 'doc-filter-collapse',
    filename: 'filter-collapse.pdf',
    total_pages: 5,
    created_at: '2026-08-14T00:00:00Z',
    metadata: { title: 'Filter Collapse', categories: ['Machine Learning'] },
    translated_pages: [],
  }
  await mockBaseRoutes(page, { documents: [doc] })
  await gotoApp(page)
  await page.locator('.sidebar-nav-item[data-page="library"]').click()

  const filters = page.locator('#library-category-filters')
  const toggle = page.locator('#library-category-filter-toggle')
  await expect(filters).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const expandedPositions = await Promise.all([filters.boundingBox(), toggle.boundingBox()])
  expect(expandedPositions[1].x - (expandedPositions[0].x + expandedPositions[0].width)).toBeLessThanOrEqual(4)

  await toggle.click()
  await expect(filters).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const collapsedPositions = await Promise.all([
    page.locator('.library-category-filter-group').boundingBox(),
    toggle.boundingBox(),
  ])
  expect(
    collapsedPositions[0].x + collapsedPositions[0].width
      - (collapsedPositions[1].x + collapsedPositions[1].width),
  ).toBeLessThanOrEqual(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('easypaper_library_category_filters_collapsed'))).toBe('true')

  await page.reload()
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await expect(filters).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await toggle.click()
  await expect(filters).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
})
