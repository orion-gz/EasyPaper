import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A, SAMPLE_PDF_B } from './helpers.js'

const documents = [
  { id: 'tab-a', filename: 'Attention.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] },
  { id: 'tab-b', filename: 'BERT.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] },
]
async function setup(page) {
  await mockBaseRoutes(page, { documents })
  await page.route('**/api/library/tab-a/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/library/tab-b/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_B }))
  await gotoApp(page)
}
const tab = (page, id) => page.locator(`.workspace-tab[data-tab-id="${id}"] [role="tab"]`)
const reader = (page, id) => page.frameLocator(`iframe[data-document-id="${id}"]`)
async function open(page, id) {
  await page.evaluate(id => { location.hash = `#viewer?id=${id}` }, id)
  await expect(reader(page, id).locator('#workspace-reading-mode')).toBeVisible({ timeout: 20000 })
}
test('common shell, document isolation, menu singleton, close and restore', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await setup(page)
  await open(page, 'tab-a')
  await reader(page, 'tab-a').locator('#chat-input').fill('Draft A')
  await reader(page, 'tab-a').locator('#workspace-reading-mode').selectOption('translation')
  await open(page, 'tab-b')
  await expect(reader(page, 'tab-b').locator('#chat-input')).toHaveValue('')
  await tab(page, 'document:tab-a').click()
  await expect(reader(page, 'tab-a').locator('#chat-input')).toHaveValue('Draft A')
  await expect(reader(page, 'tab-a').locator('#workspace-reading-mode')).toHaveValue('translation')
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await page.locator('.sidebar-nav-item[data-page="library"]').click()
  await expect(page.locator('.workspace-tab[data-tab-id="page:library"]')).toHaveCount(1)
  await tab(page, 'document:tab-b').click()
  await page.reload()
  await expect(reader(page, 'tab-b').locator('#workspace-reading-mode')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.workspace-tab[data-tab-id^="document:"]')).toHaveCount(2)
  await expect(page.locator('iframe[data-document-id="tab-a"]')).toHaveCount(0)
  await tab(page, 'document:tab-a').click()
  await expect(reader(page, 'tab-a').locator('#workspace-reading-mode')).toHaveValue('translation', { timeout: 20000 })
  await expect(reader(page, 'tab-a').locator('#chat-input')).toHaveValue('')
  await page.locator('.workspace-tab[data-tab-id="document:tab-a"] .workspace-tab-close').click()
  await expect(page.locator('.workspace-tab[data-tab-id="document:tab-a"]')).toHaveCount(0)
  expect(errors).toEqual([])
})
test('keyboard tabs and all menu entries share the tab bar', async ({ page }) => {
  await setup(page)
  for (const name of ['chats', 'notes', 'history', 'graph', 'dashboard']) {
    await page.locator(`.sidebar-nav-item[data-page="${name}"]`).click()
    await expect(tab(page, `page:${name}`)).toHaveAttribute('aria-selected', 'true')
  }
  await tab(page, 'page:dashboard').focus()
  await page.keyboard.press('End')
  await expect(page.locator('.workspace-tab:last-child [role="tab"]')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Home')
  await expect(page.locator('.workspace-tab:first-child [role="tab"]')).toHaveAttribute('aria-selected', 'true')
})
test('document tools and responsive reading layout', async ({ page }) => {
  await page.setViewportSize({ width: 1591, height: 988 })
  await setup(page)
  await open(page, 'tab-a')
  const frame = reader(page, 'tab-a')
  await frame.getByRole('tab', { name: '메모', exact: true }).click()
  await expect(frame.locator('#document-resource-list')).toBeVisible()
  await frame.getByRole('tab', { name: '주석', exact: true }).click()
  await expect(frame.locator('#document-resource-list')).toContainText('하이라이트')
  await frame.locator('#workspace-reading-mode').selectOption('parallel')
  await expect(frame.locator('#chat-sidebar')).toBeHidden()
  await frame.locator('#workspace-reading-mode').selectOption('original')
  await expect(frame.locator('#chat-sidebar')).toBeVisible()
  await page.screenshot({ path: 'test-results/workspace-desktop.png' })
  await page.setViewportSize({ width: 800, height: 700 })
  await expect(page.locator('.workspace-tab-list')).toBeVisible()
  await page.screenshot({ path: 'test-results/workspace-narrow.png' })
})

test('AI response stays in its document after switching and closing the tab', async ({ page }) => {
  await setup(page)
  let release
  let request
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/chat/stream', async route => {
    request = route.request().postDataJSON()
    await pending
    await route.fulfill({ contentType: 'text/event-stream', body: 'event: answer\ndata: {"delta":"Answer for document A"}\n\nevent: done\ndata: {}\n\n' })
  })
  await open(page, 'tab-a')
  await reader(page, 'tab-a').locator('#chat-input').fill('Question A')
  await reader(page, 'tab-a').locator('#chat-input').press('Enter')
  await expect.poll(() => request?.session_id).toBe('tab-a')
  await expect(page.locator('.workspace-tab[data-tab-id="document:tab-a"] .busy')).toBeVisible()
  await open(page, 'tab-b')
  await page.locator('.workspace-tab[data-tab-id="document:tab-a"] .workspace-tab-close').click()
  await expect(page.locator('iframe[data-document-id="tab-a"]')).toHaveCount(1)
  release()
  await expect(page.locator('iframe[data-document-id="tab-a"]')).toHaveCount(0)
  await expect(reader(page, 'tab-b').locator('#chat-messages')).not.toContainText('Answer for document A')
})

test('inactive PDF canvases are released and resume on activation', async ({ page }) => {
  await setup(page)
  await open(page, 'tab-a')
  await expect(reader(page, 'tab-a').locator('.pdf-page-wrapper canvas')).toBeAttached()
  await open(page, 'tab-b')
  await expect(reader(page, 'tab-a').locator('.pdf-page-wrapper canvas')).toHaveCount(0)
  await expect(reader(page, 'tab-a').locator('body')).toHaveAttribute('data-workspace-inactive', 'true')
  await tab(page, 'document:tab-a').click()
  await expect(reader(page, 'tab-a').locator('.pdf-page-wrapper canvas')).toBeAttached()
  await expect(reader(page, 'tab-b').locator('body')).toHaveAttribute('data-workspace-inactive', 'true')
})

test('failed document can retry; deleted document is removed', async ({ page }) => {
  await setup(page)
  let fail = true
  await page.route('**/api/library/tab-a', route => route.fulfill({ status: fail ? 503 : 200, json: fail ? { detail: 'unavailable' } : documents[0] }))
  await page.evaluate(() => { location.hash = '#viewer?id=tab-a' })
  await expect(reader(page, 'tab-a').locator('.workspace-load-error')).toBeVisible()
  fail = false
  await reader(page, 'tab-a').locator('.workspace-load-error button').click()
  await expect(reader(page, 'tab-a').locator('#workspace-reading-mode')).toBeVisible({ timeout: 15000 })
  await page.evaluate(() => { location.hash = '#viewer?id=deleted' })
  await expect(page.locator('.workspace-tab[data-tab-id="document:deleted"]')).toHaveCount(0)
  await expect(tab(page, 'document:tab-a')).toHaveAttribute('aria-selected', 'true')
})

test('theme, accent and UI scale synchronize with open documents', async ({ page }) => {
  await setup(page)
  await open(page, 'tab-a')
  const frame = reader(page, 'tab-a')
  await page.locator('#sidebar-theme-toggle-btn').click()
  await expect(frame.locator('body')).toHaveClass(/light-theme/)
  const accent = await page.locator('body').evaluate(element => element.style.getPropertyValue('--control-accent-text'))
  await expect.poll(() => frame.locator('body').evaluate(element => element.style.getPropertyValue('--control-accent-text'))).toBe(accent)
  await page.locator('#setting-ui-scale').evaluate(select => {
    select.value = '0.8'
    select.dispatchEvent(new Event('change'))
  })
  await expect(frame.locator('html')).toHaveCSS('zoom', '0.8')
  const outlet = await page.locator('#workspace-tab-panel').boundingBox()
  const documentFrame = await page.locator('iframe[data-document-id="tab-a"]').boundingBox()
  expect(Math.abs(documentFrame.width - outlet.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(documentFrame.height - outlet.height)).toBeLessThanOrEqual(1)
  await page.locator('#sidebar-theme-toggle-btn').click()
  await expect(frame.locator('body')).not.toHaveClass(/light-theme/)
})

test('fit width follows panels and resize; manual zoom and fit preference survive reload', async ({ page }) => {
  await page.setViewportSize({ width: 1591, height: 988 })
  await setup(page)
  await open(page, 'tab-a')
  const frame = reader(page, 'tab-a')
  const fits = () => frame.locator('#viewer-scroll-container').evaluate(el => {
    const paper = el.querySelector('.pdf-page-wrapper')?.getBoundingClientRect()
    const viewport = el.getBoundingClientRect()
    return paper && paper.width <= viewport.width && paper.left >= viewport.left - 2 && paper.right <= viewport.right + 2 && el.scrollWidth <= el.clientWidth + 2
  })
  await expect.poll(fits).toBe(true)
  await frame.locator('#chat-close-btn').click()
  await expect.poll(fits).toBe(true)
  await page.setViewportSize({ width: 1100, height: 800 })
  await expect.poll(fits).toBe(true)
  await frame.locator('#zoom-in-btn').click()
  await expect(frame.locator('#document-fit-width')).toHaveAttribute('aria-pressed', 'false')
  await frame.locator('#document-fit-width').click()
  await expect(frame.locator('#document-fit-width')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(fits).toBe(true)
  await open(page, 'tab-b')
  await tab(page, 'document:tab-a').click()
  await page.reload()
  await expect(frame.locator('#document-fit-width')).toHaveAttribute('aria-pressed', 'true', { timeout: 20000 })
  await expect.poll(fits).toBe(true)
})

test('document find searches PDF text, shows a highlighted result, and keeps queries isolated', async ({ page }) => {
  await setup(page)
  await open(page, 'tab-a')
  const frame = reader(page, 'tab-a')
  await expect(frame.locator('.textLayer')).not.toBeEmpty()
  const word = await frame.locator('.textLayer').first().evaluate(el => el.textContent.match(/[a-zA-Z]{4,}/)[0])
  await frame.locator('#document-find').click()
  await frame.locator('#document-search input').fill(word)
  await expect(frame.locator('#document-search output')).toContainText('1 /')
  await expect(frame.locator('.document-search-snippet mark')).toContainText(word)
  await expect.poll(() => frame.locator('body').evaluate(() => CSS.highlights?.has('document-find'))).toBe(true)
  await open(page, 'tab-b')
  await reader(page, 'tab-b').locator('#document-find').click()
  await expect(reader(page, 'tab-b').locator('#document-search input')).toHaveValue('')
  await tab(page, 'document:tab-a').click()
  await expect(frame.locator('#document-search input')).toHaveValue(word)
  await frame.locator('#document-search input').fill('no_such_phrase_82731')
  await expect(frame.locator('#document-search output')).toHaveText('검색 결과 없음')
  await frame.locator('#document-search input').press('Escape')
  await expect(frame.locator('#document-search')).toBeHidden()
})

test('hand tool pans without selecting text and select tool restores selection', async ({ page }) => {
  await setup(page)
  await open(page, 'tab-a')
  const frame = reader(page, 'tab-a')
  await frame.locator('#zoom-in-btn').click({ clickCount: 4, delay: 150 })
  await frame.locator('#document-pan-tool').click()
  await expect(frame.locator('#document-pan-tool')).toHaveAttribute('aria-pressed', 'true')
  const viewport = frame.locator('#viewer-scroll-container')
  const box = await viewport.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2 - 100, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(40)
  expect(await viewport.evaluate(() => window.getSelection().toString())).toBe('')
  await frame.locator('#document-select-tool').click()
  await expect(viewport).not.toHaveClass(/document-pan-mode/)
})

test('resource list updates across runtimes and pending sync does not block switching or closing', async ({ page }) => {
  await setup(page)
  await page.route('**/api/library/tab-a/memos', route => route.fulfill({ status: 503, json: { detail: 'offline' } }))
  await open(page, 'tab-a')
  const frame = reader(page, 'tab-a')
  await frame.locator('#document-tool-notes').click()
  await page.evaluate(() => {
    const memo = { id: 'pending-note', content: 'Durable pending note', sentenceText: 'test' }
    localStorage.setItem('easypaper_memos_tab-a', JSON.stringify({ page_1: [memo] }))
    localStorage.setItem('easypaper_annotation_sync_queue_memos_tab-a', JSON.stringify([{ mutation_id: 'test-pending', operation: 'upsert', item_id: memo.id, page_key: 'page_1', base_version: 0, item: memo }]))
  })
  await expect(frame.locator('#document-resource-list')).toContainText('Durable pending note')
  await open(page, 'tab-b')
  await page.locator('.workspace-tab[data-tab-id="document:tab-a"] .workspace-tab-close').click()
  await expect(tab(page, 'document:tab-a')).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('easypaper_annotation_sync_queue_memos_tab-a')).length)).toBe(1)
})

test('tab reorder persists and browser history activates existing document tabs', async ({ page }) => {
  await setup(page)
  await open(page, 'tab-a')
  await open(page, 'tab-b')
  await tab(page, 'document:tab-b').focus()
  await page.keyboard.press('Alt+ArrowLeft')
  const order = await page.locator('.workspace-tab').evaluateAll(items => items.map(el => el.dataset.tabId))
  expect(order.indexOf('document:tab-b')).toBeLessThan(order.indexOf('document:tab-a'))
  await page.reload()
  await expect(tab(page, 'document:tab-b')).toBeVisible()
  expect(await page.locator('.workspace-tab').evaluateAll(items => items.map(el => el.dataset.tabId))).toEqual(order)
  await tab(page, 'document:tab-a').click()
  await tab(page, 'document:tab-b').click()
  await page.goBack()
  await expect(tab(page, 'document:tab-a')).toHaveAttribute('aria-selected', 'true')
  await page.goForward()
  await expect(tab(page, 'document:tab-b')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.workspace-tab[data-tab-id^="document:"]')).toHaveCount(2)
})

test('manual translation survives switching and closing its document', async ({ page }) => {
  await setup(page)
  let release
  let started = false
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/translate/tab-a/1**', async route => {
    started = true
    await pending
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"Background translation A"}\n\ndata: {"done":true,"sentences":[]}\n\n' })
  })
  await page.evaluate(() => localStorage.setItem('easypaper_translation_mode', 'pane'))
  await open(page, 'tab-a')
  await reader(page, 'tab-a').locator('#workspace-reading-mode').selectOption('parallel')
  await reader(page, 'tab-a').locator('.translate-page-btn').click()
  await expect.poll(() => started).toBe(true)
  await open(page, 'tab-b')
  await page.locator('.workspace-tab[data-tab-id="document:tab-a"] .workspace-tab-close').click()
  await expect(page.locator('iframe[data-document-id="tab-a"]')).toHaveCount(1)
  release()
  await expect(page.locator('iframe[data-document-id="tab-a"]')).toHaveCount(0)
  await expect(reader(page, 'tab-b').locator('#viewer-screen')).not.toContainText('Background translation A')
})

test('manual translation failures appear on the tab and clear after retry', async ({ page }) => {
  await setup(page)
  let fail = true
  await page.route('**/api/translate/tab-a/1**', route => route.fulfill({ contentType: 'text/event-stream', body: fail
    ? 'data: {"error":"Translation unavailable"}\n\n'
    : 'data: {"content":"Recovered translation"}\n\ndata: {"done":true,"sentences":[]}\n\n' }))
  await page.evaluate(() => localStorage.setItem('easypaper_translation_mode', 'pane'))
  await open(page, 'tab-a')
  const frame = reader(page, 'tab-a')
  await frame.locator('#workspace-reading-mode').selectOption('parallel')
  await frame.locator('.translate-page-btn').click()
  await expect(page.locator('.workspace-tab[data-tab-id="document:tab-a"] .error')).toBeVisible()
  fail = false
  await frame.locator('.translate-page-btn').click()
  await expect(frame.locator('.trans-text')).toContainText('Recovered translation')
  await expect(page.locator('.workspace-tab[data-tab-id="document:tab-a"] .error')).toHaveCount(0)
})

test('research and general workspaces restore their own tabs', async ({ page }) => {
  await setup(page)
  await open(page, 'tab-a')
  await page.locator('#app-sidebar button[data-workspace-mode="general"]').click()
  await expect(tab(page, 'document:tab-a')).toHaveCount(0)
  await page.locator('.sidebar-nav-item[data-page="notes"]').click()
  await page.locator('#app-sidebar button[data-workspace-mode="research"]').click()
  await expect(tab(page, 'document:tab-a')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'page:notes')).toHaveCount(0)
  await page.locator('#app-sidebar button[data-workspace-mode="general"]').click()
  await expect(tab(page, 'page:notes')).toHaveAttribute('aria-selected', 'true')
})

test('twelve document runtimes keep only the active PDF rendered and release on close', async ({ page, browserName }, testInfo) => {
  test.setTimeout(120000)
  const many = Array.from({ length: 12 }, (_, index) => ({ ...documents[0], id: `many-${index}`, filename: `Document ${index}.pdf` }))
  await mockBaseRoutes(page, { documents: many })
  await page.route('**/api/library/many-*/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await gotoApp(page)
  const client = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
  await client?.send('Performance.enable')
  const metrics = { before: await client?.send('Performance.getMetrics') }
  for (const doc of many) await open(page, doc.id)
  await expect(page.locator('.workspace-document-frame')).toHaveCount(12)
  const canvasCounts = () => page.evaluate(() => [...document.querySelectorAll('.workspace-document-frame')].map(frame => frame.contentDocument.querySelectorAll('.pdf-page-wrapper canvas').length))
  await expect.poll(async () => (await canvasCounts()).filter(Boolean).length).toBe(1)
  metrics.twelve = await client?.send('Performance.getMetrics')
  for (const doc of many.slice(0, -1)) await page.locator(`.workspace-tab[data-tab-id="document:${doc.id}"] .workspace-tab-close`).click()
  await expect(page.locator('.workspace-document-frame')).toHaveCount(1)
  metrics.closed = await client?.send('Performance.getMetrics')
  await testInfo.attach('runtime-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
})

test('active tab stays visible after tablet resize and global find shortcut enters the reader', async ({ page }) => {
  await page.setViewportSize({ width: 1591, height: 988 })
  await setup(page)
  await open(page, 'tab-a')
  await open(page, 'tab-b')
  await page.setViewportSize({ width: 800, height: 700 })
  await expect.poll(async () => {
    const strip = await page.locator('.workspace-tab-list').boundingBox()
    const current = await tab(page, 'document:tab-b').boundingBox()
    return current.x >= strip.x - 1 && current.x + current.width <= strip.x + strip.width + 1
  }).toBe(true)
  await tab(page, 'document:tab-b').focus()
  await page.keyboard.press('Control+f')
  await expect(reader(page, 'tab-b').locator('#document-search input')).toBeFocused()
})

test('find includes pages outside the rendered viewport', async ({ page }) => {
  const doc = { ...documents[0], id: 'search-long', total_pages: 3 }
  const lines = ['First page introduction', 'Second page discussion', 'Needle phrase on the final page']
  const streams = lines.map(line => `BT /F1 20 Tf 50 700 Td (${line}) Tj ET`)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>',
    ...lines.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 6 0 R >> >> /Contents ${index + 7} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(stream => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/search-long/pdf', route => route.fulfill({ contentType: 'application/pdf', body: Buffer.from(pdf) }))
  await gotoApp(page)
  await open(page, doc.id)
  const frame = reader(page, doc.id)
  await frame.locator('#document-find').click()
  await frame.locator('#document-search input').fill('Needle phrase')
  await expect(frame.locator('#document-search output')).toHaveText('1 / 1')
  await expect(frame.locator('#page-input')).toHaveValue('3')
  await expect(frame.locator('.document-search-snippet')).toContainText('3:')
  await expect.poll(() => frame.locator('body').evaluate(() => CSS.highlights?.has('document-find'))).toBe(true)
})
