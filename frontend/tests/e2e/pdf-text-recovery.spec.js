import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

const recovered = [
  { text: '日本語の文章です。', bbox: [72, 100, 240, 116] },
  { text: '한국어 문장입니다.', bbox: [72, 150, 240, 166] },
  { text: '这是中文文本。', bbox: [72, 200, 240, 216] },
  { text: 'Ελληνικό κείμενο', bbox: [72, 250, 240, 266] },
  { text: 'النص العربي', bbox: [72, 300, 240, 316] },
]
const geometryPdf = fs.readFileSync(new URL('./fixtures/text-geometry.pdf', import.meta.url))

async function openRecovered(page, pdf, spans, recovery = 'ocr') {
  const document = { id: 'recovered', filename: 'recovered.pdf', total_pages: 1,
    metadata: { title: 'Recovered text' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [document] })
  await page.route('**/api/library/recovered/pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
  await page.route('**/api/pdf-text/recovered/1', route => route.fulfill({ json: {
    recovery, spans, error: recovery === 'failed' ? 'pdf_ocr_unavailable' : null,
  } }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=recovered' })
  await expect(page.locator(recovery ? '.textLayer[data-recovery]' : '.textLayer span').first()).toBeVisible()
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))))
}

for (const scale of [0.8, 1, 1.25]) {
  test(`OCR boxes preserve each language at UI scale ${scale}`, async ({ page }) => {
    await page.addInitScript(scale => localStorage.setItem('easypaper_ui_scale', scale), String(scale))
    await openRecovered(page, geometryPdf, recovered)
    for (const span of recovered) {
      const locator = page.locator('.textLayer span').filter({ hasText: span.text }).first()
      await expect(locator).toBeVisible()
      const geometry = await locator.evaluate(el => {
        const rect = el.getBoundingClientRect()
        const layer = el.closest('.textLayer').getBoundingClientRect()
        return { x: rect.x - layer.x, y: rect.y - layer.y, width: rect.width, height: rect.height,
          scale: layer.width / 600 }
      })
      for (const [actual, expected] of [[geometry.x, 72], [geometry.y, span.bbox[1]],
        [geometry.width, 168], [geometry.height, 16]]) {
        expect(Math.abs(actual - expected * geometry.scale)).toBeLessThan(1)
      }
    }
  })
}

test('OCR failure preserves the page and explains why text is unavailable', async ({ page }) => {
  await openRecovered(page, SAMPLE_PDF_A, [], 'failed')
  await expect(page.locator('.pdf-text-recovery-notice')).toContainText('Tesseract')
  await expect(page.locator('.pdf-page-inner canvas')).toBeVisible()
  await expect(page.locator('.textLayer span')).toHaveCount(0)
})

test('native CJK text loads local CMaps and fallback fonts without OCR', async ({ page }) => {
  const problems = []
  const assets = []
  page.on('console', message => {
    if (/Unable to load|CMap|standardFontDataUrl|wasmUrl/.test(message.text())) problems.push(message.text())
  })
  page.on('response', response => {
    if (response.url().includes('/assets/pdfjs/')) assets.push([response.url(), response.status()])
  })
  const pdf = fs.readFileSync(new URL('./fixtures/multilingual-native.pdf', import.meta.url))
  await openRecovered(page, pdf, [], null)
  const layer = page.locator('.textLayer')
  for (const text of ['日本語の文章です。', '한국어 문장입니다.', '这是中文文本。', '這是中文文本。']) {
    await expect(layer).toContainText(text)
  }
  expect(problems).toEqual([])
  expect(assets.some(([url]) => url.endsWith('.bcmap'))).toBe(true)
  expect(assets.some(([url]) => /\.(pfb|ttf)$/.test(url))).toBe(true)
  expect(assets.every(([, status]) => status === 200)).toBe(true)
})

test('original Japanese textbook renders recovered selectable text', async ({ page }) => {
  test.skip(!process.env.EASYPAPER_TEST_RECOVERY_FIXTURE, 'User PDF is not redistributed')
  const root = process.env.EASYPAPER_TEST_RECOVERY_FIXTURE
  const spans = JSON.parse(fs.readFileSync(`${root}.json`, 'utf8'))
  await openRecovered(page, fs.readFileSync(`${root}.pdf`), spans)
  await expect(page.locator('.textLayer')).toContainText('基本ソフト')
  await expect(page.locator('.page-render-error')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/easypaper-japanese-recovered.png', fullPage: true })
})
