import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { activeReader, readerPoint, mockBaseRoutes, gotoApp } from './helpers.js'

const pdf = fs.readFileSync(new URL('./fixtures/sentence-bounds.pdf', import.meta.url))
for (const mode of ['exact', 'missing', 'prefix']) {
  test(`sentence hover and translation highlight stay bounded: ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1200 })
    await page.route(/^https:\/\//, route => route.fulfill({
      contentType: route.request().url().includes('.js') && !route.request().url().includes('.css') ? 'text/javascript' : 'text/css', body: '',
    }))
    const first = mode === 'exact' ? 'First sentence.' : mode === 'missing' ? 'Missing OCR sentence.' : 'First sentence with OCR content that differs.'
    const sources = mode === 'exact' ? [first, 'Second sentence.', 'Last sentence.'] : [first, 'Last sentence.']
    await mockBaseRoutes(page, { documents: [{ id: 'bounds', filename: 'bounds.pdf', total_pages: 1, metadata: { title: 'Bounds' }, translated_pages: [1] }] })
    await page.route('**/api/library/bounds/pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
    await page.route('**/api/library/bounds/translation/1**', route => route.fulfill({ json: {
      translation: sources.map((_, i) => `번역 문장 ${i + 1}입니다.`).join('\n\n'),
      sentences: sources.map((src, i) => ({ src, trans: `번역 문장 ${i + 1}입니다.` })),
    } }))
    await gotoApp(page)
    await page.evaluate(() => { location.hash = '#viewer?id=bounds' })
    await expect(activeReader(page).locator('.textLayer[data-segmented="true"]')).toBeVisible({ timeout: 15_000 })
    const translation = activeReader(page).locator('.trans-sentence[data-sentence-idx="0"]').first()
    await expect(translation).toBeVisible()
    await translation.hover()
    const boxes = activeReader(page).locator('.sentence-hover-box')
    if (mode !== 'exact') {
      await expect(boxes).toHaveCount(0)
      return
    }
    await expect(boxes.first()).toBeVisible()
    const span = activeReader(page).locator('.textLayer span').filter({ hasText: 'First sentence.' }).first()
    const metrics = await span.evaluate(el => {
      const node = el.firstChild
      const range = document.createRange()
      range.setStart(node, 0); range.setEnd(node, 'First sentence.'.length)
      const target = range.getBoundingClientRect()
      const boxes = [...el.closest('.pdf-page-inner').querySelectorAll('.sentence-hover-box')].map(box => box.getBoundingClientRect())
      return { target: target.toJSON(), boxes: boxes.map(r => r.toJSON()) }
    })
    for (const box of metrics.boxes) {
      expect(box.left).toBeGreaterThanOrEqual(metrics.target.left - 1)
      expect(box.right).toBeLessThanOrEqual(metrics.target.right + 1)
      expect(box.bottom).toBeLessThanOrEqual(metrics.target.bottom + 1)
    }
    const point = await readerPoint(page, metrics.target.left + 5, metrics.target.top + metrics.target.height / 2)
    await page.mouse.move(point.x, point.y)
    await expect(translation).toHaveClass(/sentence-highlight/)
    await expect(activeReader(page).locator('.trans-sentence[data-sentence-idx="1"]').first()).not.toHaveClass(/sentence-highlight/)
  })
}
