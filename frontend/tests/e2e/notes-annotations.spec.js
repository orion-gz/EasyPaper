import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

const doc = {
  id: 'doc-notes',
  filename: 'notes.pdf',
  total_pages: 3,
  created_at: '2026-01-01T00:00:00Z',
  metadata: { title: 'Notes Paper', primer_shown: true },
  translated_pages: [],
}

async function seedNotes(page) {
  await page.evaluate(() => {
    localStorage.setItem('easypaper_annotations_doc-notes', JSON.stringify({
      page_3: [{ type: 'highlight', text: 'third page', startOffset: 20, endOffset: 30, color: '#eab308', createdAt: '2026-01-03T00:00:00Z' }],
      page_1: [{ type: 'highlight', text: 'first page', startOffset: 0, endOffset: 10, color: '#eab308', createdAt: '2026-01-02T00:00:00Z' }],
      page_2: [{ type: 'highlight', text: 'second page', startOffset: 10, endOffset: 20, color: '#eab308', createdAt: '2026-01-01T00:00:00Z' }],
    }))
    localStorage.setItem('easypaper_memos_doc-notes', JSON.stringify({
      page_1: [{
        id: 'memo_1767225600000', pageNum: 1, sentenceIdx: 0,
        sentenceText: 'memo anchor', content: '- first item\n- second item',
        charStart: 0, charEnd: 10, x: 20, y: 20,
      }],
    }))
  })
}

async function cardTexts(page) {
  const texts = await page.locator('.notes-annotation-card .notes-card-text').allTextContents()
  return texts.map(text => text.trim())
}

test('Notes 주석을 페이지와 생성 시간 기준으로 정렬한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [doc] })
  await gotoApp(page)
  await seedNotes(page)
  await page.click('.sidebar-nav-item[data-page="notes"]')
  await page.click('.notes-tab-btn[data-subtab="highlight"]')

  await expect(page.locator('.notes-annotation-sort-select')).toBeVisible()
  expect(await cardTexts(page)).toEqual(['first page', 'second page', 'third page'])

  await page.selectOption('.notes-annotation-sort-select', 'page-desc')
  expect(await cardTexts(page)).toEqual(['third page', 'second page', 'first page'])

  await page.selectOption('.notes-annotation-sort-select', 'newest')
  expect(await cardTexts(page)).toEqual(['third page', 'first page', 'second page'])

  await page.selectOption('.notes-annotation-sort-select', 'oldest')
  expect(await cardTexts(page)).toEqual(['second page', 'first page', 'third page'])
})

test('Notes 카드가 정확한 뷰어 앵커를 hash에 전달하고 Markdown 리스트 여백을 유지한다', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [doc] })
  await gotoApp(page)
  await seedNotes(page)
  await page.click('.sidebar-nav-item[data-page="notes"]')

  await page.click('.notes-tab-btn[data-subtab="memo"]')
  const list = page.locator('.notes-card-text ul')
  await expect(list).toBeVisible()
  expect(await list.evaluate(el => parseFloat(getComputedStyle(el).paddingInlineStart))).toBeGreaterThan(10)

  const memoCard = page.locator('.notes-annotation-card').first()
  await expect(memoCard).toHaveAttribute('data-page', '1')
  await memoCard.click()
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('page=1')
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('memoId=memo_1767225600000')
})

test('Notes 하이라이트 클릭 시 뷰어의 저장 오프셋 위치를 강조한다', async ({ page }) => {
  const viewerDoc = { ...doc, total_pages: 1 }
  await mockBaseRoutes(page, { documents: [viewerDoc] })
  await page.route('**/api/library/doc-notes/pdf', route => route.fulfill({
    status: 200,
    contentType: 'application/pdf',
    body: SAMPLE_PDF_A,
  }))
  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_annotations_doc-notes', JSON.stringify({
      page_1: [{ type: 'highlight', text: 'sample', startOffset: 0, endOffset: 6, color: '#eab308', createdAt: '2026-01-02T00:00:00Z' }],
    }))
  })
  await page.click('.sidebar-nav-item[data-page="notes"]')
  await page.click('.notes-tab-btn[data-subtab="highlight"]')
  await page.locator('.notes-annotation-card').click()

  await expect(page.locator('#viewer-screen')).toHaveClass(/active/)
  await expect(page.locator('.pdf-annotation-highlight[data-start-offset="0"][data-end-offset="6"]')).toHaveClass(/viewer-note-jump-target/, { timeout: 10_000 })
  await expect(page.locator('#page-input')).toHaveValue('1')
})
