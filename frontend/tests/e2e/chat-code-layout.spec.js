import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

for (const width of [390, 1280]) {
  test(`code actions and table remain usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => { window.copiedText = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedText = value } } }) })
    const doc = { id: 'code-doc', filename: 'code.pdf', total_pages: 1, metadata: { title: 'Code paper' }, created_at: '2026-01-01T00:00:00Z', translated_pages: [] }
    const language = 'verylonglanguage'.repeat(8)
    const code = 'const example = ' + 'long_value_'.repeat(40)
    const content = '## Example\n\n```' + language + '\n' + code + '\n```\n\n| Column one | Column two | Column three | Column four |\n|---|---|---|---|\n| data one | data two | data three | data four |'
    await mockBaseRoutes(page, { documents: [doc] })
    await page.route('**/api/chat/sessions*', r => r.fulfill({ json: { sessions: [{ doc_id: doc.id, title: 'Code paper', filename: doc.filename, created_at: doc.created_at, last_message_at: doc.created_at }] } }))
    await page.route('**/api/chat/code-doc/history', r => r.fulfill({ json: { history: [{ role: 'assistant', content }] } }))
    await gotoApp(page)
    await page.locator('.sidebar-nav-item[data-page="chats"]').click()
    await page.locator('.aic-action-btn[data-action="chat"]').click()
    const bubble = page.locator('#chat-drawer-messages .message-bubble').filter({ has: page.locator('.chat-code-copy') })
    const button = bubble.locator('.chat-code-copy')
    await expect(button).toBeVisible()
    const dimensions = await button.evaluate(node => {
      const r = node.getBoundingClientRect(), header = node.parentElement.getBoundingClientRect()
      return { height: r.height, bottom: r.bottom, top: r.top, right: r.right, headerRight: header.right, whitespace: getComputedStyle(node).whiteSpace }
    })
    expect(dimensions.whitespace).toBe('nowrap')
    expect(dimensions.height).toBeLessThan(40)
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.headerRight)
    const table = await bubble.locator('table').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, cell: node.querySelector('td').clientWidth }))
    expect(table.cell).toBeGreaterThan(40)
    expect(table.scroll).toBeGreaterThanOrEqual(table.width)
    await button.click()
    await expect.poll(() => page.evaluate(() => window.copiedText)).toBe(code + '\n')
    await page.screenshot({ path: testInfo.outputPath('chat-code-layout.png'), fullPage: true })
    await bubble.locator('..').locator('.message-actions button').first().click()
    const copied = await page.evaluate(() => window.copiedText)
    expect(copied).toContain(code)
    expect(copied).not.toContain(language)
  })
}
