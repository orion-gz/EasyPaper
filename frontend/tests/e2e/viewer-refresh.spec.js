import { test, expect } from '@playwright/test'
import { openReaderTools, mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

const documents = ['refresh-a', 'refresh-b'].map(id => ({ id, filename: `${id}.pdf`, total_pages: 1, metadata: { primer_shown: true }, translated_pages: [1] }))
const reader = (page, id = 'refresh-a') => page.frameLocator(`iframe[data-document-id="${id}"]`)
async function setup(page) {
  await mockBaseRoutes(page, { documents })
  await page.route('**/api/library/*/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/library/*/translation/1**', route => route.fulfill({ json: { translation: `Translation ${new URL(route.request().url()).searchParams.get('style')}`, sentences: [] } }))
  await gotoApp(page)
  await page.evaluate(() => localStorage.setItem('easypaper_translation_mode_research', 'pane'))
}
async function open(page, id = 'refresh-a') {
  await page.evaluate(id => { location.hash = `#viewer?id=${id}` }, id)
  await expect(reader(page, id).locator('#viewer-refresh-btn')).toBeVisible({ timeout: 20000 })
  await openReaderTools(reader(page, id))
}
async function refresh(page, frame = reader(page)) {
  await frame.locator('body').evaluate(() => { window.__beforeRefresh = true })
  const navigated = page.waitForEvent('framenavigated', frame => Boolean(frame.parentFrame()))
  await frame.locator('#viewer-refresh-btn').click()
  await navigated
  await expect(frame.locator('#viewer-refresh-btn')).toBeVisible({ timeout: 20000 })
  expect(await frame.locator('body').evaluate(() => window.__beforeRefresh)).toBeUndefined()
}

test('refresh reloads viewer, translation and model settings while preserving drafts and other tabs', async ({ page }) => {
  await setup(page)
  await open(page, 'refresh-b')
  await reader(page, 'refresh-b').locator('#chat-input').fill('Other tab draft')
  await reader(page, 'refresh-b').locator('body').evaluate(() => { window.__otherTab = true })
  await open(page)
  const frame = reader(page)
  await expect(frame.locator('.trans-text')).toContainText('Translation academic')
  await frame.locator('body').evaluate(() => window.__easypaperDocument.restoreDraft({ text: 'Keep my question', quotedText: { text: 'Selected source', sourcePage: 1, charStart: 0, charEnd: 15 }, quotedImage: null, quotedImagePage: null }))
  await page.evaluate(() => {
    localStorage.setItem('easypaper_style_research', 'natural')
    localStorage.setItem('easypaper_focus_mode_enabled_research', 'true')
    localStorage.setItem('easypaper_default_zoom', '2')
    window.__hostPreserved = true
  })
  let settingsRequests = 0
  await page.route('**/api/settings/system', route => {
    settingsRequests++
    return route.fulfill({ json: { available_models: ['fresh-model'], trans_provider: 'ollama', trans_model: 'fresh-model', chat_provider: 'ollama', chat_model: 'fresh-model' } })
  })
  const hash = await page.evaluate(() => location.hash)
  await refresh(page)
  expect(settingsRequests).toBeGreaterThan(0)
  await expect(frame.locator('#viewer-scroll-container')).toHaveClass(/focus-mode-enabled/)
  expect(await frame.locator('body').evaluate(() => window.__easypaperDocument.snapshot().zoom)).toBe(2)
  await expect(frame.locator('#document-fit-width')).toHaveAttribute('aria-pressed', 'false')
  await expect(frame.locator('.trans-text')).toContainText('Translation natural')
  await expect(frame.locator('#chat-sidebar-provider')).toContainText('fresh-model')
  await expect(frame.locator('#chat-input')).toHaveValue('Keep my question')
  await expect(frame.locator('#chat-quote-text')).toHaveText('Selected source')
  await expect(frame.locator('#outline-sidebar')).toBeHidden()
  expect(await page.evaluate(() => window.__hostPreserved)).toBe(true)
  expect(await page.evaluate(() => location.hash)).toBe(hash)
  expect(await reader(page, 'refresh-b').locator('body').evaluate(() => window.__otherTab)).toBe(true)
  await expect(reader(page, 'refresh-b').locator('#chat-input')).toHaveValue('Other tab draft')
  const persisted = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('easypaper_workspace_v1:')).map(key => localStorage.getItem(key)).join(''))
  expect(persisted).not.toContain('Keep my question')
  expect(persisted).not.toContain('Selected source')
})

test('refresh preserves the reader position and image quote', async ({ page }) => {
  await setup(page)
  await open(page)
  const frame = reader(page)
  await frame.locator('body').evaluate(async () => {
    const runtime = window.__easypaperDocument
    await runtime.restore({ ...runtime.snapshot(), fitWidth: false, zoom: 2.5, offset: 0.25 })
    runtime.restoreDraft({ text: 'Image question', quotedText: null, quotedImage: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', quotedImagePage: 1 })
  })
  const before = await frame.locator('body').evaluate(() => window.__easypaperDocument.snapshot())
  await refresh(page)
  const after = await frame.locator('body').evaluate(() => window.__easypaperDocument.snapshot())
  expect(after.page).toBe(before.page)
  expect(after.offset).toBeCloseTo(before.offset, 1)
  expect(after.zoom).toBe(before.zoom)
  await expect(frame.locator('#chat-input')).toHaveValue('Image question')
  await expect(frame.locator('#chat-quote-img')).toBeVisible()
})

test('refresh leaves an active chat request running and works after completion', async ({ page }) => {
  await setup(page)
  let release
  let started = false
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/chat/stream', async route => {
    started = true
    await pending
    await route.fulfill({ contentType: 'text/event-stream', body: 'event: answer\ndata: {"delta":"Completed answer"}\n\nevent: done\ndata: {}\n\n' })
  })
  await open(page)
  const frame = reader(page)
  await frame.locator('body').evaluate(() => { window.__beforeRefresh = true })
  await frame.locator('#chat-input').fill('Keep running')
  await frame.locator('#chat-input').press('Enter')
  await expect.poll(() => started).toBe(true)
  await frame.locator('#viewer-refresh-btn').click()
  await expect(frame.locator('body')).toContainText('번역 또는 답변 생성이 끝난 후 새로고침해 주세요.')
  expect(await frame.locator('body').evaluate(() => window.__beforeRefresh)).toBe(true)
  release()
  await expect(frame.locator('#chat-messages')).toContainText('Completed answer')
  await expect.poll(() => frame.locator('body').evaluate(() => window.__easypaperDocument.busy())).toBe(false)
  await refresh(page)
})

test('a failed document reload can retry without losing the question draft', async ({ page }) => {
  await setup(page)
  await open(page)
  const frame = reader(page)
  await frame.locator('#chat-input').fill('Recover this draft')
  let fail = true
  await page.route('**/api/library/refresh-a', route => route.fulfill({ status: fail ? 503 : 200, json: fail ? { detail: 'Unavailable' } : documents[0] }))
  await frame.locator('#viewer-refresh-btn').click()
  await expect(frame.locator('.workspace-load-error')).toBeVisible({ timeout: 20000 })
  fail = false
  await frame.locator('.workspace-load-error button').click()
  await expect(frame.locator('#viewer-refresh-btn')).toBeVisible({ timeout: 20000 })
  await expect(frame.locator('#chat-input')).toHaveValue('Recover this draft')
})

test('refresh leaves an active manual translation running', async ({ page }) => {
  await setup(page)
  await page.route('**/api/library/refresh-a', route => route.fulfill({ json: { ...documents[0], translated_pages: [] } }))
  let release
  let started = false
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/translate/refresh-a/1**', async route => {
    started = true
    await pending
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"Preserved translation"}\n\ndata: {"done":true,"sentences":[]}\n\n' })
  })
  await open(page)
  const frame = reader(page)
  await frame.locator('body').evaluate(() => { window.__beforeRefresh = true })
  await frame.locator('.translate-page-btn').click()
  await expect.poll(() => started).toBe(true)
  await frame.locator('#viewer-refresh-btn').click()
  await expect(frame.locator('body')).toContainText('번역 또는 답변 생성이 끝난 후 새로고침해 주세요.')
  expect(await frame.locator('body').evaluate(() => window.__beforeRefresh)).toBe(true)
  release()
  await expect(frame.locator('.trans-text')).toContainText('Preserved translation')
})
