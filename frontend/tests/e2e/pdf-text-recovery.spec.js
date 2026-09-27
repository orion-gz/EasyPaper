import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { activeReader, evaluateReader, readerPoint, mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

const recovered = [
  { text: '日本語の文章です。', bbox: [72, 100, 240, 116] },
  { text: '한국어 문장입니다.', bbox: [72, 150, 240, 166] },
  { text: '这是中文文本。', bbox: [72, 200, 240, 216] },
  { text: 'Ελληνικό κείμενο', bbox: [72, 250, 240, 266] },
  { text: 'النص العربي', bbox: [72, 300, 240, 316] },
]
const geometryPdf = fs.readFileSync(new URL('./fixtures/text-geometry.pdf', import.meta.url))

async function openRecovered(page, pdf, spans, recovery = 'ocr', sources = [], translations = []) {
  const document = { id: 'recovered', filename: 'recovered.pdf', total_pages: 1,
    metadata: { title: 'Recovered text' }, translated_pages: sources.length ? [1] : [] }
  await mockBaseRoutes(page, { documents: [document] })
  if (sources.length) {
    const sentences = sources.map((src, i) => ({ src, trans: translations[i] || `번역문 ${i + 1}입니다.` }))
    await page.route('**/api/library/recovered/translation/1**', route => route.fulfill({ json: {
      translation: sentences.map(s => s.trans).join('\n\n'), sentences,
    } }))
  }
  await page.route('**/api/library/recovered/pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
  await page.route('**/api/pdf-text/recovered/1', route => route.fulfill({ json: {
    recovery, spans, error: recovery === 'failed' ? 'pdf_ocr_unavailable' : null,
  } }))
  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=recovered' })
  if (sources.length) await activeReader(page).locator('#workspace-reading-mode').selectOption('parallel')
  await expect(activeReader(page).locator(recovery ? '.textLayer[data-recovery]' : '.textLayer span').first()).toBeVisible()
  await evaluateReader(page, () => Promise.all(document.getAnimations()
    .filter(animation => animation.effect.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))))
}

for (const scale of [0.8, 1.25]) {
  test(`glyph-sized OCR mapping and continuous selection at scale ${scale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1200 })
    await page.addInitScript(scale => localStorage.setItem('easypaper_ui_scale', scale), String(scale))
    const sources = ['日本語の文章です。', 'ひらがなだけです。', 'Linux / UNIX を説明します。', 'النص العربي.']
    const spans = sources.flatMap((text, line) => [...text].map((text, col) => ({
      text, bbox: [72 + col * 16, 100 + line * 40 + col % 3 * 2, 84 + col * 16, 116 + line * 40],
      hasEOL: col === [...sources[line]].length - 1,
    })))
    await openRecovered(page, geometryPdf, spans, 'ocr', sources)
    await expect(activeReader(page).locator('.trans-sentence').first()).toBeVisible()
    for (let i = 0; i < sources.length; i++) {
      await activeReader(page).locator(`.trans-sentence[data-sentence-idx="${i}"]`).first().hover()
      await expect(activeReader(page).locator('.sentence-hover-box')).toHaveCount(1)
      const box = await activeReader(page).locator('.sentence-hover-box').boundingBox()
      const layerBounds = await activeReader(page).locator('.textLayer').boundingBox()
      const metrics = { left: layerBounds.x, scale: layerBounds.width / 600 }
      expect(Math.abs(box.x - metrics.left - 72 * metrics.scale)).toBeLessThan(1)
      expect(Math.abs(box.width - (16 * ([...sources[i]].length - 1) + 12) * metrics.scale)).toBeLessThan(2)
    }
    const glyphs = activeReader(page).locator('.textLayer span')
    await glyphs.first().scrollIntoViewIfNeeded()
    await glyphs.first().hover()
    await expect(activeReader(page).locator('.sentence-hover-box')).toHaveCount(1)
    await expect(activeReader(page).locator('.trans-sentence[data-sentence-idx="0"]').first()).toHaveClass(/sentence-highlight/)
    const first = await glyphs.nth(0).boundingBox(), last = await glyphs.nth(sources[0].length - 1).boundingBox()
    await page.mouse.move(first.x + 1, first.y + first.height / 2)
    await page.mouse.down()
    await page.mouse.move(last.x + last.width - 1, last.y + last.height / 2, { steps: 12 })
    await expect(activeReader(page).locator('.sentence-selection-box')).toHaveCount(1)
    await page.mouse.up()
    await expect(activeReader(page).locator('.sentence-selection-box')).toHaveCount(1)
    expect(await evaluateReader(page, () => getSelection().toString().replace(/\s/g, ''))).toBe(sources[0])
    await evaluateReader(page, () => getSelection().removeAllRanges())
    await expect(activeReader(page).locator('.sentence-selection-box')).toHaveCount(0)
    await expect(activeReader(page).locator('.pdf-box-selection')).toHaveCount(0)
  })
}

async function enableFocus(page, uiScale, focusScale) {
  // Leave the same document area available after adding the persistent sidebar.
  await page.setViewportSize({ width: 2000, height: 1200 })
  await page.addInitScript(({ uiScale, focusScale }) => {
    localStorage.setItem('easypaper_ui_scale', String(uiScale))
    localStorage.setItem('easypaper_focus_mode_enabled_research', 'true')
    localStorage.setItem('easypaper_focus_scale_research', String(focusScale))
    localStorage.setItem('easypaper_disable_hover_tooltip', 'true')
  }, { uiScale, focusScale })
}

for (const uiScale of [0.8, 1.25]) {
  for (const focusScale of [100, 125]) {
    test(`Focus keeps OCR lines continuous at UI ${uiScale}, magnification ${focusScale}`, async ({ page }) => {
      await enableFocus(page, uiScale, focusScale)
      const lines = ['日本語の文章です。', 'ひらがなもつながります。', '次の文は別です。']
      const spans = lines.flatMap((line, row) => [...line].map((text, col) => ({
        // Tight line spacing makes OCR font rectangles overlap vertically.
        text, bbox: [72 + col * 16, 100 + row * 15 + col % 3 * 2, 84 + col * 16, 116 + row * 15],
        hasEOL: col === [...line].length - 1,
      })))
      await openRecovered(page, geometryPdf, spans, 'ocr', [lines.slice(0, 2).join(' '), lines[2]])
      const translated = activeReader(page).locator('.trans-sentence[data-sentence-idx="0"]').first()
      await translated.hover()
      // Two source lines and one translated line, with no glyph-sized holes.
      await expect(activeReader(page).locator('.focus-tint-hole')).toHaveCount(3)
      if (focusScale > 100) {
        const source = activeReader(page).locator('.focus-mode-magnification[data-kind="source"]')
        await expect(source.locator('canvas')).toHaveCount(2)
        const sizes = await source.evaluate(el => el.focusRects.map(r => r.width))
        expect(Math.min(...sizes)).toBeGreaterThan(100)
      }
      // Pin and resize also use continuous line geometry.
      await translated.click()
      await page.setViewportSize({ width: 1900, height: 1100 })
      await expect(activeReader(page).locator('.focus-tint-hole')).toHaveCount(3)
      // Keep a pending resize/scroll mouse event from immediately focusing text again.
      await activeReader(page).locator('#viewer-topbar').hover()
      await page.keyboard.press('Escape')
      await expect(activeReader(page).locator('.focus-mode-layer')).toHaveCount(0)
    })
  }
}

for (const matched of [true, false]) {
  test(`cached Japanese paragraphs focus individual sentences (matched translation: ${matched})`, async ({ page }) => {
    await enableFocus(page, 1, 125)
    const lines = ['最初の文です。', '次の文です。', '最後の文です。']
    const translations = matched ? ['첫 번째입니다. 두 번째입니다. 마지막입니다.'] : ['문단을 합쳐 번역한 결과입니다.']
    await openRecovered(page, geometryPdf, lines.map((text, row) => ({
      text, bbox: [72, 100 + row * 35, 240, 116 + row * 35], hasEOL: true,
    })), 'ocr', [lines.join('')], translations)
    // One cached mapping ID remains, even while Focus subdivides it.
    await expect(activeReader(page).locator('.trans-sentence').first()).toBeVisible()
    expect(await activeReader(page).locator('.trans-sentence').evaluateAll(els => [...new Set(els.map(e => e.dataset.sentenceIdx))])).toEqual(['0'])
    const source = activeReader(page).locator('.focus-mode-magnification[data-kind="source"]')
    for (const line of lines) {
      const glyph = activeReader(page).locator('.textLayer span').filter({ hasText: line }).first()
      await glyph.hover()
      await expect(source.locator('canvas')).toHaveCount(1)
      await expect.poll(async () => {
        const target = await glyph.boundingBox(), focused = await source.boundingBox()
        if (!target || !focused) return Infinity
        return Math.abs(focused.y + focused.height / 2 - target.y - target.height / 2)
      }).toBeLessThan(8)
    }
    if (matched) {
      const target = await activeReader(page).locator('.trans-sentence').first().evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = node.nodeValue.indexOf('두 번째')
          if (start < 0) continue
          const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 2)
          const r = range.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }
      })
      const point = await readerPoint(page, target.x, target.y)
      await page.mouse.move(point.x, point.y)
      await expect(source.locator('canvas')).toHaveCount(1)
      const middle = await activeReader(page).locator('.textLayer span').filter({ hasText: lines[1] }).first().boundingBox()
      await expect.poll(async () => Math.abs(((await source.boundingBox())?.y ?? Infinity) - middle.y)).toBeLessThan(8)
    }
    await activeReader(page).locator('.textLayer span').filter({ hasText: lines[1] }).first().click()
    await expect(source.locator('canvas')).toHaveCount(1)
    await page.keyboard.press('ArrowRight')
    await expect(source.locator('canvas')).toHaveCount(1)
    const last = await activeReader(page).locator('.textLayer span').filter({ hasText: lines[2] }).first().boundingBox()
    await expect.poll(async () => Math.abs(((await source.boundingBox())?.y ?? Infinity) - last.y)).toBeLessThan(8)
    await page.keyboard.press('Escape')
    await expect(activeReader(page).locator('.focus-mode-layer')).toHaveCount(0)
  })
}

test('cached textbook paragraph focuses its first sentence without retranslating', async ({ page }) => {
  test.skip(!process.env.EASYPAPER_TEST_MAPPING_FIXTURE, 'User PDF is not redistributed')
  const root = process.env.EASYPAPER_TEST_MAPPING_FIXTURE
  const data = JSON.parse(fs.readFileSync(`${root}.json`, 'utf8'))
  await enableFocus(page, 1, 125)
  await openRecovered(page, fs.readFileSync(`${root}.pdf`), data.text_layer, 'ocr', data.text.split(/\n\s*\n/).filter(Boolean))
  await activeReader(page).locator('.textLayer span').filter({ hasText: /^1960$/ }).first().hover()
  const crops = activeReader(page).locator('.focus-mode-magnification[data-kind="source"] canvas')
  await expect(crops.first()).toBeVisible()
  expect(await crops.count()).toBeLessThanOrEqual(2)
  await page.screenshot({ path: '/tmp/easypaper-cjk-sentence-focus.png', fullPage: true })
})

test('Focus enlarges the original Japanese textbook paragraph as two complete lines', async ({ page }) => {
  test.skip(!process.env.EASYPAPER_TEST_MAPPING_FIXTURE, 'User PDF is not redistributed')
  const root = process.env.EASYPAPER_TEST_MAPPING_FIXTURE
  const data = JSON.parse(fs.readFileSync(`${root}.json`, 'utf8'))
  await enableFocus(page, 1, 125)
  await openRecovered(page, fs.readFileSync(`${root}.pdf`), data.text_layer, 'ocr', data.text.split(/\n\s*\n/).filter(Boolean))
  await activeReader(page).locator('.trans-sentence[data-sentence-idx="2"]').first().hover()
  await expect(activeReader(page).locator('.focus-mode-magnification[data-kind="source"] canvas')).toHaveCount(2)
  await expect(activeReader(page).locator('.focus-tint-hole')).toHaveCount(3)
  await page.screenshot({ path: '/tmp/easypaper-japanese-focus-unified.png', fullPage: true })
})

test('translation hover and click include source fragments on both sides of an equation', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  const lines = ['We begin here.', 'x = y + 1', 'Then we finish here.']
  await openRecovered(page, geometryPdf, lines.map((text, i) => ({
    text, bbox: [72, 100 + i * 30, 260, 116 + i * 30], hasEOL: true,
  })), 'ocr', [lines.join(' ')])
  const translated = activeReader(page).locator('.trans-sentence').first()
  await translated.hover()
  await expect(activeReader(page).locator('.sentence-hover-box')).toHaveCount(3)
  await translated.click()
  await expect(activeReader(page).locator('.sentence-active-box')).toHaveCount(3)
})

test('original Japanese textbook paragraphs map to all recovered glyphs', async ({ page }) => {
  test.skip(!process.env.EASYPAPER_TEST_MAPPING_FIXTURE, 'User PDF is not redistributed')
  const root = process.env.EASYPAPER_TEST_MAPPING_FIXTURE
  const data = JSON.parse(fs.readFileSync(`${root}.json`, 'utf8'))
  const sources = data.text.split(/\n\s*\n/).filter(Boolean)
  const warnings = []
  page.on('console', m => { if (m.text().includes('Failed to match sentence')) warnings.push(m.text()) })
  await openRecovered(page, fs.readFileSync(`${root}.pdf`), data.text_layer, 'ocr', sources)
  await expect(activeReader(page).locator('.trans-sentence').first()).toBeVisible()
  expect(warnings).toEqual([])
  // Verify every paragraph, not just the first fragment returned by .find().
  let searchStart = 0
  for (let i = 0; i < sources.length; i++) {
    await activeReader(page).locator(`.trans-sentence[data-sentence-idx="${i}"]`).first().hover()
    const result = await activeReader(page).locator('.textLayer').evaluate((layer, { source, searchStart }) => {
      const clean = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '')
      let full = ''
      const spans = [...layer.querySelectorAll('span')].map(el => {
        const start = full.length; full += clean(el.textContent)
        return { el, start, end: full.length }
      })
      const start = full.indexOf(clean(source), searchStart), end = start + clean(source).length
      const boxes = [...document.querySelectorAll('.sentence-hover-box')].map(el => el.getBoundingClientRect())
      const missing = spans.filter(s => s.end > start && s.start < end && s.start !== s.end).filter(({ el }) => {
        const range = document.createRange(); range.selectNodeContents(el)
        const r = range.getBoundingClientRect()
        return !boxes.some(b => b.left <= r.left + 1 && b.right >= r.right - 1 && b.top <= r.top + 1 && b.bottom >= r.bottom - 1)
      }).map(s => s.el.textContent)
      return { start, end, missing }
    }, { source: sources[i], searchStart })
    expect(result.start).toBeGreaterThanOrEqual(searchStart)
    expect(result.missing, `paragraph ${i}`).toEqual([])
    searchStart = result.end
  }
  // Paragraph 3 ends in kana: the old matcher clipped the ending and OCR boxes.
  await activeReader(page).locator('.trans-sentence[data-sentence-idx="2"]').first().hover()
  const boxes = activeReader(page).locator('.sentence-hover-box')
  await expect(boxes.first()).toBeVisible()
  expect(await boxes.count()).toBeLessThan(8)
  const ending = activeReader(page).locator('.textLayer span').filter({ hasText: 'ます' }).first()
  const covered = await ending.evaluate(el => {
    const r = el.getBoundingClientRect()
    return [...document.querySelectorAll('.sentence-hover-box')].some(box => {
      const b = box.getBoundingClientRect()
      return b.left <= r.left + 1 && b.right >= r.right - 1 && b.top <= r.top + 1 && b.bottom >= r.bottom - 1
    })
  })
  expect(covered).toBe(true)
  await page.screenshot({ path: '/tmp/easypaper-japanese-mapping.png', fullPage: true })
})

for (const scale of [0.8, 1, 1.25]) {
  test(`OCR boxes preserve each language at UI scale ${scale}`, async ({ page }) => {
    await page.addInitScript(scale => localStorage.setItem('easypaper_ui_scale', scale), String(scale))
    await openRecovered(page, geometryPdf, recovered)
    for (const span of recovered) {
      const locator = activeReader(page).locator('.textLayer span').filter({ hasText: span.text }).first()
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
  await expect(activeReader(page).locator('.pdf-text-recovery-notice')).toContainText('Tesseract')
  await expect(activeReader(page).locator('.pdf-page-inner canvas')).toBeVisible()
  await expect(activeReader(page).locator('.textLayer span')).toHaveCount(0)
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
  const layer = activeReader(page).locator('.textLayer')
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
  await expect(activeReader(page).locator('.textLayer')).toContainText('基本ソフト')
  await expect(activeReader(page).locator('.page-render-error')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/easypaper-japanese-recovered.png', fullPage: true })
})
