import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A, openReaderTools, activeReader } from './helpers.js'
const doc = { id: 'review', filename: 'Review.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] }
const reader = page => page.frameLocator('iframe[data-document-id="review"]')
async function setup(page, extra = {}) {
  await mockBaseRoutes(page, { documents: [{ ...doc, ...extra }] })
  await page.route('**/api/library/review/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/tasks', route => route.fulfill({ json: { tasks: [] } }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=review' })
  await expect(reader(page).locator('#document-find')).toBeVisible({ timeout: 20000 })
}
async function select(page) {
  const el = reader(page).locator('.textLayer span').first()
  await expect(el).toBeVisible({ timeout: 20000 })
  await el.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el)
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await expect(reader(page).locator('#selection-menu')).toBeVisible()
}
async function mockChat(page, onRequest = () => {}) {
  await page.route('**/api/chat/stream', async route => {
    onRequest(route.request().postDataJSON())
    await route.fulfill({ contentType: 'text/event-stream', body: 'event: answer\ndata: {"delta":"Review answer"}\n\nevent: done\ndata: {}\n\n' })
  })
}

test('REVIEW-1 collapsed translation remains readable in focus translation view', async ({ page }) => {
  await setup(page)
  await reader(page).locator('.trans-collapse-btn').first().click()
  await expect(reader(page).locator('body')).toHaveClass(/collapse-translation/)
  await reader(page).locator('#reader-focus').click()
  await reader(page).locator('#reader-focus-view [data-view="translation"]').click()
  await expect(reader(page).locator('.trans-page-content').first()).toBeVisible({ timeout: 1500 })
  await reader(page).locator('#reader-focus').click()
  await expect(reader(page).locator('body')).toHaveClass(/collapse-translation/)
})

test('REVIEW-2 explaining a selection from notes switches to the chat panel', async ({ page }) => {
  await setup(page); await mockChat(page)
  await openReaderTools(reader(page))
  await reader(page).locator('#document-tool-notes').click()
  await select(page)
  await reader(page).locator('#selection-menu').getByRole('button', { name: '쉽게 설명', exact: true }).click()
  await expect(reader(page).locator('#chat-messages')).toContainText('Review answer')
  await expect(reader(page).locator('#document-tool-chat')).toHaveAttribute('aria-selected', 'true', { timeout: 1500 })
})

test('REVIEW-3 quick translation honors document-specific target language', async ({ page }) => {
  let request
  await setup(page, { preferred_target_language: 'en' }); await mockChat(page, body => { request = body })
  await select(page)
  await reader(page).locator('#selection-menu').getByRole('button', { name: '번역', exact: true }).click()
  await expect.poll(() => request?.messages?.length).toBeGreaterThan(0)
  expect(request.messages.at(-1).content).toContain('문장을 en로')
})

test('REVIEW-4 reopening search must not execute a stale result while loading', async ({ page }) => {
  await setup(page)
  let holdEmpty = false
  await page.route('**/api/library/command-search?*', async route => {
    const q = new URL(route.request().url()).searchParams.get('q')
    if (holdEmpty && !q) await new Promise(resolve => setTimeout(resolve, 2500))
    await route.fulfill({ json: { results: q ? [{ kind: 'memo', doc_id: doc.id, title: 'Old result', text: 'old matching memo', page: 1, memo_id: 'old-memo' }] : [] } })
  })
  await page.locator('#reader-command-search').click()
  const input = page.locator('#reader-command-dialog input')
  await input.fill('old')
  await expect(page.locator('#reader-command-results')).toContainText('Old result')
  await input.press('Control+k')
  await expect(page.locator('#reader-command-dialog')).not.toBeVisible()
  holdEmpty = true
  await page.locator('#reader-command-search').click()
  await input.press('Enter')
  await expect(page.locator('#reader-command-dialog')).toBeVisible({ timeout: 1500 })
})

test('REVIEW-5 new focus controls update when UI language changes', async ({ page }) => {
  await setup(page)
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('#settings-nav-general').click()
  await page.locator('#setting-ui-locale').evaluate(el => { el.value = 'en'; el.dispatchEvent(new Event('change', { bubbles: true })) })
  await expect(page.locator('#reader-command-search')).toHaveAttribute('aria-label', 'Search and commands')
  await expect(reader(page).locator('#reader-focus')).toHaveAttribute('aria-label', 'Focus reading', { timeout: 1500 })
})

test('REVIEW-6 HTML quick actions obey the same setting and expose AI actions', async ({ page }) => {
  const article = { id: 'article-review', filename: 'Article.html', total_pages: 1, total_units: 1, content_kind: 'html_article', source_origin: 'web', source_url: 'https://example.test/article', metadata: { primer_shown: true }, translated_pages: [], document_mode: 'general', document_type: 'article' }
  const manifest = { schema_version: 1, title: 'Article', source_url: article.source_url, embed_allowed: false, toc: [], blocks: [{ id: 'b1', type: 'p', text: 'Article source text', html: '<p data-block-id="b1">Article source text</p>' }], units: [{ index: 1, id: 'section-1', title: 'Introduction', block_ids: ['b1'], text: 'Article source text' }] }
  await mockBaseRoutes(page, { documents: [article], workspaceSettings: { preferred_workspace_mode: 'general' } })
  await page.route('**/api/library/article-review/article', route => route.fulfill({ json: manifest }))
  await gotoApp(page)
  await page.evaluate(() => { localStorage.setItem('easypaper_reader_quickActions', 'false'); location.hash = '#viewer?id=article-review' })
  const paragraph = activeReader(page).locator('[data-block-id="b1"]')
  await expect(paragraph).toBeVisible()
  await paragraph.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el)
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }))
  })
  await expect(activeReader(page).locator('.article-selection-tools')).toBeHidden({ timeout: 1500 })
  let request
  await mockChat(page, body => { request = body })
  await page.evaluate(() => localStorage.setItem('easypaper_reader_quickActions', 'true'))
  await paragraph.evaluate(el => el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 })))
  await activeReader(page).locator('.article-selection-tools [data-action="explain"]').click()
  await expect.poll(() => request?.messages?.at(-1)?.content).toContain('Article source text')
  await expect(activeReader(page).locator('#document-tool-chat')).toHaveAttribute('aria-selected', 'true')
  await expect(activeReader(page).locator('#chat-messages')).toContainText('Review answer')
})


test('REVIEW-7 Escape closes a nonempty command search', async ({ page }) => {
  await setup(page)
  await page.route('**/api/library/command-search?*', route => route.fulfill({ json: { results: [] } }))
  await page.locator('#reader-command-search').click()
  const input = page.locator('#reader-command-dialog input')
  await input.fill('nonempty query')
  await input.press('Escape')
  await expect(page.locator('#reader-command-dialog')).not.toBeVisible({ timeout: 1500 })
})

test('REVIEW-8 translation-only focus keeps tracking the visible page', async ({ page }) => {
  const { readFileSync } = await import('node:fs')
  await mockBaseRoutes(page, { documents: [{ ...doc, total_pages: 3 }] })
  await page.route('**/api/library/review/pdf', route => route.fulfill({ contentType: 'application/pdf', body: readFileSync(new URL('./fixtures/three-pages.pdf', import.meta.url)) }))
  await page.route('**/api/tasks', route => route.fulfill({ json: { tasks: [] } }))
  await gotoApp(page); await page.evaluate(() => { location.hash = '#viewer?id=review' })
  await expect(reader(page).locator('#document-find')).toBeVisible({ timeout: 20000 })
  const scrollTo = async n => reader(page).locator(`.page-pair[data-page="${n}"]`).evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await scrollTo(3)
  await expect(reader(page).locator('#page-input')).toHaveValue('3')
  await scrollTo(1)
  await expect(reader(page).locator('#page-input')).toHaveValue('1')
  await reader(page).locator('#reader-focus').click()
  await reader(page).locator('#reader-focus-view [data-view="translation"]').click()
  await scrollTo(3)
  await expect.poll(() => reader(page).locator('body').evaluate(() => window.__easypaperDocument.snapshot().page)).toBe(3)
  await expect(reader(page).locator('#page-input')).toHaveValue('3', { timeout: 2000 })
})
