import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

function multiPagePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>']
  for (let page = 1; page <= 3; page++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${page * 2 + 2} 0 R >>`)
    const stream = `BT /F1 18 Tf 50 700 Td (Page ${page}: Research evidence and conclusions.) Tj ET`
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return Buffer.from(pdf)
}
const reader = page => page.frameLocator('iframe[data-document-id="commands"]')
const input = page => page.locator('#reader-command-dialog input')
const options = page => page.locator('#reader-command-results [role="option"]')
async function setup(page, { minimal = false } = {}) {
  const doc = { id: 'commands', filename: 'Commands.pdf', total_pages: 3, translated_pages: [], metadata: { title: 'Command Study', primer_shown: true, authors: ['Alice'], year: 2025, bibliography: { doi: '10.1/test' }, last_read_at: '2026-01-02T00:00:00Z', last_page: 1 } }
  const older = { id: 'older', filename: 'Older.pdf', total_pages: 1, metadata: { last_read_at: '2026-01-01T00:00:00Z' } }
  const unread = { id: 'unread', filename: 'Unread.pdf', total_pages: 1, metadata: {} }
  await mockBaseRoutes(page, { documents: [doc, older, unread] })
  if (minimal) await page.addInitScript(() => localStorage.setItem('easypaper_minimal_ui', 'true'))
  await page.route('**/api/library/commands/pdf', route => route.fulfill({ contentType: 'application/pdf', body: multiPagePdf() }))
  await page.route('**/api/library/older/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/tasks', route => route.fulfill({ json: { tasks: [] } }))
  await page.route('**/api/library/command-search?*', route => route.fulfill({ json: { results: [{ kind: 'document', doc_id: doc.id, title: doc.filename, text: 'Study' }] } }))
  await page.route('**/api/library/commands/metadata', route => {
    Object.assign(doc.metadata, route.request().postDataJSON())
    return route.fulfill({ json: { status: 'success', metadata: doc.metadata } })
  })
  await gotoApp(page, { navigateToLibrary: !minimal })
  await expect(page.locator('#reader-command-search')).toBeVisible()
  return doc
}
async function openReader(page) {
  await page.evaluate(() => { location.hash = '#viewer?id=commands' })
  await expect(reader(page).locator('#document-find')).toBeVisible({ timeout: 20000 })
  await expect(reader(page).locator('.textLayer span').first()).toBeVisible()
}
async function query(page, value) {
  if (!await page.locator('#reader-command-dialog').isVisible()) await page.keyboard.press('Control+k')
  await expect(input(page)).toBeFocused()
  await input(page).fill(value)
  await expect(options(page)).toHaveCount(1)
}
async function run(page, value) {
  await query(page, value)
  await expect(options(page)).toHaveAttribute('aria-disabled', 'false')
  await input(page).press('Enter')
}
async function snapshot(page) { return reader(page).locator('body').evaluate(() => window.__easypaperDocument.snapshot()) }

test('all commands are discoverable; help, document search and recent results work', async ({ page }) => {
  await setup(page)
  await run(page, '/help')
  await expect(input(page)).toHaveValue('/')
  await expect(options(page)).toHaveCount(44)
  for (const id of ['upload', 'import-url', 'page', 'bookmark', 'summarize', 'copy-citation', 'reopen-tab']) await expect(page.locator('#reader-command-results')).toContainText(`/${id}`)
  await run(page, '/open')
  await expect(options(page)).toHaveCount(3)
  await input(page).fill('/open Command')
  await expect(options(page)).toHaveCount(1)
  await input(page).press('Enter')
  await expect(reader(page).locator('#document-find')).toBeVisible({ timeout: 20000 })
  await run(page, '/recent')
  await expect(options(page)).toHaveCount(2)
  await expect(options(page).first()).toContainText('Command Study')
  await expect(options(page).nth(1)).toContainText('Older.pdf')
})

test('global upload, import, task center, sidebar and explicit theme commands perform their actions', async ({ page }) => {
  await setup(page)
  await query(page, '/upload')
  const chooser = page.waitForEvent('filechooser')
  await input(page).press('Enter')
  expect((await chooser).isMultiple()).toBe(true)
  await run(page, '/import-url')
  await expect(page.locator('#url-import-input')).toBeFocused()
  await page.locator('#url-import-cancel').click()
  const collapsed = await page.locator('#app-sidebar').evaluate(el => el.classList.contains('collapsed'))
  await run(page, '/sidebar')
  await expect.poll(() => page.locator('#app-sidebar').evaluate(el => el.classList.contains('collapsed'))).toBe(!collapsed)
  await run(page, '/theme light')
  await expect(page.locator('body')).toHaveClass(/light-theme/)
  await run(page, '/theme light')
  await expect(page.locator('body')).toHaveClass(/light-theme/)
  await run(page, '/theme dark')
  await expect(page.locator('body')).not.toHaveClass(/light-theme/)
  await query(page, '/theme invalid')
  await expect(options(page)).toHaveAttribute('aria-disabled', 'true')
  await input(page).press('Escape')
  await run(page, '/tasks')
  await expect(page.locator('#reader-task-list')).toBeVisible()
})

test('page commands navigate correctly and reject boundary and malformed arguments', async ({ page }) => {
  await setup(page); await openReader(page)
  await run(page, '/page 2')
  await expect.poll(async () => (await snapshot(page)).page).toBe(2)
  await run(page, '/next-page')
  await expect.poll(async () => (await snapshot(page)).page).toBe(3)
  await query(page, '/next-page')
  await expect(options(page)).toHaveAttribute('aria-disabled', 'true')
  await input(page).press('Escape')
  await run(page, '/previous-page')
  await expect.poll(async () => (await snapshot(page)).page).toBe(2)
  for (const value of ['/page', '/page 0', '/page 4', '/page 1.5', '/page 2abc', '/page 1e2']) {
    await query(page, value)
    await expect(options(page)).toHaveAttribute('aria-disabled', 'true')
    await input(page).press('Enter')
    await expect(page.locator('#reader-command-dialog')).toBeVisible()
  }
  await input(page).press('Escape')
  await run(page, '/page 1')
  await expect.poll(async () => (await snapshot(page)).page).toBe(1)
  await query(page, '/previous-page')
  await expect(options(page)).toHaveAttribute('aria-disabled', 'true')
})

test('zoom, fit width, outline and fullscreen update the active reader', async ({ page }) => {
  await setup(page); await openReader(page)
  await run(page, '/zoom 150')
  await expect.poll(async () => (await snapshot(page)).zoom).toBe(1.5)
  expect((await snapshot(page)).fitWidth).toBe(false)
  await run(page, '/zoom-in')
  await expect.poll(async () => (await snapshot(page)).zoom).toBeCloseTo(1.7)
  await run(page, '/zoom-out')
  await expect.poll(async () => (await snapshot(page)).zoom).toBeCloseTo(1.5)
  await run(page, '/zoom 300%')
  await expect.poll(async () => (await snapshot(page)).zoom).toBe(3)
  await query(page, '/zoom-in')
  await expect(options(page)).toHaveAttribute('aria-disabled', 'true')
  for (const value of ['/zoom 49', '/zoom 301', '/zoom NaN']) {
    await query(page, value); await expect(options(page)).toHaveAttribute('aria-disabled', 'true')
  }
  await input(page).press('Escape')
  await run(page, '/fit-width')
  await expect.poll(async () => (await snapshot(page)).fitWidth).toBe(true)
  await run(page, '/outline')
  await expect(reader(page).locator('#outline-sidebar')).toBeVisible()
  await run(page, '/fullscreen')
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
  await run(page, '/fullscreen')
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false)
})

test('bookmark toggles persist without replacing unrelated metadata and memo content survives reopening', async ({ page }) => {
  const doc = await setup(page); await openReader(page)
  await run(page, '/page 2')
  await expect.poll(async () => (await snapshot(page)).page).toBe(2)
  await run(page, '/bookmark')
  await expect.poll(() => doc.metadata.bookmarks).toEqual([2])
  expect(doc.metadata.title).toBe('Command Study')
  await run(page, '/bookmark')
  await expect.poll(() => doc.metadata.bookmarks).toEqual([])
  await run(page, '/memo')
  const textarea = reader(page).locator('.floating-memo-textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill('Spotlight page note')
  await textarea.evaluate(el => el.blur())
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('easypaper_memos_commands'))?.page_2?.at(-1)?.content)).toBe('Spotlight page note')
  await run(page, '/close-tab')
  await expect(page.locator('.workspace-tab[data-tab-id="document:commands"]')).toHaveCount(0)
  await run(page, '/reopen-tab')
  await expect(reader(page).locator('.floating-memo')).toContainText('Spotlight page note')
  await expect.poll(async () => (await snapshot(page)).page).toBe(2)
})

test('AI commands preserve drafts, summarize selected text and start a new context', async ({ page }) => {
  await setup(page)
  const requests = []
  await page.route('**/api/chat/stream', route => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"token":"Summary response"}\n\ndata: {"done":true}\n\n' })
  })
  await openReader(page)
  await run(page, '/ask What is this paper about?')
  await expect(reader(page).locator('#chat-input')).toBeFocused()
  await expect(reader(page).locator('#chat-input')).toHaveValue('What is this paper about?')
  expect(requests).toHaveLength(0)
  await run(page, '/summarize')
  await expect(reader(page).locator('.custom-confirm-modal')).toBeVisible()
  await reader(page).locator('.custom-confirm-modal .cancel-btn').click()
  await expect(reader(page).locator('#chat-input')).toHaveValue('What is this paper about?')
  await reader(page).locator('#chat-input').fill('')
  await reader(page).locator('.textLayer span').first().evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range) })
  await run(page, '/summarize')
  const replaceDraft = reader(page).locator('.custom-confirm-modal .confirm-btn')
  if (await replaceDraft.isVisible()) await replaceDraft.click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0].selected_text).toContain('Research evidence')
  await expect(reader(page).locator('#chat-input')).toBeEnabled()
  await run(page, '/new-chat')
  await expect(reader(page).locator('#chat-input')).toBeFocused()
  await expect(reader(page).locator('.chat-message.user')).toHaveCount(0)
  await reader(page).locator('#chat-input').fill('Fresh question')
  await reader(page).locator('#chat-input').press('Enter')
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1].messages).toHaveLength(1)
  expect(requests[1].messages[0].content).toBe('Fresh question')
})

test('citation copies known metadata to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await setup(page); await openReader(page)
  await run(page, '/copy-citation')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Alice. (2025). Command Study. https://doi.org/10.1/test')
})

test('reader commands are unavailable without a document and minimal mode restrictions are respected', async ({ page }) => {
  await setup(page, { minimal: true })
  for (const value of ['/page 1', '/ask', '/memo', '/bookmark', '/summarize', '/copy-citation', '/close-tab', '/reopen-tab', '/sidebar']) {
    await query(page, value)
    await expect(options(page)).toHaveAttribute('aria-disabled', 'true')
    await input(page).press('Enter')
    await expect(page.locator('#reader-command-dialog')).toBeVisible()
  }
})

test('bookmark failures leave stored state intact and report an error', async ({ page }) => {
  const doc = await setup(page); await openReader(page)
  await page.route('**/api/library/commands/metadata', route => {
    if (route.request().postDataJSON()?.bookmarks) return route.fulfill({ status: 500, json: { detail: 'Bookmark save failed' } })
    return route.fallback()
  })
  await run(page, '/bookmark')
  await expect(page.locator('#toast')).toContainText(/실패|failed/i)
  expect(doc.metadata.bookmarks).toBeUndefined()
})

test('AI commands cannot replace a response that is still streaming', async ({ page }) => {
  await setup(page); await openReader(page)
  let release
  const pending = new Promise(resolve => { release = resolve })
  let requested = false
  await page.route('**/api/chat/stream', async route => {
    requested = true
    await pending
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"token":"Done"}\n\ndata: {"done":true}\n\n' })
  })
  await run(page, '/ask In progress')
  await reader(page).locator('#chat-input').press('Enter')
  await expect.poll(() => requested).toBe(true)
  try {
    for (const value of ['/ask', '/new-chat', '/summarize']) {
      await query(page, value)
      await expect(options(page)).toHaveAttribute('aria-disabled', 'true')
    }
  } finally { release() }
  await input(page).press('Escape')
  await expect(reader(page).locator('#chat-input')).toBeEnabled()
})

test('document search cannot overwrite newer commands with a late response', async ({ page }) => {
  await setup(page)
  let release
  const pending = new Promise(resolve => { release = resolve })
  let started = false
  await page.route('**/api/library?*', async route => { started = true; await pending; await route.fulfill({ json: { documents: [{ id: 'late', filename: 'Late document' }] } }) })
  // A distinct mode cache entry is not needed: let the short shared GET TTL expire.
  await page.waitForTimeout(5100)
  await page.keyboard.press('Control+k')
  await input(page).fill('/open late')
  try {
    await expect.poll(() => started).toBe(true)
    await input(page).fill('/theme dark')
    await expect(options(page)).toHaveCount(1)
    await expect(options(page)).toContainText('/theme')
  } finally { release() }
  await expect(options(page)).not.toContainText('Late document')
  await input(page).press('Escape')
  await expect(page.locator('#reader-command-dialog')).toBeHidden()
})

test('article documents support zoom and a persisted page memo', async ({ page }) => {
  const doc = { id: 'commands', filename: 'Article.html', total_pages: 1, total_units: 1, content_kind: 'html_article', source_origin: 'web', source_url: 'https://example.test/article', metadata: { primer_shown: true }, translated_pages: [], document_mode: 'general', document_type: 'article' }
  const manifest = { schema_version: 1, title: 'Article', source_url: doc.source_url, embed_allowed: false, toc: [], blocks: [{ id: 'b1', type: 'p', text: 'Article source text', html: '<p data-block-id="b1">Article source text</p>' }], units: [{ index: 1, id: 'section-1', title: 'Introduction', block_ids: ['b1'], text: 'Article source text' }] }
  await mockBaseRoutes(page, { documents: [doc], workspaceSettings: { preferred_workspace_mode: 'general' } })
  await page.route('**/api/library/commands/article', route => route.fulfill({ json: manifest }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=commands' })
  await expect(reader(page).locator('[data-block-id="b1"]')).toBeVisible()
  await expect(reader(page).locator('#document-find')).toBeVisible()
  await run(page, '/zoom 150')
  await expect(reader(page).locator('.article-viewer')).toHaveCSS('--article-zoom', '1.5')
  await reader(page).locator('.article-toolbar [data-zoom=out]').click()
  await run(page, '/zoom-in')
  await expect.poll(() => reader(page).locator('.article-viewer').evaluate(el => Number(el.style.getPropertyValue('--article-zoom')))).toBeCloseTo(1.6)
  await run(page, '/fit-width')
  await expect(reader(page).locator('.article-viewer')).toHaveCSS('--article-zoom', '1')
  await run(page, '/memo')
  await expect(reader(page).locator('.folder-dialog-input')).toBeFocused()
  await reader(page).locator('.folder-dialog-input').fill('Article memo from Spotlight')
  await reader(page).locator('.folder-dialog-input').press('Enter')
  await expect(reader(page).locator('.article-memo')).toContainText('Article memo from Spotlight')
  await run(page, '/close-tab')
  await run(page, '/reopen-tab')
  await expect(reader(page).locator('.article-memo')).toContainText('Article memo from Spotlight')
})
