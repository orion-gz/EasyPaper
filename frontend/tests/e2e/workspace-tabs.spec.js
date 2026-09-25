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
  await frame.getByRole('tab', { name: 'Notes', exact: true }).click()
  await expect(frame.locator('#document-resource-list')).toBeVisible()
  await frame.getByRole('tab', { name: 'Annotations', exact: true }).click()
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
