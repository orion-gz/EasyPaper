import { test, expect } from '@playwright/test'
import { activeReader, evaluateReader, readerPoint, mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

test('내보내기 버튼 클릭 시 형식 선택 메뉴가 뜨고, PDF 선택 시 서버에 올바른 데이터를 보낸다', async ({ page }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [1] }
  await mockBaseRoutes(page, { documents: [docA] })
  await page.route('**/api/library/doc-A/pdf', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/library/doc-A/translation/1*', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ page: 1, translation: '테스트 번역입니다.', sentences: [] }) }))

  let exportRequestBody = null
  await page.route('**/api/library/doc-A/export-pdf', route => {
    exportRequestBody = route.request().postDataJSON()
    return route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'attachment; filename="export.pdf"' },
      body: Buffer.from('%PDF-1.4 fake pdf content'),
    })
  })

  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_annotations_doc-A', JSON.stringify({
      page_1: [{ type: 'highlight', text: 'sample text', startOffset: 0, endOffset: 11, color: '#eab308' }],
    }))
    localStorage.setItem('easypaper_memos_doc-A', JSON.stringify({
      page_1: [{ id: 'memo_1', pageNum: 1, sentenceIdx: 0, sentenceText: 'sample', content: '메모 내용', x: 10, y: 10 }],
    }))
  })
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1200)

  await activeReader(page).locator('#toolbar-kebab-btn').click()
  await activeReader(page).locator('#export-btn').click()
  await expect(activeReader(page).locator('#export-format-menu')).not.toHaveClass(/hidden/)
  await expect(activeReader(page).getByText('마크다운 (.md)')).toBeVisible()
  await expect(activeReader(page).getByText('PDF (번역·주석 포함)')).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await activeReader(page).locator('.export-format-item[data-format="pdf"]').click()
  const download = await downloadPromise

  expect(exportRequestBody).not.toBeNull()
  expect(exportRequestBody.annotations.page_1[0].text).toBe('sample text')
  expect(exportRequestBody.memos.page_1[0].content).toBe('메모 내용')
  expect(exportRequestBody.target_lang).toBeTruthy()

  expect(download.suggestedFilename()).toContain('번역_주석.pdf')
})

test('메뉴 바깥을 클릭하면 형식 선택 메뉴가 닫힌다', async ({ page }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [docA] })
  await page.route('**/api/library/doc-A/pdf', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1000)

  await activeReader(page).locator('#toolbar-kebab-btn').click()
  await activeReader(page).locator('#export-btn').click()
  await expect(activeReader(page).locator('#export-format-menu')).not.toHaveClass(/hidden/)

  await activeReader(page).locator('#viewer-screen').click({ position: { x: 10, y: 300 } })
  await expect(activeReader(page).locator('#export-format-menu')).toHaveClass(/hidden/)
})
