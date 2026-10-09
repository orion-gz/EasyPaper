import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, openReaderTools, SAMPLE_PDF_A, SAMPLE_PDF_B } from './helpers.js'

const documents = [
  { id: 'read-a', filename: 'History A.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] },
  { id: 'read-b', filename: 'History B.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] },
]
const tab = (page, id) => page.locator(`.workspace-tab[data-tab-id="${id}"] [role="tab"]`)
const reader = (page, id = 'read-a') => page.frameLocator(`iframe[data-document-id="${id}"]`)
async function open(page, id = 'read-a') {
  await page.evaluate(id => { location.hash = `#viewer?id=${id}` }, id)
  await expect(reader(page, id).locator('#document-find')).toBeVisible({ timeout: 20000 })
}
async function setup(page) {
  await page.clock.install()
  await mockBaseRoutes(page, { documents })
  await page.route('**/api/library/read-a/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/library/read-b/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_B }))
  const state = { requests: [], metadata: [], fail: false, seconds: 0, stats: [], sessions: [] }
  await page.route('**/api/library/*/reading-session/*', async route => {
    const type = route.request().url().split('/').at(-1)
    state.sessions.push({ type, ...route.request().postDataJSON() })
    await route.fulfill({ json: { sessionId: 'test-session-' + route.request().url().split('/').at(-3), version: 0 } })
  })
  const accepted = new Set()
  await page.route('**/api/library/*/reading-heartbeat', async route => {
    const body = route.request().postDataJSON()
    state.requests.push({ ...body, id: route.request().url().split('/').at(-2) })
    if (!state.fail && !accepted.has(body.request_id)) { state.seconds += body.seconds; accepted.add(body.request_id) }
    await route.fulfill({ status: state.fail ? 503 : 200, json: { message: 'ok' } })
  })
  await page.route('**/api/library/*/metadata', async route => {
    state.metadata.push({ ...route.request().postDataJSON(), id: route.request().url().split('/').at(-2) })
    await route.fulfill({ json: documents[0] })
  })
  await page.route('**/api/library/reading-stats**', async route => {
    state.stats.push(state.seconds)
    await route.fulfill({ json: { total_seconds: state.seconds, total_seconds_by_day: {}, total_seconds_by_category: { reading: state.seconds }, total_seconds_by_doc: {} } })
  })
  await gotoApp(page)
  await open(page)
  return state
}

test('tab navigation saves short visits and updates History without closing the document', async ({ page }) => {
  const state = await setup(page)
  await page.clock.runFor(2500)
  await page.locator('.sidebar-nav-item[data-page="history"]').click()
  await expect.poll(() => state.seconds).toBeGreaterThanOrEqual(2)
  await expect.poll(() => state.stats.some(seconds => seconds >= 2)).toBe(true)
  expect(state.metadata.some(item => item.last_read_at && item.last_page === 1)).toBe(true)
  await expect(page.locator('iframe[data-document-id="read-a"]')).toHaveCount(1)
  const recorded = state.seconds
  await page.clock.runFor(25000)
  expect(state.seconds).toBe(recorded)
})

test('returning through the tab bar records time without clicking the PDF', async ({ page }) => {
  const state = await setup(page)
  await page.locator('.sidebar-nav-item[data-page="history"]').click()
  await expect(reader(page).locator('body')).toHaveAttribute('data-workspace-inactive', 'true')
  await expect.poll(() => state.stats.length).toBeGreaterThan(0)
  const before = state.seconds
  await tab(page, 'document:read-a').click()
  await expect(reader(page).locator('body')).toHaveAttribute('data-workspace-inactive', 'false')
  expect(await reader(page).locator('body').evaluate(() => document.hasFocus())).toBe(false)
  await page.clock.runFor(2500)
  await tab(page, 'page:history').click()
  await expect.poll(() => state.seconds).toBeGreaterThanOrEqual(before + 2)
})

test('closing before the periodic heartbeat saves time and releases the iframe', async ({ page }) => {
  const state = await setup(page)
  await page.clock.runFor(2500)
  await page.locator('.workspace-tab[data-tab-id="document:read-a"] .workspace-tab-close').click()
  await expect.poll(() => state.seconds).toBeGreaterThanOrEqual(2)
  await expect(page.locator('iframe[data-document-id="read-a"]')).toHaveCount(0)
  expect(state.requests.every(item => typeof item.request_id === 'string')).toBe(true)
  expect(state.sessions.some(item => item.type === 'end' && item.paperId === 'read-a' && item.activeReadingTime >= 2)).toBe(true)
})

test('failed save survives tab close and reload and retries the same request', async ({ page }) => {
  const state = await setup(page)
  state.fail = true
  await page.clock.runFor(2500)
  await page.locator('.workspace-tab[data-tab-id="document:read-a"] .workspace-tab-close').click()
  await expect(page.locator('iframe[data-document-id="read-a"]')).toHaveCount(0)
  await expect.poll(() => state.requests.length).toBeGreaterThan(0)
  const ids = state.requests.map(item => item.request_id)
  expect(state.seconds).toBe(0)
  state.fail = false
  await page.reload()
  await expect.poll(() => state.seconds).toBeGreaterThanOrEqual(2)
  expect(state.requests.some((item, index) => index >= ids.length && ids.includes(item.request_id))).toBe(true)
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('easypaper_reading_time:')).length)).toBe(0)
})

test('document switching isolates time and closing an inactive tab does not count its hidden interval', async ({ page }) => {
  const state = await setup(page)
  await page.clock.runFor(2500)
  await open(page, 'read-b')
  await expect.poll(() => state.requests.filter(item => item.id === 'read-a').length).toBeGreaterThan(0)
  const sumA = () => state.requests.filter(item => item.id === 'read-a').reduce((sum, item) => sum + item.seconds, 0)
  const savedA = sumA()
  const metadataA = state.metadata.filter(item => item.id === 'read-a').length
  await page.clock.runFor(6500)
  await page.locator('.workspace-tab[data-tab-id="document:read-a"] .workspace-tab-close').click()
  await expect(page.locator('iframe[data-document-id="read-a"]')).toHaveCount(0)
  expect(sumA()).toBe(savedA)
  expect(state.metadata.filter(item => item.id === 'read-a')).toHaveLength(metadataA)
  await page.locator('.sidebar-nav-item[data-page="history"]').click()
  await expect.poll(() => state.requests.filter(item => item.id === 'read-b').reduce((sum, item) => sum + item.seconds, 0)).toBeGreaterThanOrEqual(6)
})

test('reading and chat time stay distinct and idle time stops accumulating', async ({ page }) => {
  const state = await setup(page)
  await page.clock.runFor(2500)
  await openReaderTools(reader(page))
  await reader(page).locator('#chat-input').fill('draft')
  await page.clock.runFor(2500)
  await reader(page).locator('#viewer-scroll-container').click({ position: { x: 10, y: 10 } })
  await reader(page).locator('body').evaluate(() => window.__easypaperDocument.flush())
  const beforeIdle = state.seconds
  await page.clock.runFor(65000)
  await reader(page).locator('body').evaluate(() => window.__easypaperDocument.flush())
  expect(state.requests.some(item => item.category === 'chat')).toBe(true)
  expect(state.requests.some(item => item.category === 'reading')).toBe(true)
  // Setup and UI interaction take longer on WebKit; measure only the idle
  // window, allowing the subsecond remainder held before this window began.
  expect(state.seconds - beforeIdle).toBeLessThanOrEqual(61)
  const before = state.seconds
  await page.clock.runFor(25000)
  await reader(page).locator('body').evaluate(() => window.__easypaperDocument.flush())
  expect(state.seconds).toBe(before)
})

test('visibility lifecycle flushes once and excludes the hidden interval', async ({ page }) => {
  const state = await setup(page)
  await page.clock.runFor(2500)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => state.seconds).toBeGreaterThanOrEqual(2)
  await expect(reader(page).locator('body')).toHaveAttribute('data-workspace-inactive', 'true')
  const before = state.seconds
  await page.clock.runFor(25000)
  expect(state.seconds).toBe(before)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(reader(page).locator('body')).toHaveAttribute('data-workspace-inactive', 'false')
  await page.clock.runFor(2500)
  await page.locator('.sidebar-nav-item[data-page="history"]').click()
  await expect.poll(() => state.seconds).toBeGreaterThanOrEqual(before + 2)
})

test('pending saves do not block tab navigation and late completion does not reopen History', async ({ page }) => {
  await setup(page)
  let release
  let started = false
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/library/read-a/reading-heartbeat', async route => {
    started = true
    await pending
    await route.fulfill({ json: { message: 'ok' } })
  })
  await page.clock.runFor(2500)
  await page.locator('.sidebar-nav-item[data-page="history"]').click()
  await expect.poll(() => started).toBe(true)
  await open(page, 'read-b')
  await page.locator('.workspace-tab[data-tab-id="document:read-a"] .workspace-tab-close').click()
  await expect(page.locator('iframe[data-document-id="read-a"]')).toHaveCount(1)
  release()
  await expect(page.locator('iframe[data-document-id="read-a"]')).toHaveCount(0)
  await expect(tab(page, 'document:read-b')).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/#viewer\?id=read-b$/)
})

test('reopening a closed reader while saving resumes its reading session', async ({ page }) => {
  const state = await setup(page)
  let release
  let started = false
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/library/read-a/reading-heartbeat', async route => {
    started = true
    await pending
    await route.fulfill({ json: { message: 'ok' } })
  })
  await page.clock.runFor(2500)
  await page.locator('.workspace-tab[data-tab-id="document:read-a"] .workspace-tab-close').click()
  await expect.poll(() => started).toBe(true)
  await expect(tab(page, 'document:read-a')).toHaveCount(0)
  await open(page)
  await expect.poll(() => state.sessions.filter(item => item.type === 'start').length).toBe(2)
  release()
  await page.clock.runFor(2500)
  await page.locator('.sidebar-nav-item[data-page="history"]').click()
  await expect.poll(() => state.sessions.filter(item => item.type === 'heartbeat' && item.activeReadingTime >= 2).length).toBeGreaterThan(0)
  await expect(page.locator('iframe[data-document-id="read-a"]')).toHaveCount(1)
})
