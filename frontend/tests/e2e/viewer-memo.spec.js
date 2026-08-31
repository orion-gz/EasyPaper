import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

async function openViewerWithMemo(page, memoOverrides = {}) {
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
  await page.evaluate((overrides) => {
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
        ...overrides,
      }],
    }))
    location.hash = '#viewer?id=doc-memo'
  }, memoOverrides)

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
  await memo.locator('.auto-size-btn').click()
  await expect(page.locator('.floating-memo')).toHaveCount(1)
  await memo.evaluate(el => {
    el.style.width = '360px'
    el.style.height = '900px'
  })

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('easypaper_memos_doc-memo') || '{}')
    const memoData = saved.page_1?.[0]
    return { width: memoData?.width, height: memoData?.height }
  })).toEqual({ width: 360, height: 900 })

  await page.reload()
  await expect(memo).toBeVisible()
  await expect(memo).toHaveCSS('width', '360px')
  await expect(memo).toHaveCSS('height', '900px')
})

test('뷰어 메모 입력창에 포커스 테두리를 표시하지 않는다', async ({ page }) => {
  await openViewerWithMemo(page)

  const memo = page.locator('.floating-memo[data-id="memo-regression"]')
  await memo.locator('.edit-btn').click()

  const textarea = memo.locator('.floating-memo-textarea')
  await expect(textarea).toBeFocused()
  await textarea.fill('굵게')
  await textarea.selectText()
  await textarea.press('ControlOrMeta+b')
  await expect(textarea).toHaveValue('**굵게**')
  await textarea.press('ControlOrMeta+i')
  await expect(textarea).toHaveValue('***굵게***')
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

  await memo.evaluate(el => { el.dataset.instanceMarker = 'before-move' })
  await header.focus()
  await header.press("ArrowRight")
  await expect.poll(async () => (await memo.boundingBox()).x).toBeGreaterThan(beforeMove.x + 3)
  await expect(page.locator("#a11y-live-region")).toContainText("메모 위치")
  await page.waitForTimeout(1500)
  await expect(memo).toHaveAttribute('data-instance-marker', 'before-move')

  const beforeResize = await memo.boundingBox()
  await resizeHandle.focus()
  await resizeHandle.press("Shift+ArrowRight")
  await expect.poll(async () => (await memo.boundingBox()).width).toBeGreaterThan(beforeResize.width + 15)
  await expect(page.locator("#a11y-live-region")).toContainText("메모 크기")
})

test('자동 크기 모드에서 입력 내용에 맞춰 높이를 늘리고 줄인다', async ({ page }) => {
  await openViewerWithMemo(page, { content: '짧은 메모' })

  const memo = page.locator('.floating-memo[data-id="memo-regression"]')
  await expect(memo).toHaveClass(/auto-size/)
  await memo.locator('.edit-btn').click()
  const textarea = memo.locator('.floating-memo-textarea')
  const initialBox = await memo.boundingBox()
  const initialHeight = initialBox.height
  await memo.evaluate(el => { el.style.left = '150%' })
  await expect.poll(async () => (await memo.boundingBox()).width).toBe(initialBox.width)

  await textarea.fill(Array.from({ length: 12 }, (_, index) => `길이가 긴 자동 크기 메모 ${index + 1}`).join('\n'))
  await expect.poll(async () => (await memo.boundingBox()).height).toBeGreaterThan(initialHeight + 80)
  await expect.poll(async () => (await memo.boundingBox()).width).toBeLessThanOrEqual(422)

  const expandedHeight = (await memo.boundingBox()).height
  await textarea.fill('다시 짧게')
  await expect.poll(async () => (await memo.boundingBox()).height).toBeLessThan(expandedHeight - 80)
})

test('메모 Markdown 서식과 줄 단축키를 토글한다', async ({ page }) => {
  await openViewerWithMemo(page)
  const memo = page.locator('.floating-memo[data-id="memo-regression"]')
  await memo.locator('.edit-btn').click()
  const textarea = memo.locator('.floating-memo-textarea')

  await textarea.fill('서식')
  await textarea.selectText()
  await textarea.press('ControlOrMeta+Shift+x')
  await expect(textarea).toHaveValue('~~서식~~')
  await textarea.press('ControlOrMeta+Shift+x')
  await expect(textarea).toHaveValue('서식')

  await textarea.fill('첫째\n둘째')
  await textarea.selectText()
  await textarea.press('ControlOrMeta+Shift+8')
  await expect(textarea).toHaveValue('- 첫째\n- 둘째')
  await textarea.press('ControlOrMeta+Shift+8')
  await expect(textarea).toHaveValue('첫째\n둘째')

  await textarea.selectText()
  await textarea.press('ControlOrMeta+Shift+7')
  await expect(textarea).toHaveValue('1. 첫째\n2. 둘째')

  await textarea.fill('할 일')
  await textarea.selectText()
  await textarea.press('ControlOrMeta+Shift+l')
  await expect(textarea).toHaveValue('- [ ] 할 일')

  await textarea.fill('인용')
  await textarea.selectText()
  await textarea.press('ControlOrMeta+Shift+.')
  await expect(textarea).toHaveValue('> 인용')

  await textarea.fill('코드')
  await textarea.selectText()
  await textarea.press('ControlOrMeta+Shift+c')
  await expect(textarea).toHaveValue('```\n코드\n```')

  await textarea.fill('[')
  await textarea.press('[')
  await expect(textarea).toHaveValue('[[]]')
})

test('메모 목록 자동 편집과 완료 및 취소를 지원한다', async ({ page }) => {
  await openViewerWithMemo(page)
  const memo = page.locator('.floating-memo[data-id="memo-regression"]')
  await memo.locator('.edit-btn').click()
  const textarea = memo.locator('.floating-memo-textarea')

  await textarea.fill('- 첫 항목')
  await textarea.press('End')
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('- 첫 항목\n- ')
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('- 첫 항목\n')

  await textarea.fill('- [ ] 확인')
  await textarea.press('Home')
  await textarea.press('Tab')
  await expect(textarea).toHaveValue('  - [ ] 확인')
  await textarea.press('Shift+Tab')
  await expect(textarea).toHaveValue('- [ ] 확인')
  await textarea.press('ControlOrMeta+Enter')
  await expect(textarea).toHaveValue('- [x] 확인')
  await textarea.press('ControlOrMeta+Enter')
  await expect(textarea).toHaveValue('- [ ] 확인')

  await textarea.fill('OpenAI')
  await textarea.selectText()
  await textarea.evaluate(element => {
    const data = new DataTransfer()
    data.setData('text/plain', 'https://openai.com')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })
  await expect(textarea).toHaveValue('[OpenAI](https://openai.com)')
  await textarea.press('ControlOrMeta+Enter')
  await expect(memo.locator('.floating-memo-render a')).toHaveAttribute('href', 'https://openai.com')

  await memo.locator('.edit-btn').click()
  await textarea.fill('취소할 변경')
  await textarea.press('Escape')
  await expect(memo.locator('.floating-memo-render')).toContainText('OpenAI')
  await expect(memo.locator('.floating-memo-render')).not.toContainText('취소할 변경')
})

test('코드블록, 콜아웃, 중첩 목록과 표를 메모에서 렌더링한다', async ({ page }) => {
  await openViewerWithMemo(page, {
    content: [
      '> [!WARNING] 확인 필요',
      '> 중요한 내용입니다.',
      '',
      '```js',
      'const answer = 42',
      '```',
      '',
      '- 상위 항목',
      '  - 하위 항목',
      '1. 첫 단계',
      '   1. 하위 단계',
      '',
      '| 항목 | 값 |',
      '| --- | --- |',
      '| 정답 | 42 |',
    ].join('\n'),
  })

  const rendered = page.locator('.floating-memo-render')
  await expect(rendered.locator('pre code')).toContainText('const answer = 42')
  await expect(rendered.locator('blockquote .memo-callout-marker')).toContainText('확인 필요')
  await expect(rendered.locator('ul ul')).toContainText('하위 항목')
  await expect(rendered.locator('ol ol')).toContainText('하위 단계')
  await expect(rendered.locator('table')).toContainText('정답')
})
