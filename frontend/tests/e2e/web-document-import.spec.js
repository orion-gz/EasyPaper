import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

const doc = { id: 'web-1', filename: 'Article.html', total_pages: 2, total_units: 2, content_kind: 'html_article', source_origin: 'web', source_url: 'https://example.test/article', metadata: { title: 'Saved article' }, translated_pages: [1], document_mode: 'general', document_type: 'article' }
const manifest = { schema_version: 1, title: 'Saved article', source_url: 'https://example.test/article', embed_allowed: false, toc: [{ unit_id: 'section-1', index: 1, title: 'Introduction' }, { unit_id: 'section-2', index: 2, title: 'Details' }], blocks: [{ id: 'block-1', type: 'p', text: 'Unique searchable source text', html: '<p data-block-id="block-1">Unique searchable source text</p>' }, { id: 'block-2', type: 'p', text: 'Second section body', html: '<p data-block-id="block-2">Second section body</p>' }], units: [{ index: 1, id: 'section-1', title: 'Introduction', block_ids: ['block-1'], text: 'Unique searchable source text' }, { index: 2, id: 'section-2', title: 'Details', block_ids: ['block-2'], text: 'Second section body' }] }

async function openArticle(page) {
  await mockBaseRoutes(page, { documents: [doc], workspaceSettings: { preferred_workspace_mode: 'general' } })
  await page.route('**/api/library/web-1/article', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }))
  await page.route('**/api/jobs/web-1/page/1**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ translation: 'Translated introduction' }) }))
  await page.route('**/api/jobs/web-1/page/2**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ translation: 'Translated details' }) }))
  await gotoApp(page)
  await page.evaluate(() => { localStorage.setItem('easypaper_hydrated_web-1', '1'); location.hash = '#viewer?id=web-1' })
  await expect(page.locator('.article-viewer')).toBeVisible()
}

test('문서 추가 소스 모달은 키보드 포커스를 가두고 Escape로 닫힌다', async ({ page }) => {
  await mockBaseRoutes(page); await gotoApp(page); await page.locator('#lib-upload-btn').click(); await page.locator('#lib-add-paper-btn').click()
  await expect(page.locator('#document-source-modal')).toBeVisible(); await expect(page.locator('#document-source-modal')).toHaveClass(/is-visible/); await expect(page.locator('#document-source-local')).toBeFocused()
  await page.locator('#document-source-close').focus(); await page.keyboard.press('Tab'); await expect(page.locator('#document-source-local')).toBeFocused()
  await page.keyboard.press('Escape'); await expect(page.locator('#document-source-modal')).toBeHidden()
})

test('저장된 HTML 원문과 번역, 목차, 검색, 원본 폴백을 표시한다', async ({ page }) => {
  await openArticle(page)
  await expect(page.locator('.article-original').first()).toContainText('Unique searchable source text')
  await expect(page.locator('.article-translation').first()).toContainText('Translated introduction')
  await page.locator('.article-search input').fill('searchable'); await expect(page.locator('[data-block-id="block-1"]')).toHaveClass(/article-search-hit/)
  await page.locator('#outline-toggle-btn').click(); await expect(page.locator('#outline-content')).toContainText('Introduction')
  await page.locator('#outline-toggle-btn').click()
  await page.locator('[data-tab="original"]').click(); await expect(page.locator('.article-original-site')).toContainText('브라우저에서 원본을 열어주세요')
})

test('HTML 선택 하이라이트를 section anchor로 저장하고 다시 열 때 복원한다', async ({ page }) => {
  await openArticle(page)
  const paragraph = page.locator('[data-block-id="block-1"]')
  await paragraph.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 })) })
  await page.locator('.article-selection-tools [data-action="highlight"]').click()
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('easypaper_annotations_web-1')))
  expect(stored.section_1[0].anchor).toMatchObject({ unit_id: 'section-1', block_id: 'block-1', exact: 'Unique searchable source text' })
  await page.reload(); await page.evaluate(() => { location.hash = '#viewer?id=web-1' }); await expect(page.locator('.article-highlight')).toContainText('Unique searchable source text')
})

test('봇 확인으로 차단된 URL 오류를 가져오기 모달에 표시한다', async ({ page }) => {
  await mockBaseRoutes(page)
  await page.route('**/api/import-url', route => route.fulfill({
    status: 422, contentType: 'application/json',
    body: JSON.stringify({ detail: { code: 'challenge_page' } }),
  }))
  await gotoApp(page)
  await page.locator('#lib-upload-btn').click()
  await page.locator('#lib-add-paper-btn').click()
  await page.locator('#document-source-web').click()
  await page.locator('#url-import-input').fill('https://computer.howstuffworks.com/computer-memory.htm#pt1')
  await page.locator('#url-import-form').press('Enter')
  await expect(page.locator('#document-type-modal')).toBeVisible()
  await expect(page.locator('#document-type-ai-btn')).toBeVisible()
  await page.locator('#document-type-options button').first().click()
  await page.locator('#document-type-confirm-btn').click()
  const error = page.locator('#url-import-error')
  await expect(page.locator('#url-import-modal')).toBeVisible()
  await expect(error).toContainText('브라우저 확인을 요구합니다')
  await expect(page.locator('#url-import-input')).toHaveAttribute('aria-invalid', 'true')
  await expect(error).toBeFocused()
})
