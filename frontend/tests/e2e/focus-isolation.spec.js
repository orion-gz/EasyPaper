import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mockBaseRoutes, gotoApp } from './helpers.js'

const moduleSource = fs.readFileSync(new URL('../../src/focusMode.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8')

async function setup(page, scale = 1) {
  await page.setContent(`<style>body{margin:0;background:white} #root{position:absolute;inset:0} .sentence{position:absolute;left:100px;top:120px;width:200px;height:40px;background:white} #panel{position:fixed;left:400px;top:120px;width:150px;height:80px;z-index:10000;background:white}</style><div id="root"><div class="sentence trans-sentence">Source sentence</div></div><aside id="panel">AI panel</aside>`)
  await page.addStyleTag({ content: css })
  await page.addStyleTag({ content: '#root .sentence { position:absolute; display:block; left:100px; top:120px; width:200px; height:40px; background:white }' })
  await page.evaluate(async ({ moduleSource, scale }) => {
    const module = await import(URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' })))
    document.documentElement.style.zoom = String(scale)
    document.body.style.background = 'white'
    window.controller = new module.FocusModeController({
      root: document.querySelector('#root'),
      resolvePair: () => ({ sourceRects: [document.querySelector('.sentence').getBoundingClientRect()] }),
      listSentences: () => [{ pageNum: 1, sentenceIdx: 0 }, { pageNum: 1, sentenceIdx: 1 }],
    })
    window.controller.applySettings({ enabled: true, blurStrength: 0, dimOpacity: 60, scale: 100 })
    window.controller.togglePin({ pageNum: 1, sentenceIdx: 0 })
  }, { moduleSource, scale })
  await expect(page.locator('.focus-mode-layer')).toBeVisible()
}

for (const scale of [0.8, 1, 1.25]) {
  test(`only the sentence stays clear, including above high-z-index panels at scale ${scale}`, async ({ page }) => {
    await setup(page, scale)
    const bounds = await page.locator('.focus-mode-layer').boundingBox()
    expect(bounds.x).toBeCloseTo(0, 0)
    expect(bounds.y).toBeCloseTo(0, 0)
    expect(bounds.width).toBeCloseTo(page.viewportSize().width, 0)
    expect(bounds.height).toBeCloseTo(page.viewportSize().height, 0)
    const screenshot = (await page.screenshot({ scale: 'css' })).toString('base64')
    const pixels = await page.evaluate(async ({ screenshot, scale }) => {
      const image = new Image(); image.src = `data:image/png;base64,${screenshot}`; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      const pixel = (x, y) => [...ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data]
      return { sentence: pixel(220, 150), panel: pixel(500, 175), background: pixel(50, 50) }
    }, { screenshot, scale })
    expect(pixels.sentence.slice(0, 3)).toEqual([255, 255, 255])
    expect(pixels.panel[0]).toBeLessThan(130)
    expect(pixels.background[0]).toBeLessThan(130)
  })
}

test('pinned focus ignores hover, follows geometry changes and releases with Escape', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    window.controller.focus({ pageNum: 1, sentenceIdx: 1 })
    document.querySelector('.sentence').style.left = '250px'
  })
  expect(await page.evaluate(() => window.controller.current.sentenceIdx)).toBe(0)
  await expect.poll(() => page.locator('.focus-mode-layer').innerHTML()).toContain('246px')
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => window.controller.current.sentenceIdx)).toBe(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.focus-mode-layer')).toHaveCount(0)
})

test('blur actually softens background pixels while preserving sentence pixels', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit' && process.platform === 'linux', 'Linux headless WebKit does not rasterize backdrop-filter, even on an unmasked standalone element')
  await setup(page)
  await page.addStyleTag({ content: '#panel, #root .sentence { background: repeating-linear-gradient(90deg, black 0 2px, white 2px 4px) }' })
  await page.evaluate(() => window.controller.applySettings({ enabled: true, blurStrength: 12, dimOpacity: 0, scale: 100 }))
  await expect(page.locator('.focus-mode-backdrop').first()).toHaveCSS('backdrop-filter', 'blur(12px)')
  const screenshot = (await page.screenshot({ scale: 'css' })).toString('base64')
  const contrasts = await page.evaluate(async screenshot => {
    const image = new Image(); image.src = `data:image/png;base64,${screenshot}`; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
    const contrast = (x, y) => {
      const data = ctx.getImageData(x, y, 32, 1).data
      const samples = Array.from({ length: 32 }, (_, i) => data[i * 4])
      return Math.max(...samples) - Math.min(...samples)
    }
    return { source: contrast(220, 150), background: contrast(450, 175) }
  }, screenshot)
  expect(contrasts.source).toBeGreaterThan(200)
  expect(contrasts.background).toBeLessThan(30)
})

test('blur and tint can be independently disabled; controls release the mask before interaction', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => window.controller.applySettings({ enabled: true, blurStrength: 10, dimOpacity: 0, scale: 100 }))
  await expect(page.locator('.focus-mode-backdrop').first()).toHaveCSS('backdrop-filter', 'blur(10px)')
  await expect(page.locator('.focus-mode-backdrop').first()).toHaveCSS('background-color', 'rgba(5, 7, 12, 0)')
  await page.locator('#panel').click()
  await expect(page.locator('.focus-mode-layer')).toHaveCount(0)
})

for (const scale of [0.8, 1, 1.25]) {
  test(`translation reveal scrolls only its pane and clips hidden fragments at scale ${scale}`, async ({ page }) => {
    await page.setContent('<div class="trans-page-content" style="position:absolute;left:400px;top:80px;width:200px;height:100px;overflow:auto;border:2px solid"><div style="height:500px"></div><span id="translation">Translated sentence</span><div style="height:500px"></div></div>')
    const result = await page.evaluate(async ({ moduleSource, scale }) => {
      const { visibleFocusRects, revealFocusTranslation } = await import(URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' })))
      document.documentElement.style.zoom = String(scale)
      const element = document.querySelector('#translation'), pane = element.closest('.trans-page-content')
      const hidden = visibleFocusRects(element)
      revealFocusTranslation([element])
      const visible = visibleFocusRects(element)
      const scroll = pane.scrollTop
      revealFocusTranslation([element])
      return { hidden, visible, scroll, secondScroll: pane.scrollTop, pageScroll: window.scrollY }
    }, { moduleSource, scale })
    expect(result.hidden).toEqual([])
    expect(result.visible.length).toBeGreaterThan(0)
    expect(result.scroll).toBeGreaterThan(0)
    expect(result.secondScroll).toBe(result.scroll)
    expect(result.pageScroll).toBe(0)
  })
}

test('real PDF hover reveals source and translation together and clears on viewer exit', async ({ page }) => {
  const doc = { id: 'focus-pdf', filename: 'focus.pdf', total_pages: 1, translated_pages: [1], metadata: { title: 'Focus' } }
  const pdf = fs.readFileSync(new URL('./fixtures/text-geometry.pdf', import.meta.url))
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/focus-pdf/pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
  await page.route('**/api/library/focus-pdf/translation/1**', route => route.fulfill({ json: {
    translation: 'The translated first sentence. The translated second sentence. The translated third sentence.', sentences: [],
  } }))
  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_focus_mode_enabled_research', 'true')
    localStorage.setItem('easypaper_disable_hover_tooltip', 'true')
    location.hash = '#viewer?id=focus-pdf'
  })
  const source = page.locator('.textLayer span').filter({ hasText: 'The quick brown fox' }).first()
  await expect(source).toBeVisible()
  const translation = page.locator('.trans-sentence').first()
  await expect(translation).toBeVisible()
  // Put the matching translation below its own scroll viewport, not below the page.
  await translation.evaluate(element => {
    const pane = element.closest('.trans-page-content')
    pane.style.height = '180px'
    pane.style.maxHeight = '180px'
    const spacer = document.createElement('div')
    spacer.style.height = '700px'
    pane.insertBefore(spacer, pane.firstChild)
    pane.scrollTop = 0
  })
  const sourceBefore = await source.boundingBox()
  await source.hover()
  await expect(page.locator('.focus-mode-layer')).toBeVisible()
  await expect.poll(() => translation.evaluate(element => {
    const pane = element.closest('.trans-page-content')
    const bounds = pane.getBoundingClientRect(), rect = element.getBoundingClientRect()
    return pane.scrollTop > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom
  })).toBe(true)
  expect((await source.boundingBox()).y).toBeCloseTo(sourceBefore.y, 0)
  const sourceMask = await page.locator('.focus-mode-layer').innerHTML()
  await translation.hover()
  await expect.poll(() => page.locator('.focus-mode-layer').innerHTML()).toBe(sourceMask)
  await expect(page.locator('.focus-mode-outline')).toHaveCount(0)
  await expect(translation).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(translation).toHaveCSS('box-shadow', 'none')
  await translation.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.focus-mode-layer')).toHaveCount(0)
  await source.hover()
  await expect(page.locator('.focus-mode-layer')).toBeVisible()
  await page.evaluate(() => { location.hash = '#library' })
  await expect(page.locator('.focus-mode-layer')).toHaveCount(0)
})
