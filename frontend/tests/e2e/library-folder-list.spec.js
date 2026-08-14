import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

const folders = [
  { id: 'folder-root', username: 'admin', parent_id: null, name: 'Research Inbox', color: '#8b5cf6', sort_order: 0, created_at: '2026-08-14T00:00:00Z', updated_at: '2026-08-14T00:00:00Z' },
  { id: 'folder-child', username: 'admin', parent_id: 'folder-root', name: 'Transformers', color: '#4f8ef7', sort_order: 0, created_at: '2026-08-14T00:00:00Z', updated_at: '2026-08-14T00:00:00Z' },
]

test('폴더 리스트를 논문 행처럼 표시하고 메뉴가 스크롤 높이를 늘리지 않는다', async ({ page }) => {
  await mockBaseRoutes(page)
  await page.route('**/api/library/folders', route => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ folders }) })
  })

  await gotoApp(page)
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await page.getByRole('button', { name: '리스트 보기' }).click()

  const grid = page.locator('#library-grid')
  const folder = grid.locator('.library-folder-card[data-folder-id="folder-root"]')
  await expect(folder).toBeVisible()
  await expect(folder.locator('.folder-card-icon')).toBeVisible()
  await expect(folder.locator('.folder-card-meta')).toContainText('논문 0편')
  await expect(folder.locator('.folder-card-meta')).toContainText('하위 폴더 1개')
  await expect(folder.getByTitle('이름 변경')).toBeVisible()
  await expect(folder.getByTitle('폴더 열기')).toBeVisible()

  const before = await grid.evaluate(el => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
  expect(before.scrollHeight).toBeLessThanOrEqual(before.clientHeight)

  await folder.getByTitle('폴더 관리').click()
  const menu = page.locator('.folder-card-actions[data-folder-id="folder-root"]')
  await expect(menu).toBeVisible()
  expect(await menu.evaluate(el => el.parentElement === document.body)).toBe(true)
  expect(await grid.evaluate(el => el.scrollHeight)).toBe(before.scrollHeight)

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  expect(await menu.evaluate(el => el.parentElement?.classList.contains('folder-card-cta'))).toBe(true)
})
