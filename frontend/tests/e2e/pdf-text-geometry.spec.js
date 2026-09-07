import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mockBaseRoutes, gotoApp } from './helpers.js'

test.setTimeout(60_000)

const pdf = fs.readFileSync(new URL('./fixtures/text-geometry.pdf', import.meta.url))
// PDF points: Times Roman 12pt at (72,100), Times Italic 12pt at (72,150),
// Courier 10pt at (72,200), on a 600 x 800 page. Widths from the PDF font metrics.
const lines = [
  { text: 'The quick brown fox jumps over the lazy dog.', width: 222.3 },
  { text: 'Variable widths: minimum, office, AVATAR and WWW.', width: 266.988 },
  { text: 'Second paragraph stays aligned after zoom changes.', width: 300 },
]

async function openDocument(page, mode, scale) {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') errors.push(m.text()) })
  const document = { id: 'geometry', filename: 'geometry.pdf', document_mode: mode,
    total_pages: 1, metadata: { title: 'Geometry' }, translated_pages: [] }
  await page.route(/^https:\/\//, route => route.fulfill({
    contentType: route.request().url().includes('.js') && !route.request().url().includes('.css') ? 'text/javascript' : 'text/css', body: '',
  }))
  await mockBaseRoutes(page, { documents: [document] })
  await page.route('**/api/library/geometry/pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
  await page.addInitScript(scale => { localStorage.setItem('easypaper_ui_scale', String(scale)) }, scale)
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=geometry' })
  try {
    await expect(page.locator('.textLayer[data-segmented="true"]')).toBeVisible({ timeout: 15_000 })
  } catch (error) {
    console.log('PDF diagnostics', errors, await page.locator('.pdf-page-inner').evaluateAll(els => els.map(el => ({ html: el.innerHTML.slice(0,600), rect: el.getBoundingClientRect().toJSON() }))))
    throw error
  }
}

for (const mode of ['general', 'research']) {
  for (const dpr of [1, 2]) {
    test.describe(`${mode} DPR ${dpr}`, () => {
      test.use({ deviceScaleFactor: dpr, viewport: { width: 1600, height: 1200 } })
      for (const uiScale of [0.8, 0.9, 1, 1.1, 1.25]) {
        test(`PDF glyphs and hover align at UI scale ${uiScale}`, async ({ page }) => {
          await openDocument(page, mode, uiScale)
          for (const line of lines) {
            const span = page.locator('.textLayer span').filter({ hasText: line.text }).first()
            const metrics = await span.evaluate(el => {
              const canvas = el.closest('.pdf-page-inner').querySelector('canvas').getBoundingClientRect()
              const rect = el.getBoundingClientRect()
              return { width: rect.width, expectedScale: canvas.width / 600, x: rect.left - canvas.left }
            })
            expect(Math.abs(metrics.width - line.width * metrics.expectedScale)).toBeLessThan(1)
            expect(Math.abs(metrics.x - 72 * metrics.expectedScale)).toBeLessThan(1)
            const bounds = await span.boundingBox()
            await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2)
            const boxes = page.locator('.sentence-hover-box')
            await expect(boxes.first()).toBeVisible()
            const error = await span.evaluate(el => {
              const range = document.createRange(); range.selectNodeContents(el)
              const target = range.getBoundingClientRect()
              const boxes = [...el.closest('.pdf-page-inner').querySelectorAll('.sentence-hover-box')]
              return Math.min(...boxes.map(box => {
                const r = box.getBoundingClientRect()
                return Math.max(Math.abs(r.left - target.left), Math.abs(r.top - target.top), Math.abs(r.right - target.right), Math.abs(r.bottom - target.bottom))
              }))
            })
            expect(error).toBeLessThan(1)
          }
        })
      }
    })
  }
}

async function expectGeometryRefresh(page, action) {
  await page.evaluate(() => {
    window.geometryRefreshDone = new Promise(resolve => {
      const original = window.onTextLayerRendered
      window.onTextLayerRendered = (...args) => {
        original(...args)
        window.onTextLayerRendered = original
        resolve()
      }
    })
  })
  await action()
  await page.evaluate(() => window.geometryRefreshDone)
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))))
}

test.describe('selection lifecycle', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1600, height: 1200 } })
  test('native drag, saved annotation and selection survive UI scale and resize', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('easypaper_annotations_geometry', JSON.stringify({ page_1: [
        { id: 'saved', type: 'highlight', startOffset: 4, endOffset: 19, text: 'quick brown fox', color: '#eab308' },
      ] }))
    })
    await openDocument(page, 'research', 1)
    const span = page.locator('.textLayer span').filter({ hasText: lines[0].text }).first()
    const annotation = page.locator('.pdf-annotation-highlight')
    await expect(annotation).toHaveCount(1)
    for (const scale of [1, 0.8, 1.25]) {
      await expectGeometryRefresh(page, () => page.locator('#setting-ui-scale').evaluate((select, value) => {
        select.value = String(value); select.dispatchEvent(new Event('change'))
      }, scale))
      // The refresh is debounced; annotation geometry is the observable completion.
      await expect.poll(async () => span.evaluate(el => {
        const r = document.createRange(); r.setStart(el.firstChild, 4); r.setEnd(el.firstChild, 19)
        const expected = r.getBoundingClientRect()
        const box = el.closest('.pdf-page-inner').querySelector('.pdf-annotation-highlight').getBoundingClientRect()
        return Math.max(Math.abs(box.left - expected.left), Math.abs(box.right - expected.right))
      })).toBeLessThan(1)
      for (const reverse of [false, true]) {
        await page.evaluate(() => window.getSelection().removeAllRanges())
        const r = await span.evaluate(el => {
          const range = document.createRange(); range.setStart(el.firstChild, 4); range.setEnd(el.firstChild, 5)
          const first = range.getBoundingClientRect()
          range.setStart(el.firstChild, 18); range.setEnd(el.firstChild, 19)
          const last = range.getBoundingClientRect()
          // Use the interior of the endpoint glyphs: native input may round
          // fractional screen coordinates differently from DOM Range edges.
          return { left: first.left + first.width * 0.25, right: last.left + last.width * 0.75, y: first.top + first.height / 2 }
        })
        await page.mouse.move(reverse ? r.right : r.left, r.y)
        await page.mouse.down()
        await page.mouse.move(reverse ? r.left : r.right, r.y, { steps: 8 })
        await page.mouse.up()
        await expect.poll(() => page.evaluate(() => window.getSelection().toString()), { message: `Native selection at UI scale ${scale}` }).toBe('quick brown fox')
      }
      await expectGeometryRefresh(page, () => page.setViewportSize({ width: 1550 + Math.round(scale * 10), height: 1200 }))
      await expect.poll(() => page.evaluate(() => window.getSelection().toString()), { message: `Native selection at UI scale ${scale}` }).toBe('quick brown fox')
    }
    // PDF zoom replaces the layer; offsets must still restore the same annotation.
    await page.evaluate(() => window.getSelection().removeAllRanges())
    for (const zoom of ['1.0', '1.5', '2.0']) {
      await page.locator('#setting-default-zoom').evaluate((select, value) => {
        select.value = value; select.dispatchEvent(new Event('change'))
      }, zoom)
      await expect.poll(() => page.locator('.textLayer[data-segmented="true"]').evaluateAll(layers =>
        layers.map(layer => Number(layer.style.getPropertyValue('--scale-factor')))), { timeout: 15_000 }).toEqual([Number(zoom)])
      await expect(annotation).toHaveCount(1)
      await expect(annotation).toHaveAttribute('data-annotation-text', 'quick brown fox')
      const metrics = await span.evaluate(el => {
        const canvas = el.closest('.pdf-page-inner').querySelector('canvas').getBoundingClientRect()
        return { actual: el.getBoundingClientRect().width, scale: canvas.width / 600 }
      })
      expect(Math.abs(metrics.actual - lines[0].width * metrics.scale)).toBeLessThan(1)
    }
  })

  test('rotated CropBox and UserUnit keep native text over the PDF canvas', async ({ page }) => {
    await openDocument(page, 'general', 0.8)
    const rotated = fs.readFileSync(new URL('./fixtures/text-geometry-rotated.pdf', import.meta.url))
    await page.route('**/api/library/geometry/pdf', route => route.fulfill({ contentType: 'application/pdf', body: rotated }))
    await page.reload()
    await expect(page.locator('.textLayer[data-segmented="true"]')).toBeVisible({ timeout: 15_000 })
    const span = page.locator('.textLayer span').filter({ hasText: lines[0].text }).first()
    const metrics = await span.evaluate(el => {
      const canvas = el.closest('.pdf-page-inner').querySelector('canvas').getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return { length: r.height, top: r.top - canvas.top, scale: canvas.height / 570 }
    })
    expect(Math.abs(metrics.length - lines[0].width * metrics.scale)).toBeLessThan(1)
    expect(Math.abs(metrics.top - 62 * metrics.scale)).toBeLessThan(1)
    await page.mouse.move(...await span.evaluate(el => {
      const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + 8]
    }))
    await expect(page.locator('.sentence-hover-box').first()).toBeVisible()
  })
})
