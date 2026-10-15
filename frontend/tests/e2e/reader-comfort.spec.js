import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A, openReaderTools } from './helpers.js'

const doc = { id: 'comfort', filename: 'Attention.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [] }
const features = ['quickActions', 'restoreReading', 'referenceReturn', 'focusReading', 'taskProgress', 'commandSearch']
const reader = page => page.frameLocator('iframe[data-document-id="comfort"]')
async function setup(page) {
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/comfort/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/tasks', route => route.fulfill({ json: { tasks: [] } }))
  await page.route('**/api/library/command-search?*', route => route.fulfill({ json: { results: [{ kind: 'document', doc_id: doc.id, title: doc.filename, text: 'Attention' }] } }))
  await gotoApp(page)
}
async function open(page) {
  await page.evaluate(() => { location.hash = '#viewer?id=comfort' })
  await expect(reader(page).locator('#document-find')).toBeVisible({ timeout: 20000 })
}
async function settings(page) {
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('#settings-nav-general').click()
}

test('all six controls persist independently and apply to open readers', async ({ page }) => {
  await setup(page); await open(page); await settings(page)
  for (const feature of features) {
    const toggle = page.locator(`#setting-reader-${feature}`)
    await expect(toggle).toBeChecked()
    await toggle.locator('..').click()
  }
  await expect(reader(page).locator('#reader-focus')).toBeHidden()
  await expect(page.locator('#reader-tasks')).toBeHidden()
  await expect(page.locator('#reader-command-search')).toBeHidden()
  await page.locator('#close-settings-btn').click()
  await page.keyboard.press('Control+k')
  await expect(page.locator('#reader-command-dialog')).not.toBeVisible()
  await page.reload(); await expect(reader(page).locator('#document-find')).toBeVisible({ timeout: 20000 })
  await settings(page)
  for (const feature of features) await expect(page.locator(`#setting-reader-${feature}`)).not.toBeChecked()
  await page.locator('#setting-reader-focusReading').locator('..').click()
  await expect(reader(page).locator('#reader-focus')).toBeVisible()
  await expect(page.locator('#setting-reader-commandSearch')).not.toBeChecked()
})

test('command palette works from iframe and focus restores panels', async ({ page }) => {
  await setup(page); await open(page)
  await openReaderTools(reader(page))
  await expect(reader(page).locator('#chat-sidebar')).toBeVisible()
  await reader(page).locator('#reader-focus').click()
  await expect(reader(page).locator('#chat-sidebar')).toBeHidden()
  await expect(page.locator('#app-sidebar')).toBeHidden()
  await reader(page).locator('#viewer-scroll-container').focus()
  await page.keyboard.press('Control+k')
  const input = page.locator('#reader-command-dialog input')
  await expect(input).toBeFocused()
  await input.fill('> 집중')
  await expect(page.locator('#reader-command-results [role="option"]')).toHaveCount(1)
  await input.press('Enter')
  await expect(reader(page).locator('#chat-sidebar')).toBeVisible()
  await expect(page.locator('#app-sidebar')).toBeVisible()
})

test('reference return restores the previous position and disabling clears the trail', async ({ page }) => {
  await setup(page); await open(page); await openReaderTools(reader(page))
  await reader(page).locator('body').evaluate(async () => { await window.__easypaperDocument.restore({ page: 1, zoom: 3, fitWidth: false, panelOpen: true }, { force: true }) })
  await reader(page).locator('#chat-messages').evaluate(el => {
    const button = document.createElement('button'); button.dataset.pageCitation = '1'; button.textContent = 'Source'; el.append(button)
    const scroll = document.getElementById('viewer-scroll-container'); scroll.scrollTop = 200
  })
  await reader(page).getByRole('button', { name: 'Source', exact: true }).click()
  await expect(reader(page).locator('#reader-return')).toBeVisible()
  await reader(page).locator('#reader-return').click()
  await expect(reader(page).locator('#reader-return')).toBeHidden()
  await expect.poll(() => reader(page).locator('#viewer-scroll-container').evaluate(el => el.scrollTop)).toBeGreaterThan(100)
  await reader(page).getByRole('button', { name: 'Source', exact: true }).click()
  await settings(page); await page.locator('#setting-reader-referenceReturn').locator('..').click()
  await expect(reader(page).locator('#reader-return')).toBeHidden()
})

test('selection quick actions can be disabled without disabling text selection', async ({ page }) => {
  await setup(page); await open(page)
  const select = async () => {
    await expect(reader(page).locator('.textLayer span').first()).toBeVisible({ timeout: 20000 })
    await reader(page).locator('.textLayer span').first().evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
  }
  await select()
  await expect(reader(page).locator('#selection-menu')).toBeVisible()
  await expect(reader(page).locator('#selection-menu')).toContainText('쉽게 설명')
  await settings(page); await page.locator('#setting-reader-quickActions').locator('..').click(); await page.locator('#close-settings-btn').click()
  await select()
  await expect(reader(page).locator('#selection-menu')).toBeHidden()
  expect(await reader(page).locator('body').evaluate(() => window.getSelection().toString().length)).toBeGreaterThan(0)
})

test('task center uses server counts and cancelling does not erase completed work', async ({ page }) => {
  await setup(page)
  const task = { id: 'task-1', doc_id: doc.id, filename: doc.filename, kind: 'translate', status: 'running', total_pages: 3, completed_pages: [1], failed_pages: [] }
  await page.route('**/api/tasks', route => route.fulfill({ json: { tasks: [task] } }))
  let cancelled = false
  await page.route('**/api/tasks/task-1/cancel', async route => { cancelled = true; task.status = 'cancelled'; await route.fulfill({ json: task }) })
  await page.locator('#reader-tasks').click()
  await expect(page.locator('#reader-task-list')).toContainText('1 / 3페이지 완료')
  await page.locator('#reader-task-list').getByRole('button', { name: '취소', exact: true }).click()
  await expect(page.locator('#reader-task-list')).toContainText('취소됨')
  expect(cancelled).toBe(true)
  await expect(page.locator('#reader-task-list')).toContainText('1 / 3페이지 완료')
})

test('search memo results retain exact anchors', async ({ page }) => {
  await setup(page)
  await page.route('**/api/library/command-search?*', route => route.fulfill({ json: { results: [{ kind: 'memo', doc_id: doc.id, title: doc.filename, text: 'Attention memo', page: 1, memo_id: 'note-7' }] } }))
  await page.keyboard.press('Control+k')
  await page.locator('#reader-command-dialog input').fill('attention')
  await expect(page.locator('#reader-command-results')).toContainText('Attention memo')
  await page.locator('#reader-command-dialog input').press('Enter')
  await expect(page).toHaveURL(/memoId=note-7/)
})


test('closed readers restore zoom and translation visibility; disabling starts fresh', async ({ page }) => {
  await setup(page); await open(page)
  await reader(page).locator('body').evaluate(async () => {
    await window.__easypaperDocument.restore({ page: 1, zoom: 2.5, fitWidth: false, translationCollapsed: true }, { force: true })
  })
  await page.locator('.workspace-tab[data-tab-id="document:comfort"] .workspace-tab-close').click()
  await open(page)
  await expect.poll(() => reader(page).locator('body').evaluate(() => window.__easypaperDocument.snapshot().zoom)).toBe(2.5)
  await expect(reader(page).locator('body')).toHaveClass(/collapse-translation/)
  await settings(page)
  await page.locator('#setting-reader-restoreReading').locator('..').click()
  await page.locator('#close-settings-btn').click()
  await page.locator('.workspace-tab[data-tab-id="document:comfort"] .workspace-tab-close').click()
  await open(page)
  await expect.poll(() => reader(page).locator('body').evaluate(() => window.__easypaperDocument.snapshot().fitWidth)).toBe(true)
})
