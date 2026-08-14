import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

test('지연 로드된 워크스페이스 페이지를 모두 열 수 있다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [] })
  await gotoApp(page)

  const routes = [
    ['dashboard', '.dash-root'],
    ['history', '#rh-stat-grid'],
    ['chats', '.aic-page'],
    ['notes', '.notes-page-inner'],
  ]

  for (const [pageId, renderedSelector] of routes) {
    await page.click(`.sidebar-nav-item[data-page="${pageId}"]`)
    await expect(page.locator(`#page-${pageId}`)).toHaveClass(/active/)
    await expect(page.locator(renderedSelector)).toBeVisible()
  }

  await page.click('.sidebar-nav-item[data-page="graph"]')
  await expect(page.locator('#page-graph')).toHaveClass(/active/)
  await expect(page.locator('#library-graph-canvas canvas').first()).toBeVisible()
})
