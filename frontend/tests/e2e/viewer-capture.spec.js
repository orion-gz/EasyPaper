import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '@playwright/test'
import { activeReader, evaluateReader, readerPoint, mockBaseRoutes, gotoApp } from './helpers.js'

test.use({ deviceScaleFactor: 2 })
test.setTimeout(60000)

function multipagePdf(count, contentForPage) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (let i = 0; i < count; i++) {
    const content = contentForPage?.(i + 1) ?? `BT /F1 18 Tf 50 700 Td (Performance page ${i + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}


async function openPDF(page) {
  const doc = { id: 'capture', filename: 'Capture.pdf', total_pages: 12, metadata: { title: 'Capture PDF' }, translated_pages: [1] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/capture/pdf', route => route.fulfill({ contentType: 'application/pdf', body: multipagePdf(12) }))
  await page.route('**/api/library/capture/translation/1**', route => route.fulfill({ json: { translation: 'Cached page one.', sentences: [] } }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=capture' })
  await expect(activeReader(page).locator('.pdf-page-wrapper[data-page="1"] .textLayer')).toContainText('Performance page 1', { timeout: 20000 })
  await expect(activeReader(page).locator('#pin-capture-btn')).toBeVisible()
}

async function selectArea(page, button = '#pin-capture-btn', size = 100) {
  await activeReader(page).locator(button).click()
  const rect = await activeReader(page).locator('.pdf-page-wrapper[data-page="1"] canvas[data-rendered]').evaluate(el => {
    const r = el.getBoundingClientRect()
    return { x: r.left + 20, y: r.top + 40 }
  })
  const start = await readerPoint(page, rect.x, rect.y)
  const end = await readerPoint(page, rect.x + size, rect.y + size)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 5 })
  await page.mouse.up()
}

test('capture survives page eviction and supports panel controls', async ({ page }) => {
  await openPDF(page)
  await selectArea(page)
  const panel = activeReader(page).locator('.capture-overlay')
  await expect(panel).toBeVisible()
  await expect.poll(() => panel.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
  const image = await panel.locator('img').getAttribute('src')
  const expectedWidth = await activeReader(page).locator('.pdf-page-wrapper[data-page="1"] canvas[data-rendered]').evaluate(el => Math.round(100 / el.getBoundingClientRect().width * 1530))
  expect(Math.abs(await panel.locator('img').evaluate(img => img.naturalWidth) - expectedWidth)).toBeLessThanOrEqual(2)
  const bounds = await panel.boundingBox()
  await panel.locator('.capture-overlay-resize').hover()
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 43, bounds.y + bounds.height - 33, { steps: 5 })
  await page.mouse.up()
  expect((await panel.boundingBox()).width).toBeLessThan(bounds.width)
  await panel.locator('.capture-overlay-resize').focus()
  const resizedWidth = (await panel.boundingBox()).width
  await page.keyboard.press('ArrowRight')
  expect((await panel.boundingBox()).width).toBeGreaterThan(resizedWidth)

  await activeReader(page).locator('.pdf-page-wrapper[data-page="10"]').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await expect(activeReader(page).locator('.pdf-page-wrapper[data-page="10"] .textLayer')).toContainText('Performance page 10')
  await expect(panel).toBeVisible()
  await expect(panel.locator('img')).toHaveAttribute('src', image)
  const drag = panel.locator('.capture-overlay-drag')
  const before = await panel.evaluate(el => parseFloat(el.style.left))
  await drag.focus()
  await page.keyboard.press('ArrowLeft')
  expect(await panel.evaluate(el => parseFloat(el.style.left))).toBeLessThan(before)
  await panel.locator('[aria-expanded]').click()
  await expect(panel.locator('.capture-overlay-content')).toBeHidden()
  await panel.locator('[aria-expanded]').click()
  await expect(panel.locator('img')).toBeVisible()
  await panel.locator('.capture-overlay-header button').nth(1).click()
  await expect(activeReader(page).locator('.pdf-page-wrapper[data-page="1"] .textLayer')).toBeVisible()
  await panel.locator('.capture-overlay-header button').last().click()
  await expect(panel).toHaveCount(0)
})

test('cancel and tiny selection create no image; AI capture still quotes an image', async ({ page }) => {
  await openPDF(page)
  const button = activeReader(page).locator('#pin-capture-btn')
  await button.click()
  await page.keyboard.press('Escape')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await selectArea(page, '#pin-capture-btn', 3)
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await selectArea(page, '#capture-area-btn')
  await expect(activeReader(page).locator('#chat-quote-img')).toBeVisible()
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(0)
})

test('limits captures and keeps image dimensions independent of display zoom', async ({ page }) => {
  await openPDF(page)
  await selectArea(page)
  const panels = activeReader(page).locator('.capture-overlay')
  await expect(panels).toHaveCount(1)
  for (let i = 2; i <= 5; i++) {
    await selectArea(page)
    await expect(panels).toHaveCount(i)
  }
  await activeReader(page).locator('#pin-capture-btn').click()
  await expect(activeReader(page).locator('#pin-capture-btn')).toHaveAttribute('aria-pressed', 'false')
  await expect(panels).toHaveCount(5)
  const dimensions = await panels.first().locator('img').evaluate(img => [img.naturalWidth, img.naturalHeight])
  await activeReader(page).locator('#zoom-in-btn').click()
  expect(await panels.first().locator('img').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual(dimensions)
  await page.reload()
  await expect(activeReader(page).locator('#pin-capture-btn')).toBeVisible({ timeout: 20000 })
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(0)
})

test('failed image encoding releases capture mode and allows retry', async ({ page }) => {
  await openPDF(page)
  await evaluateReader(page, () => {
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      HTMLCanvasElement.prototype.toBlob = original
      callback(null)
    }
  })
  await selectArea(page)
  await expect(activeReader(page).locator('#pin-capture-btn')).toHaveAttribute('aria-pressed', 'false')
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(0)
  await selectArea(page)
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(1)
})

test('document switches clear captures and discard pending images', async ({ page }) => {
  await openPDF(page)
  const replacement = { id: 'capture-next', filename: 'Next.pdf', total_pages: 2, metadata: { title: 'Next PDF' }, translated_pages: [] }
  await page.route('**/api/library/capture-next', route => route.fulfill({ json: replacement }))
  await page.route('**/api/library/capture-next/pdf', route => route.fulfill({ contentType: 'application/pdf', body: multipagePdf(2, () => 'BT /F1 18 Tf 50 700 Td (Next document) Tj ET') }))
  await selectArea(page)
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(1)
  await evaluateReader(page, () => {
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      HTMLCanvasElement.prototype.toBlob = original
      original.call(this, blob => { window.finishCapture = () => callback(blob) }, ...args)
    }
  })
  await selectArea(page)
  await expect.poll(() => evaluateReader(page, () => typeof window.finishCapture)).toBe('function')
  const oldFrame = await (await page.locator('.workspace-document-frame:not([hidden])').elementHandle()).contentFrame()
  await evaluateReader(page, () => { location.hash = '#viewer?id=capture-next' })
  await expect(activeReader(page).locator('.pdf-page-wrapper[data-page="1"] .textLayer')).toContainText('Next document')
  await expect(oldFrame.locator('.capture-overlay')).toHaveCount(0)
  await expect(oldFrame.locator('#pin-capture-btn')).toHaveAttribute('aria-busy', 'false')
  await oldFrame.evaluate(async () => {
    window.finishCapture()
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(0)
  await expect(oldFrame.locator('.capture-overlay')).toHaveCount(0)
})

for (const scale of [0.8, 1.25]) test(`capture bounds and pointer deltas respect UI scale ${scale}`, async ({ page }) => {
  await page.addInitScript(scale => localStorage.setItem('easypaper_ui_scale', String(scale)), scale)
  await openPDF(page)
  await selectArea(page)
  const panel = activeReader(page).locator('.capture-overlay')
  await expect(panel).toBeVisible()
  const inBounds = () => panel.evaluate(el => {
    const r = el.getBoundingClientRect()
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
  })
  await expect.poll(inBounds).toBe(true)
  await panel.evaluate(el => { el.style.left = '80px'; el.style.top = '80px' })
  const drag = await panel.locator('.capture-overlay-drag').boundingBox()
  const before = await panel.boundingBox()
  await page.mouse.move(drag.x + 20, drag.y + 15)
  await page.mouse.down()
  await page.mouse.move(drag.x + 120, drag.y + 15, { steps: 5 })
  await page.mouse.up()
  expect(Math.abs((await panel.boundingBox()).x - before.x - 100)).toBeLessThan(2)
  const resize = await panel.locator('.capture-overlay-resize').boundingBox()
  const width = (await panel.boundingBox()).width
  await page.mouse.move(resize.x + 10, resize.y + 10)
  await page.mouse.down()
  await page.mouse.move(resize.x + 60, resize.y + 10, { steps: 5 })
  await page.mouse.up()
  expect(Math.abs((await panel.boundingBox()).width - width - 50)).toBeLessThan(2)
  const nextScale = scale === 0.8 ? 1.25 : 0.8
  await page.evaluate(scale => {
    const setting = document.getElementById('setting-ui-scale')
    setting.value = String(scale)
    setting.dispatchEvent(new Event('change', { bubbles: true }))
  }, nextScale)
  await expect.poll(() => evaluateReader(page, () => Number(document.documentElement.style.zoom))).toBe(nextScale)
  await expect.poll(inBounds).toBe(true)
  await page.setViewportSize({ width: 650, height: 500 })
  await expect.poll(inBounds).toBe(true)
})

for (const light of [false, true]) test(`capture controls and scrolling are accessible in ${light ? 'light' : 'dark'} theme`, async ({ page }, testInfo) => {
  await openPDF(page)
  await selectArea(page)
  const panel = activeReader(page).locator('.capture-overlay')
  await expect(panel).toBeVisible()
  if (await activeReader(page).locator('body').evaluate(el => el.classList.contains('light-theme')) !== light) {
    await page.locator('#sidebar-theme-toggle-btn').click()
  }
  await expect.poll(() => activeReader(page).locator('body').evaluate(el => el.classList.contains('light-theme'))).toBe(light)
  const results = await new AxeBuilder({ page })
    .include(['.workspace-document-frame:not([hidden])', '.capture-overlay'])
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(results.violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('capture-theme.png') })
  const content = panel.locator('.capture-overlay-content')
  await content.focus()
  await expect(content).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => content.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  // The panel uses a defined theme token, not a hardcoded dark fallback.
  expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await panel.evaluate(el => {
    const probe = document.createElement('div'); probe.style.background = 'var(--bg-panel)'; el.append(probe)
    const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color
  }))
})

test('bottom toolbar supports keyboard-only selection, resizing and cancellation', async ({ page }) => {
  await openPDF(page)
  const button = activeReader(page).locator('#floating-scroll-nav #pin-capture-btn')
  await button.focus()
  await page.keyboard.press('Enter')
  const selection = activeReader(page).locator('.pdf-crop-overlay')
  await expect(selection).toBeFocused()
  const original = await selection.evaluate(el => ({ left: parseFloat(el.style.left), width: parseFloat(el.style.width) }))
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  expect(await selection.evaluate(el => parseFloat(el.style.left))).toBeGreaterThan(original.left)
  expect(await selection.evaluate(el => parseFloat(el.style.width))).toBeGreaterThan(original.width)
  await page.keyboard.press('Enter')
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(1)
  await expect(selection).toHaveCount(0)
  await button.focus()
  await page.keyboard.press('Space')
  await expect(selection).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(selection).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
})

test('capture exposes busy state and raises the selected panel', async ({ page }) => {
  await openPDF(page)
  await evaluateReader(page, () => {
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      HTMLCanvasElement.prototype.toBlob = original
      original.call(this, blob => { window.finishCapture = () => callback(blob) }, ...args)
    }
  })
  await selectArea(page)
  await expect.poll(() => evaluateReader(page, () => typeof window.finishCapture)).toBe('function')
  const button = activeReader(page).locator('#pin-capture-btn')
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute('aria-busy', 'true')
  await expect(activeReader(page).locator('#capture-status')).not.toBeEmpty()
  await evaluateReader(page, () => window.finishCapture())
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('aria-busy', 'false')
  await expect(activeReader(page).locator('.capture-overlay')).toHaveCount(1)
  await selectArea(page)
  const panels = activeReader(page).locator('.capture-overlay')
  await expect(panels).toHaveCount(2)
  await panels.first().locator('.capture-overlay-drag').focus()
  expect(await panels.first().evaluate(el => Number(getComputedStyle(el).zIndex)))
    .toBeGreaterThan(await panels.last().evaluate(el => Number(getComputedStyle(el).zIndex)))
  await panels.last().locator('.capture-overlay-drag').focus()
  expect(await panels.last().evaluate(el => Number(getComputedStyle(el).zIndex)))
    .toBeGreaterThan(await panels.first().evaluate(el => Number(getComputedStyle(el).zIndex)))
})
