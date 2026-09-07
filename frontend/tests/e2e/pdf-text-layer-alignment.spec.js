import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

test('전역 자간이 PDF 텍스트 레이어의 위치와 크기에 영향을 주지 않는다', async ({ page }) => {
  const document = {
    id: 'text-layer-alignment',
    filename: 'alignment.pdf',
    total_pages: 1,
    metadata: { title: 'Text layer alignment' },
    translated_pages: [],
  }

  await mockBaseRoutes(page, { documents: [document] })
  await page.route('**/api/library/text-layer-alignment/pdf', route => route.fulfill({
    status: 200,
    contentType: 'application/pdf',
    body: SAMPLE_PDF_A,
  }))

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=text-layer-alignment' })

  const textLayer = page.locator('.pdf-page-wrapper[data-page="1"] .textLayer')
  await expect(textLayer).toBeVisible()
  await expect(textLayer).toHaveAttribute('data-segmented', 'true')
  // Compare settled geometry, not two frames of the viewer entrance transition.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))))

  const readGeometry = () => page.locator('.textLayer span').evaluateAll(spans => spans.map(span => {
    const rect = span.getBoundingClientRect()
    const layerRect = span.closest('.textLayer').getBoundingClientRect()
    return {
      x: rect.x - layerRect.x,
      y: rect.y - layerRect.y,
      width: rect.width,
      height: rect.height,
    }
  }))

  const before = await readGeometry()
  expect(before.length).toBeGreaterThan(0)

  await page.evaluate(() => { document.body.style.letterSpacing = '-0.2em' })
  const after = await readGeometry()

  expect(after).toHaveLength(before.length)
  for (let index = 0; index < before.length; index += 1) {
    expect(Math.abs(after[index].x - before[index].x)).toBeLessThan(0.1)
    expect(Math.abs(after[index].y - before[index].y)).toBeLessThan(0.1)
    expect(Math.abs(after[index].width - before[index].width)).toBeLessThan(0.1)
    expect(Math.abs(after[index].height - before[index].height)).toBeLessThan(0.1)
  }

  await expect(textLayer).toHaveCSS('letter-spacing', 'normal')
  await expect(textLayer).toHaveCSS('word-spacing', '0px')
})
