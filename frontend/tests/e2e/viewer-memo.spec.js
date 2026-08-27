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

test('뷰어 메모 입력창에 포커스 테두리를 표시하지 않는다', async ({ page }) => {
  await openViewerWithMemo(page)

  const memo = page.locator('.floating-memo[data-id="memo-regression"]')
  await memo.locator('.edit-btn').click()

  const textarea = memo.locator('.floating-memo-textarea')
  await expect(textarea).toBeFocused()
  await expect.poll(() => textarea.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
})


test('메모 편집 중 원격 snapshot은 입력 DOM 교체를 편집 종료까지 미룬다', async ({ page }) => {
  await openViewerWithMemo(page)
  await page.route('**/api/library/doc-memo/annotations', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: {}, updated_at: null, revision: 0, item_versions: {}, tombstones: {} }),
  }))
  await page.route('**/api/library/doc-memo/memos', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      data: { page_1: [{
        id: 'memo-regression', pageNum: 1, sentenceIdx: 0, sentenceText: 'memo anchor',
        content: '다른 기기 메모', x: 10, y: 10,
      }] },
      updated_at: '2026-08-27T00:00:00Z', revision: 2,
      item_versions: { 'memo-regression': 2 }, tombstones: {},
    }),
  }))

  const memo = page.locator('.floating-memo[data-id="memo-regression"]')
  await memo.locator('.edit-btn').click()
  const textarea = memo.locator('.floating-memo-textarea')
  await expect(textarea).toBeFocused()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('easypaper_memos_doc-memo') || '{}')
    return saved.page_1?.[0]?.content
  })).toBe('다른 기기 메모')
  await expect(textarea).toBeVisible()
  await expect(textarea).toHaveValue('메모 내용')

  await textarea.blur()
  await expect(memo.locator('.floating-memo-render')).toContainText('다른 기기 메모')
})


test("키보드로 메모를 이동하고 크기를 조절하면 변경 사항을 알린다", async ({ page }) => {
  await openViewerWithMemo(page)

  const memo = page.locator(`.floating-memo[data-id="memo-regression"]`)
  const header = memo.locator(".floating-memo-header")
  const resizeHandle = memo.locator(".floating-memo-resize-handle")
  const beforeMove = await memo.boundingBox()

  await header.focus()
  await header.press("ArrowRight")
  await expect.poll(async () => (await memo.boundingBox()).x).toBeGreaterThan(beforeMove.x + 3)
  await expect(page.locator("#a11y-live-region")).toContainText("메모 위치")

  const beforeResize = await memo.boundingBox()
  await resizeHandle.focus()
  await resizeHandle.press("Shift+ArrowRight")
  await expect.poll(async () => (await memo.boundingBox()).width).toBeGreaterThan(beforeResize.width + 15)
  await expect(page.locator("#a11y-live-region")).toContainText("메모 크기")
})
