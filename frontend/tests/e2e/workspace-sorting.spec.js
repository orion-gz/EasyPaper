import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

const documents = [
  {
    id: 'doc-beta', filename: 'beta.pdf', total_pages: 2, created_at: '2026-01-01T00:00:00Z',
    metadata: { title: 'Beta Paper', last_read_at: '2026-04-01T00:00:00Z' }, translated_pages: [],
  },
  {
    id: 'doc-alpha', filename: 'alpha.pdf', total_pages: 2, created_at: '2026-03-01T00:00:00Z',
    metadata: { title: 'Alpha Paper' }, translated_pages: [],
  },
  {
    id: 'doc-gamma', filename: 'gamma.pdf', total_pages: 2, created_at: '2026-02-01T00:00:00Z',
    metadata: { title: 'Gamma Paper' }, translated_pages: [],
  },
]

async function paperTitles(locator) {
  return locator.allTextContents()
}

test('Notes 논문 목록을 최근 읽은순, 제목순, 업로드순으로 정렬한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents })
  await gotoApp(page)
  await page.click('.sidebar-nav-item[data-page="notes"]')

  const titles = page.locator('.notes-paper-row-title')
  await expect(titles).toHaveCount(3)
  expect(await paperTitles(titles)).toEqual(['Beta Paper', 'Alpha Paper', 'Gamma Paper'])

  await page.selectOption('.notes-sort-select', 'title')
  expect(await paperTitles(titles)).toEqual(['Alpha Paper', 'Beta Paper', 'Gamma Paper'])

  await page.selectOption('.notes-sort-select', 'uploaded')
  expect(await paperTitles(titles)).toEqual(['Alpha Paper', 'Gamma Paper', 'Beta Paper'])
})

test('AI Chats 목록을 논문 업로드순으로 정렬한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents })
  await page.route('**/api/chat/sessions', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      sessions: [
        { doc_id: 'doc-beta', title: 'Beta Paper', created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-04-01T00:00:00Z' },
        { doc_id: 'doc-alpha', title: 'Alpha Paper', created_at: '2026-03-01T00:00:00Z', last_message_at: '2026-02-01T00:00:00Z' },
        { doc_id: 'doc-gamma', title: 'Gamma Paper', created_at: '2026-02-01T00:00:00Z', last_message_at: '2026-03-01T00:00:00Z' },
      ],
    }),
  }))
  await gotoApp(page)
  await page.click('.sidebar-nav-item[data-page="chats"]')

  const titles = page.locator('.aic-paper-title')
  await expect(titles).toHaveCount(3)
  expect(await paperTitles(titles)).toEqual(['Beta Paper', 'Gamma Paper', 'Alpha Paper'])

  await page.click('#aic-sort-btn')
  await page.click('.aic-sort-option[data-sort="uploaded"]')
  expect(await paperTitles(titles)).toEqual(['Alpha Paper', 'Gamma Paper', 'Beta Paper'])
  await expect(page.locator('#aic-sort-label')).toHaveText('업로드순')
})
