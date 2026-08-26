import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

test('AI 어시스턴트 입력창을 확장하고 다시 축소할 수 있다', async ({ page }) => {
  const doc = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/doc-A/pdf', route =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1000)
  await page.click('#chat-toggle-btn')

  const input = page.locator('#chat-input')
  const inputBox = input.locator('..')
  const expandButton = page.locator('#chat-input-expand-btn')
  const collapsedHeight = await input.evaluate(element => element.getBoundingClientRect().height)

  await expect(expandButton).toHaveAttribute('aria-expanded', 'false')
  await expandButton.click()

  await expect(inputBox).toHaveClass(/expanded/)
  await expect(expandButton).toHaveAttribute('aria-expanded', 'true')
  await expect(expandButton).toHaveAttribute('aria-label', '입력창 축소')
  await expect.poll(() => input.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight)
  await expect(input).toBeFocused()

  await expandButton.click()

  await expect(inputBox).not.toHaveClass(/expanded/)
  await expect(expandButton).toHaveAttribute('aria-expanded', 'false')
  await expect(expandButton).toHaveAttribute('aria-label', '입력창 확장')
})

test('뷰어 AI 어시스턴트 입력창에 포커스 테두리를 표시하지 않는다', async ({ page }) => {
  const doc = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/doc-A/pdf', route =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1000)
  await page.click('#chat-toggle-btn')

  const input = page.locator('#chat-input')
  const inputBox = input.locator('..')
  const borderColor = await inputBox.evaluate(element => getComputedStyle(element).borderColor)

  await input.click()

  await expect(input).toBeFocused()
  await expect.poll(() => input.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
  await expect.poll(() => inputBox.evaluate(element => getComputedStyle(element).borderColor)).toBe(borderColor)
})
