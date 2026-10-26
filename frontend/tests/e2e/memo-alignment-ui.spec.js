import { test, expect } from '@playwright/test'
import { activeReader, mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

async function openViewerWithMemo(page, memoOverrides = {}, extraMemos = [], uiLocale = 'ko') {
  const doc = {
    id: 'doc-memo',
    filename: 'Memo.pdf',
    total_pages: 1,
    metadata: { title: 'Memo document' },
    translated_pages: [1],
  }

  await mockBaseRoutes(page, { documents: [doc], languageSettings: { ui_locale: uiLocale, default_source_language: 'auto', target_language: 'ko' } })
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
  await page.evaluate(({ overrides, extraMemos }) => {
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
      }, ...extraMemos],
    }))
    location.hash = '#viewer?id=doc-memo'
  }, { overrides: memoOverrides, extraMemos })

  // Wait for the asynchronous parallel fit before measuring or editing cards.
  await expect.poll(() => activeReader(page).locator('#viewer-scroll-container').evaluate(el => {
    const paper = el.querySelector('.pdf-page-wrapper')
    return Boolean(paper?.querySelector('.textLayer') && paper.offsetWidth * 2 < el.clientWidth)
  }), { timeout: 15000 }).toBe(true)
  await expect(activeReader(page).locator('.floating-memo[data-id="memo-regression"]')).toBeVisible({ timeout: 15000 })
  await expect(activeReader(page).locator('#trans-content-1 .trans-text')).toContainText('Cached translation')
}


for (const locale of ['ko', 'en']) {
  test(`메모 정렬 도구와 설정이 최소 너비 및 밝은 테마에서도 명확하게 표시된다 (${locale})`, async ({ page }) => {
    await openViewerWithMemo(page, { autoSize: false, width: 220, height: 240 }, [], locale)
    const reader = activeReader(page)
    const memo = reader.locator('.floating-memo[data-id="memo-regression"]')
    const alignment = memo.locator('.floating-memo-alignment')
    await expect(alignment).toHaveAttribute('aria-label', locale === 'ko' ? '메모 정렬' : 'Memo alignment')
    await expect(alignment.locator('[data-memo-align="left"] span')).toHaveText(locale === 'ko' ? '왼쪽' : 'Left')
    const right = alignment.locator('[data-memo-align="right"]')
    await right.click()
    await expect(right).toHaveAttribute('aria-pressed', 'true')
    await expect(alignment.locator('[data-memo-align="left"]')).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Tab')
    await right.focus()
    await expect(right).toHaveCSS('outline-style', 'solid')

    const controlsFit = () => memo.locator('.floating-memo-header').evaluate(header => {
      const bounds = header.getBoundingClientRect()
      const controls = [...header.querySelectorAll('button')].map(button => button.getBoundingClientRect())
      const inside = controls.every(rect => rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom)
      const overlaps = controls.some((a, i) => controls.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1))
      return inside && !overlaps
    })
    await expect.poll(controlsFit).toBe(true)
    await memo.locator('.collapse-btn').click()
    await expect(memo).toHaveClass(/collapsed/)
    await expect(right).toBeVisible()
    await expect.poll(controlsFit).toBe(true)

    await page.locator('#sidebar-theme-toggle-btn').click()
    await expect(reader.locator('body')).toHaveClass(/light-theme/)
    await expect(right).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(controlsFit).toBe(true)

    await page.locator('#sidebar-settings-btn').click()
    await page.locator('#settings-nav-viewer').click()
    await expect(page.locator('.memo-layout-preferences legend')).toHaveText(locale === 'ko' ? '메모 배치' : 'Memo placement')
    for (const name of ['memoRightPosition', 'memoOverflow']) {
      const select = page.locator(`#setting-reader-${name}`)
      const button = select.locator('..').locator('.provider-picker-btn')
      await expect(button).toHaveAttribute('aria-describedby', `setting-reader-${name}-help`)
      await expect(page.locator(`#setting-reader-${name}-help`)).toBeVisible()
    }
    await page.setViewportSize({ width: 500, height: 800 })
    await expect.poll(() => page.locator('.memo-layout-setting').evaluateAll(rows => rows.every(row => {
      const copy = row.querySelector('.memo-layout-setting-copy').getBoundingClientRect()
      const picker = row.querySelector('.custom-select-picker').getBoundingClientRect()
      return picker.top >= copy.bottom && picker.right <= row.getBoundingClientRect().right + 1
    }))).toBe(true)
  })
}

for (const locale of ['ko', 'en']) {
  test(`memo footer formats selections and counts words (${locale})`, async ({ page }) => {
    await openViewerWithMemo(page, { content: 'hello world', autoSize: false, width: 220, height: 240 }, [], locale)
    const memo = activeReader(page).locator('.floating-memo[data-id="memo-regression"]')
    const count = memo.locator('.floating-memo-word-count')
    await expect(count).toHaveText(locale === 'ko' ? '2단어' : '2 words')
    await memo.locator('.floating-memo-body').click()
    const editor = memo.locator('textarea')
    await editor.evaluate(el => el.setSelectionRange(0, 5))
    await memo.locator('[data-memo-format="bold"]').click()
    await expect(editor).toHaveValue('**hello** world')
    await expect(count).toHaveText(locale === 'ko' ? '2단어' : '2 words')
    await memo.locator('[data-memo-format="bold"]').click()
    await expect(editor).toHaveValue('hello world')
    await editor.fill('안녕 세상 hello')
    await expect(count).toHaveText(locale === 'ko' ? '3단어' : '3 words')
    await memo.locator('[data-memo-format="italic"]').focus()
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await expect(editor).toBeVisible()
    await editor.fill('')
    await expect(count).toHaveText(locale === 'ko' ? '0단어' : '0 words')
    await editor.fill('saved content')
    await editor.press('Control+Enter')
    await expect(memo.locator('.floating-memo-render')).toHaveText('saved content')
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('easypaper_memos_doc-memo')).page_1[0].content)).toBe('saved content')
    await expect(memo.locator('.floating-memo-footer')).toBeVisible()
    await memo.locator('.collapse-btn').click()
    await expect(memo.locator('.floating-memo-footer')).toBeHidden()
  })
}

for (const position of ['outside', 'between']) {
  test(`memo alignment preserves fitted paper size (${position})`, async ({ page }) => {
    await openViewerWithMemo(page, { autoSize: false, width: 320, height: 240 })
    const reader = activeReader(page)
    const paperWidth = () => reader.locator('.pdf-page-wrapper').first().evaluate(el => el.offsetWidth)
    await reader.locator('#document-fit-width').click()
    await page.waitForTimeout(400)
    const originalWidth = await paperWidth()
    await reader.locator('body').evaluate((_, position) => {
      localStorage.setItem('easypaper_reader_memoRightPosition', position)
      window.dispatchEvent(new Event('easypaper:reader-preferences'))
    }, position)
    const memo = reader.locator('.floating-memo[data-id="memo-regression"]')
    for (const side of ['left', 'right']) {
      await memo.locator(`[data-memo-align="${side}"]`).click()
      await expect(reader.locator('.page-pair').first()).toHaveClass(/has-aligned-memos/)
      await reader.locator('#document-fit-width').click()
      await page.waitForTimeout(400)
      expect(await paperWidth()).toBeCloseTo(originalWidth, 0)
    }
  })
}
