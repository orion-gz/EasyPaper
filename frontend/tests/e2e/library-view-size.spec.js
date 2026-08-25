import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, reloadToLibrary } from './helpers.js'

const docs = [{
  id: 'doc-card-size',
  filename: 'compact-paper.pdf',
  created_at: '2026-08-14T00:00:00Z',
  total_pages: 12,
  metadata: { title: 'Compact Paper Card', categories: ['VLM', 'Survey'], last_page: 3 },
  translated_pages: [],
}]

const folders = [{
  id: 'folder-card-size',
  name: 'Reading List',
  parent_id: null,
  color: '#4f8ef7',
}]

test('큰 카드, 작은 카드, 리스트 보기를 전환하고 마지막 선택을 기억한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: docs, folders })
  await gotoApp(page)
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await expect(page.locator('#library-screen')).toHaveClass(/active/)

  const grid = page.locator('#library-grid')
  await expect(page.getByRole('button', { name: '큰 카드 보기' })).toHaveAttribute('aria-pressed', 'true')
  await expect(grid).not.toHaveClass(/compact-view|list-view/)
  await expect(grid.locator('.doc-card-tags')).toBeVisible()
  await expect(grid.locator('.doc-card-meta')).toBeVisible()
  const folderCard = grid.locator('.library-folder-card')
  await expect(folderCard).toBeVisible()
  const largeFolderHeight = await folderCard.evaluate(el => el.getBoundingClientRect().height)

  await page.getByRole('button', { name: '작은 카드 보기' }).click()
  await expect(grid).toHaveClass(/compact-view/)
  await expect(grid.locator('.doc-card')).toHaveCount(1)
  await expect(grid.locator('.doc-card-tags')).toBeHidden()
  await expect(grid.locator('.doc-card-meta')).toBeHidden()
  await expect(grid.locator('.lib-card-progress')).toBeHidden()
  const compactFolderHeight = await folderCard.evaluate(el => el.getBoundingClientRect().height)
  const compactDocHeight = await grid.locator('.doc-card').evaluate(el => el.getBoundingClientRect().height)
  expect(compactFolderHeight).toBeLessThan(largeFolderHeight)
  expect(Math.abs(compactFolderHeight - compactDocHeight)).toBeLessThanOrEqual(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('easypaper_library_view'))).toBe('compact')

  await reloadToLibrary(page)
  await expect(page.locator('#library-screen')).toHaveClass(/active/)
  await expect(page.locator('#library-grid')).toHaveClass(/compact-view/)
  await expect(page.getByRole('button', { name: '작은 카드 보기' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '리스트 보기' }).click()
  await expect(page.locator('#library-grid')).toHaveClass(/list-view/)
  await expect(page.locator('#library-grid')).not.toHaveClass(/compact-view/)
  await expect(page.locator('.doc-list-row')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('easypaper_library_view'))).toBe('list')
})
