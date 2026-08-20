import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'


test('워크스페이스 전환은 홈과 데이터 범위를 바꾸고 문서 종류 필터를 제공한다', async ({ page }) => {
  const documents = [
    { id: 'research-1', filename: 'paper.pdf', total_pages: 5, metadata: { title: 'Research Paper' }, translated_pages: [], document_mode: 'research', document_type: 'research_paper', created_at: '2026-01-01T00:00:00Z' },
    { id: 'manual-1', filename: 'manual.pdf', total_pages: 8, metadata: { title: 'Setup Manual' }, translated_pages: [], document_mode: 'general', document_type: 'manual', created_at: '2026-01-02T00:00:00Z' },
    { id: 'book-1', filename: 'book.pdf', total_pages: 120, metadata: { title: 'Example Book' }, translated_pages: [], document_mode: 'general', document_type: 'book', created_at: '2026-01-03T00:00:00Z' },
  ]
  await mockBaseRoutes(page, { documents })
  await page.route('**/api/settings/workspace', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ onboarding_version: 1, current_onboarding_version: 1, preferred_workspace_mode: 'research', document_type_options: {} }),
  }))
  await page.route('**/api/document-types', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ modes: [
      { value: 'research', types: [{ value: 'research_paper', mode: 'research', label: '연구 논문' }] },
      { value: 'general', types: [{ value: 'manual', mode: 'general', label: '매뉴얼' }, { value: 'book', mode: 'general', label: '책' }] },
    ] }),
  }))
  await page.route('**/api/library?*', route => {
    const mode = new URL(route.request().url()).searchParams.get('document_mode') || 'research'
    const filtered = documents.filter(doc => doc.document_mode === mode)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: filtered, total: filtered.length }) })
  })

  await gotoApp(page)
  await expect(page.getByText('Research Paper')).toBeVisible()
  await expect(page.getByText('Setup Manual')).not.toBeVisible()

  await page.locator('#workspace-mode-switch [data-workspace-mode="general"]').click()
  await expect(page.locator('#workspace-page-title')).toHaveText('문서 홈')
  await expect(page.locator('.sidebar-nav-item[data-page="graph"]')).not.toBeVisible()

  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await expect(page.locator('#library-grid').getByText('Setup Manual')).toBeVisible()
  await expect(page.locator('#library-grid').getByText('Example Book')).toBeVisible()
  await expect(page.locator('#lib-compare-toggle-btn')).not.toBeVisible()
  await expect(page.locator('.category-filter-btn', { hasText: '매뉴얼' })).toBeVisible()

  await page.locator('.document-type-chip.general', { hasText: '매뉴얼' }).click()
  await expect(page.locator('#library-grid').getByText('Setup Manual')).toBeVisible()
  await expect(page.locator('#library-grid').getByText('Example Book')).not.toBeVisible()
})
