import { test, expect } from '@playwright/test'
import { activeReader, mockBaseRoutes, gotoApp } from './helpers.js'

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


async function openDocument(page, trigger = 'hover') {
  const doc = { id: 'preview', filename: 'Preview.pdf', total_pages: 2, metadata: { title: 'Preview' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.addInitScript(trigger => localStorage.setItem('easypaper_figure_overlay_trigger_research', trigger), trigger)
  await page.route('**/api/library/preview/pdf', route => route.fulfill({ contentType: 'application/pdf', body: multipagePdf(2,
    () => 'BT /F1 16 Tf 50 600 Td (See Figure 1, Table 1, and Eq. 1.) Tj ET') }))
  await page.route('**/api/pdf-text/**', route => route.fulfill({ json: { recovery: null } }))
  await page.route('**/api/library/preview/images', route => route.fulfill({ json: { images:
    ['Figure 1', 'Table 1', 'Equation 1'].map(label => ({ page: 2, label, left: 10, top: 20, width: 30, height: 20 }))
  } }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=preview' })
  const reader = activeReader(page)
  const markers = reader.locator('.pdf-page-wrapper[data-page="1"] .figure-ref-marker-box')
  await expect(markers).toHaveCount(3)
  return { reader, markers }
}

test('click previews stay open, pin independently, move, collapse and close', async ({ page }) => {
  const { reader, markers } = await openDocument(page, 'click')
  await markers.first().hover()
  await expect(reader.locator('.figure-preview-tooltip:not(.hidden)')).toHaveCount(0)
  for (let i = 0; i < 3; i++) {
    await markers.nth(i).click()
    const preview = reader.locator('.figure-preview-tooltip:not(.pinned):not(.hidden)')
    await expect(preview).toBeVisible()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
    await expect(preview).toBeVisible()
    await preview.locator('.figure-preview-pin').click()
    const pinned = reader.locator('.figure-preview-tooltip.pinned').nth(i)
    await expect(pinned.locator('.figure-preview-tooltip-img')).toBeVisible()
    const drag = pinned.locator('.figure-preview-drag')
    const before = await pinned.boundingBox()
    await drag.focus()
    await drag.press('ArrowRight')
    expect((await pinned.boundingBox()).x).toBeGreaterThan(before.x)
    await pinned.locator('.figure-preview-collapse').click()
    await expect(pinned.locator('.figure-preview-tooltip-items')).toBeHidden()
    // Move each collapsed panel out of the way of the next reference.
    await pinned.evaluate((el, i) => { el.style.left = '8px'; el.style.top = `${8 + i * 55}px` }, i)
  }
  await expect(reader.locator('.figure-preview-tooltip.pinned')).toHaveCount(3)
  const pinned = reader.locator('.figure-preview-tooltip.pinned').first()
  const handle = pinned.locator('.figure-preview-drag')
  const start = await handle.boundingBox()
  await page.mouse.move(start.x + 20, start.y + 12)
  await page.mouse.down()
  await page.mouse.move(start.x + 100, start.y + 62)
  await page.mouse.up()
  expect((await pinned.boundingBox()).x).toBeGreaterThan(50)
  await pinned.locator('.figure-preview-collapse').click()
  await expect(pinned.locator('.figure-preview-tooltip-items')).toBeVisible()
  await reader.locator('#viewer-scroll-container').evaluate(el => el.dispatchEvent(new Event('scroll')))
  await expect(pinned).toBeVisible()
  await pinned.locator('.figure-preview-close').click()
  await expect(reader.locator('.figure-preview-tooltip.pinned')).toHaveCount(2)
  await page.evaluate(() => localStorage.setItem('easypaper_disable_figure_overlay_research', 'true'))
  await expect(reader.locator('.figure-preview-tooltip.pinned')).toHaveCount(0)
  await expect(markers).toHaveCount(0)
})

test('default hover preview dismisses and keyboard activation stays open until Escape', async ({ page }) => {
  const { reader, markers } = await openDocument(page)
  await markers.first().hover()
  const preview = reader.locator('.figure-preview-tooltip:not(.hidden)')
  await expect(preview).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(preview).toHaveCount(0)
  await markers.first().focus()
  await markers.first().press('Enter')
  await expect(preview).toBeVisible()
  await page.waitForTimeout(300)
  await expect(preview).toBeVisible()
  await preview.locator('.figure-preview-close').press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(markers.first()).toBeFocused()
})

test('changing the saved trigger updates an open reader and outside click dismisses', async ({ page }) => {
  const { reader, markers } = await openDocument(page)
  await page.evaluate(() => localStorage.setItem('easypaper_figure_overlay_trigger_research', 'click'))
  await markers.first().hover()
  const preview = reader.locator('.figure-preview-tooltip:not(.hidden)')
  await expect(preview).toHaveCount(0)
  await markers.first().click()
  await expect(preview).toBeVisible()
  await reader.locator('#viewer-scroll-container').dispatchEvent('pointerdown')
  await expect(preview).toHaveCount(0)
  await markers.first().click()
  await expect(preview).toBeVisible()
  await preview.locator('.figure-preview-tooltip-item').click()
  await expect(preview).toHaveCount(0)
  await expect(reader.locator('.pdf-page-wrapper[data-page="2"]')).toBeInViewport()
})
