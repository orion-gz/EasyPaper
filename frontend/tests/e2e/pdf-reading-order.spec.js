import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mockBaseRoutes, gotoApp } from './helpers.js'

for (const rotation of [0, 90]) {
  for (const unresolved of [false, true]) {
    for (const focus of unresolved ? [false] : [false, true]) {
    test(`source provenance selects repeated phrases, rotation ${rotation}, unresolved ${unresolved}, focus ${focus}`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1200 })
      const fixture = JSON.parse(fs.readFileSync(new URL(`./fixtures/reading-order-${rotation}.json`, import.meta.url)))
      const pdf = fs.readFileSync(new URL(`./fixtures/reading-order-${rotation}.pdf`, import.meta.url))
      if (unresolved) fixture.sentences[1].source_mapping = { status: 'unresolved', segments: [] }
      await mockBaseRoutes(page, { documents: [{ id: 'order', filename: 'order.pdf', total_pages: 1,
        metadata: { title: 'Reading order' }, translated_pages: [1] }] })
      await page.route('**/api/library/order/pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
      await page.route('**/api/library/order/translation/1**', route => route.fulfill({ json: {
        translation: fixture.sentences.map(s => s.trans).join('\n\n'), sentences: fixture.sentences,
      } }))
      await page.route('**/api/pdf-text/order/1', route => route.fulfill({ json: {
        layout: { ...fixture.layout, needs_review: unresolved }, spans: [],
      } }))
      await gotoApp(page)
      await page.evaluate(focus => {
        localStorage.setItem('easypaper_focus_mode_enabled_research', String(focus))
        localStorage.setItem('easypaper_focus_scale_research', '100')
        location.hash = '#viewer?id=order'
      }, focus)
      await expect(page.locator('.textLayer[data-segmented="true"]')).toBeVisible()
      await expect(page.locator('.trans-sentence').first()).toBeVisible()
      for (let i = 0; i < 2; i++) {
        await page.locator(`.trans-sentence[data-sentence-idx="${i}"]`).first().hover()
        if (unresolved && i === 1) {
          await expect(page.locator('.sentence-hover-box')).toHaveCount(0)
          await expect(page.locator('.pdf-text-recovery-notice')).toHaveText('읽기 순서 확인 필요')
          continue
        }
        await expect(page.locator('.sentence-hover-box')).toHaveCount(1)
        const box = await page.locator('.sentence-hover-box').boundingBox()
        const canvas = await page.locator('.pdf-page-inner canvas').first().boundingBox()
        const scale = canvas.width / (rotation ? 800 : 600)
        const x = i ? 340 : 40, y = i ? 180 : 80
        // Native glyph boxes begin slightly above the insertion baseline.
        const expectedX = rotation ? 800 - y - 4 : x
        const expectedY = rotation ? x : y - 13
        expect(Math.abs(box.x - canvas.x - expectedX * scale)).toBeLessThan(3)
        expect(Math.abs(box.y - canvas.y - expectedY * scale)).toBeLessThan(3)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await expect(page.locator(`.trans-sentence[data-sentence-idx="${i}"]`).first()).toHaveClass(/sentence-highlight/)
        if (focus) await expect(page.locator('.focus-mode-layer')).toBeVisible()
      }
    })
  }
}
}
