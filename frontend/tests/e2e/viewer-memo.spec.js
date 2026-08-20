import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

async function openViewerWithMemo(page) {
  const doc = {
    id: 'doc-memo',
    filename: 'Memo.pdf',
    total_pages: 1,
    metadata: { title: 'Memo document' },
    translated_pages: [1],
  }

  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/doc-memo/pdf', route => {
    route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A })
  })
  await page.route('**/api/library/doc-memo/translation/1**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        translation: 'Cached translation for the memo regression test.',
        sentences: [],
      }),
    })
  })

  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_hydrated_doc-memo', '1')
    localStorage.setItem('easypaper_memos_doc-memo', JSON.stringify({
      page_1: [{
        id: 'memo-regression',
        pageNum: 1,
        sentenceIdx: 0,
        sentenceText: 'memo anchor',
        content: '메모 내용',
        x: 10,
        y: 10,
      }],
    }))
    location.hash = '#viewer?id=doc-memo'
  })

  await expect(page.locator('.floating-memo[data-id="memo-regression"]')).toBeVisible()
  await expect(page.locator('#trans-content-1 .trans-text')).toContainText('Cached translation')
}

test('스크롤 가시성 갱신 시 이미 렌더링된 메모 DOM을 유지한다', async ({ page }) => {
  await openViewerWithMemo(page)

  const memo = page.locator('.floating-memo[data-id="memo-regression"]')
  await memo.evaluate(el => { el.dataset.instanceMarker = 'original' })

  await page.setViewportSize({ width: 1280, height: 500 })
  await page.waitForTimeout(200)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(300)

  await expect(memo).toHaveAttribute('data-instance-marker', 'original')
})

test('사용자가 조절한 메모 크기를 저장하고 다시 복원한다', async ({ page }) => {
  await openViewerWithMemo(page)

  const memo = page.locator('.floating-memo[data-id="memo-regression"]')
  await memo.evaluate(el => {
    el.style.width = '360px'
    el.style.height = '280px'
  })

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('easypaper_memos_doc-memo') || '{}')
    const memoData = saved.page_1?.[0]
    return { width: memoData?.width, height: memoData?.height }
  })).toEqual({ width: 360, height: 280 })

  await page.reload()
  await expect(memo).toBeVisible()
  await expect(memo).toHaveCSS('width', '360px')
  await expect(memo).toHaveCSS('height', '280px')
})
