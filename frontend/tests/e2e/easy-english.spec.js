import { test, expect } from '@playwright/test'
import { activeReader, mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

const sentence = { source_sentence_id: 'S0', source_text: 'Sample PDF A - page 1', easy_sentences: ['Sample Paper A'], paragraph: 0, source_mapping: null }
const result = { page_num: 1, text: 'Sample Paper A', sentences: [sentence], cached: false, done: true }

async function setup(page, { language = 'en', mode = 'manual', web = false, sourceMapping = null } = {}) {
  const doc = { id: 'easy-doc', filename: 'Easy.pdf', total_pages: 1, metadata: { title: 'Easy English test' }, translated_pages: [], source_language: 'auto', detected_source_language: language,
    ...(web ? { content_kind: 'html_article', source_origin: 'web', source_url: 'https://example.test', document_mode: 'general', document_type: 'article' } : {}) }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/easy-doc/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  if (web) await page.route('**/api/library/easy-doc/article', route => route.fulfill({ json: {
    source_url: 'https://example.test', embed_allowed: false, toc: [], blocks: [{ id: 'b1', html: '<p data-block-id="b1">Sample Paper A</p>', text: 'Sample Paper A' }],
    units: [{ index: 1, id: 'section-1', title: 'Introduction', block_ids: ['b1'], text: 'Sample Paper A' }],
  } }))
  let stored = null, posts = 0, failure = false
  await page.route('**/api/easy-english/easy-doc/*', route => {
    if (route.request().method() === 'GET') return route.fulfill(stored ? { json: stored } : { status: 404, json: {} })
    posts++
    if (failure) return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"done":true,"error":{"code":"easy_english_invalid_mapping"}}\n\n' })
    stored = { ...result, sentences: [{ ...sentence, source_text: web ? 'Sample Paper A' : sentence.source_text, source_mapping: sourceMapping, easy_sentences: ['This is Sample Paper A.'] }] }
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(stored)}\n\n` })
  })
  await gotoApp(page)
  await page.evaluate(({ mode }) => {
    localStorage.setItem('easypaper_translation_mode', 'pane')
    localStorage.setItem('easypaper_translation_mode_general', 'pane')
    localStorage.setItem('easypaper_easy_english_mode_research', mode)
    localStorage.setItem('easypaper_easy_english_mode_general', mode)
    location.hash = '#viewer?id=easy-doc'
  }, { mode })
  const reader = activeReader(page)
  await expect(reader.locator('[data-tab="easy-english"]')).toBeVisible()
  return { reader, posts: () => posts, fail: () => { failure = true } }
}

test('manual tab opening does not generate; source and result match one to one; revisit is cached', async ({ page }) => {
  const { reader, posts } = await setup(page)
  await reader.locator('[data-tab="easy-english"]').click()
  const host = reader.locator('#easy-english-content-1')
  await expect(host.locator('button')).toBeEnabled()
  expect(posts()).toBe(0)
  await host.locator('button').click()
  await expect(host.locator('.easy-english-sentence')).toHaveCount(1)
  await expect(host.locator('.easy-english-sentence')).toContainText('This is Sample Paper A.')
  await host.locator('.easy-english-sentence').hover()
  await expect(reader.locator('.easy-source-highlight')).not.toHaveCount(0)
  await host.locator('.easy-english-sentence').focus()
  await host.locator('.easy-english-sentence').press('Enter')
  await expect(host.locator('.easy-sentence-highlight')).toHaveCount(1)
  await reader.locator('[data-tab="translation"]').click()
  await reader.locator('[data-tab="easy-english"]').click()
  await expect(host.locator('button')).toBeEnabled()
  expect(posts()).toBe(1)
})

test('automatic mode generates current page independently of manual translation', async ({ page }) => {
  const { reader, posts } = await setup(page, { mode: 'auto' })
  await expect.poll(posts).toBe(1)
  await reader.locator('[data-tab="easy-english"]').click()
  await expect(reader.locator('.easy-english-sentence')).toBeVisible()
  expect(posts()).toBe(1)
})

test('non-English source disables the tab without generation', async ({ page }) => {
  const { reader, posts } = await setup(page, { language: 'ko', mode: 'auto' })
  await expect(reader.locator('[data-tab="easy-english"]')).toBeDisabled()
  expect(posts()).toBe(0)
})

test('failed regeneration keeps previous sentence groups visible', async ({ page }) => {
  const { reader, fail, posts } = await setup(page)
  await reader.locator('[data-tab="easy-english"]').click()
  const host = reader.locator('#easy-english-content-1')
  await expect(host.locator('button')).toBeEnabled()
  await host.locator('button').click()
  await expect(host.locator('.easy-english-sentence')).toBeVisible()
  fail()
  await host.locator('button').click()
  await expect(host.locator('[role="alert"]')).toBeVisible()
  await expect(host.locator('.easy-english-sentence')).toContainText('This is Sample Paper A.')
  expect(posts()).toBe(2)
})

test('web source and simplified group highlight in both directions and survive translation polling', async ({ page }) => {
  const { reader } = await setup(page, { web: true })
  await reader.locator('[data-tab="easy-english"]').click()
  const host = reader.locator('#easy-english-content-1')
  await expect(host.locator('button')).toBeEnabled()
  await host.locator('button').click()
  const group = host.locator('.easy-english-sentence')
  await group.hover()
  await expect(reader.locator('.easy-source-highlight')).not.toHaveCount(0)
  await reader.locator('.article-original p').hover({ position: { x: 12, y: 12 } })
  await expect(group).toHaveClass(/easy-sentence-highlight/)
  await page.route('**/api/jobs/easy-doc/page/1**', route => route.fulfill({ json: { translation: 'Updated translation' } }))
  await expect(reader.locator('#trans-content-1')).toHaveText('Updated translation', { timeout: 6000 })
  await expect(group).toBeVisible()
})

test('panel tabs support keyboard selection and Easy English is separate from insight hiding', async ({ page }) => {
  const { reader } = await setup(page)
  await reader.locator('[data-tab="translation"]').focus()
  await reader.locator('[data-tab="translation"]').press('ArrowRight')
  await expect(reader.locator('[data-tab="easy-english"]')).toHaveAttribute('aria-selected', 'true')
  await expect(reader.locator('#easy-english-content-1')).toBeVisible()
})

test('settings enable automatic conversion in the reader without changing translation policy', async ({ page }) => {
  const { reader, posts } = await setup(page)
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('#settings-nav-translation').click()
  const picker = page.locator('.custom-select-picker').filter({ has: page.locator('#setting-easy-english-mode') })
  await picker.locator('.provider-picker-btn').click()
  await picker.getByRole('option', { name: '현재 페이지 자동 변환', exact: true }).click()
  await expect(page.locator('#setting-easy-english-mode')).toHaveValue('auto')
  await expect(page.locator('#setting-translation-mode')).toHaveValue('pane')
  await page.locator('#close-settings-btn').click()
  await expect.poll(posts).toBe(1)
  await reader.locator('[data-tab="easy-english"]').click()
  await expect(reader.locator('.easy-english-sentence')).toBeVisible()
})

test('inactive document does not start automatic conversion until activated', async ({ page }) => {
  const { posts } = await setup(page)
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await expect(page.locator('iframe[data-document-id="easy-doc"]')).toBeHidden()
  await page.evaluate(() => localStorage.setItem('easypaper_easy_english_mode_research', 'auto'))
  // Give the reader's storage event and debounce time to run while hidden.
  await page.waitForTimeout(600)
  expect(posts()).toBe(0)
  await page.locator('.workspace-tab[data-tab-id="document:easy-doc"] [role="tab"]').click()
  await expect.poll(posts).toBe(1)
})

test('refresh cannot replace the document while Easy English is generating', async ({ page }) => {
  const { reader } = await setup(page)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started = false
  await page.route('**/api/easy-english/easy-doc/1', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404, json: {} })
    started = true
    await gate
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(result)}\n\n` }).catch(() => {})
  })
  try {
    await reader.locator('[data-tab="easy-english"]').click()
    await expect(reader.locator('#easy-english-content-1 button')).toBeEnabled()
    await reader.locator('#easy-english-content-1 button').click()
    await expect.poll(() => started).toBe(true)
    let navigations = 0
    page.on('framenavigated', frame => { if (frame.parentFrame()) navigations++ })
    await reader.locator('#viewer-refresh-btn').click()
    await expect(reader.locator('#easy-english-content-1')).toHaveAttribute('aria-busy', 'true')
    expect(navigations).toBe(0)
  } finally { release() }
  await expect(reader.locator('.easy-english-sentence')).toBeVisible()
})

test('web translation keeps paragraph and list line breaks after polling', async ({ page }) => {
  const { reader } = await setup(page, { web: true })
  const text = 'First paragraph.\n\nSecond paragraph.\n- Item one\n- Item two'
  await page.route('**/api/jobs/easy-doc/page/1**', route => route.fulfill({ json: { translation: text } }))
  const content = reader.locator('#trans-content-1')
  await expect(content).toHaveText(text, { timeout: 6000 })
  expect(await content.innerText()).toBe(text)
  expect(await content.evaluate(node => getComputedStyle(node).whiteSpace)).toBe('pre-wrap')
})

test('web source highlights stay inside the original scroll pane', async ({ page }) => {
  const { reader } = await setup(page, { web: true })
  await reader.locator('[data-tab="easy-english"]').click()
  await reader.locator('#easy-english-content-1 button').click()
  const group = reader.locator('.easy-english-sentence')
  await expect(group).toBeVisible()
  const source = reader.locator('.article-original')
  await source.evaluate(node => {
    node.style.height = '80px'
    node.style.maxHeight = '80px'
    node.style.overflow = 'auto'
    const spacer = document.createElement('div')
    spacer.style.height = '500px'
    node.append(spacer)
    node.scrollTop = 150
  })
  await group.dispatchEvent('mouseover')
  await expect(reader.locator('.easy-source-highlight')).toHaveCount(0)
  await source.evaluate(node => { node.scrollTop = 0 })
  await group.dispatchEvent('mouseover')
  await expect(reader.locator('.easy-source-highlight')).not.toHaveCount(0)
  const pane = await source.boundingBox()
  for (const highlight of await reader.locator('.easy-source-highlight').all()) {
    const box = await highlight.boundingBox()
    expect(box.y).toBeGreaterThanOrEqual(pane.y)
    expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height)
  }
})

test('PDF fallback highlights only matching glyph spans and suppresses translation hover', async ({ page }) => {
  const { reader } = await setup(page)
  await reader.locator('[data-tab="easy-english"]').click()
  await reader.locator('#easy-english-content-1 button').click()
  const layer = reader.locator('.textLayer').first()
  await layer.evaluate(node => {
    node.replaceChildren()
    for (const [text, left] of [['Sample PDF ', 10], ['A - ', 150], ['page 1', 230], ['Unmatched source.', 10]]) {
      const span = document.createElement('span')
      span.textContent = text
      Object.assign(span.style, { position: 'absolute', left: `${left}px`, top: text === 'Unmatched source.' ? '90px' : '40px', fontSize: '16px', transform: 'none' })
      node.append(span)
    }
  })
  await reader.locator('.easy-english-sentence').hover()
  const boxes = reader.locator('.easy-source-highlight')
  await expect(boxes).toHaveCount(3)
  for (const box of await boxes.all()) expect((await box.boundingBox()).width).toBeLessThan(140)
  await layer.locator('span').last().hover()
  await expect(boxes).toHaveCount(0)
  await expect(reader.locator('.sentence-hover-box')).toHaveCount(0)
})


test('stale exact PDF mappings fall back to the current text layer', async ({ page }) => {
  const { reader } = await setup(page, { sourceMapping: {
    status: 'exact', source_revision: 'old-revision', layout_revision: 'old-revision',
    coordinate_space: 'unrotated-top-left', segments: [],
  } })
  await reader.locator('[data-tab="easy-english"]').click()
  await reader.locator('#easy-english-content-1 button').click()
  const group = reader.locator('.easy-english-sentence')
  await group.hover()
  await expect(reader.locator('.easy-source-highlight')).not.toHaveCount(0)
  await reader.locator('.textLayer span').first().hover()
  await expect(group).toHaveClass(/easy-sentence-highlight/)
})

test('PDF line breaks inside spans preserve hyphenated source matching', async ({ page }) => {
  const { reader } = await setup(page)
  await reader.locator('[data-tab="easy-english"]').click()
  await reader.locator('#easy-english-content-1 button').click()
  const layer = reader.locator('.textLayer').first()
  await layer.evaluate(node => {
    const span = document.createElement('span')
    span.append('Sam-', document.createElement('br'), 'ple PDF A - page 1')
    Object.assign(span.style, { position: 'absolute', left: '10px', top: '40px', fontSize: '16px', transform: 'none' })
    node.replaceChildren(span)
  })
  await reader.locator('.easy-english-sentence').hover()
  await expect(reader.locator('.easy-source-highlight')).not.toHaveCount(0)
})
