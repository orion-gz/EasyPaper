import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mockBaseRoutes, gotoApp } from './helpers.js'

const moduleSource = fs.readFileSync(new URL('../../src/focusMode.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8')

async function setup(page, scale = 1) {
  await page.setContent(`<style>body{margin:0;background:white} #root{position:absolute;inset:0} .sentence{position:absolute;left:100px;top:120px;width:200px;height:40px;background:white} #panel{position:fixed;left:400px;top:120px;width:150px;height:80px;z-index:10000;background:white}</style><div id="root"><div class="sentence trans-sentence">Source sentence</div></div><aside id="panel">AI panel</aside>`)
  await page.addStyleTag({ content: css })
  await page.addStyleTag({ content: '#root .sentence { position:absolute; display:block; left:100px; top:120px; width:200px; height:40px; background:white }' })
  // Real viewer screens contain offscreen panels and long document contents.
  // Their visual overflow must not enlarge the SVG filter coordinate system.
  await page.locator('#root').evaluate(root => {
    const overflow = document.createElement('div')
    Object.assign(overflow.style, { position: 'absolute', left: '-2000px', top: '3000px', width: '4000px', height: '2000px', background: 'red' })
    root.append(overflow)
  })
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

for (const zoom of [0.8, 1, 1.25]) {
  test(`aligned source and translation leave their gutter dimmed at zoom ${zoom}`, async ({ page }) => {
    await page.setContent('<style>body{margin:0;background:white}#layer{position:fixed;inset:0;--focus-dim:.6}.focus-mode-backdrop{position:absolute;inset:0}</style><div id="layer"></div>')
    for (const magnification of [1, 1.5]) for (const offset of [-0.25, 0.25]) {
      await page.evaluate(async ({ moduleSource, zoom, magnification, offset }) => {
        const { createFocusTint } = await import(URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' })))
        document.documentElement.style.zoom = String(zoom)
        const layer = document.querySelector('#layer'); layer.style.zoom = String(1 / zoom)
        layer.replaceChildren(createFocusTint([
          { left: 100 * zoom, top: (200 + offset) * zoom, width: 200 * magnification * zoom, height: 20 * magnification * zoom },
          { left: 600 * zoom, top: 200 * zoom, width: 200 * magnification * zoom, height: 20 * magnification * zoom },
        ], innerWidth, innerHeight, 0))
      }, { moduleSource, zoom, magnification, offset })
      await expect(page.locator('.focus-tint-hole')).toHaveCount(2)
      const screenshot = (await page.screenshot({ scale: 'css', path: test.info().outputPath(`gutter-${magnification}-${offset}.png`) })).toString('base64')
      const pixels = await page.evaluate(async ({ screenshot, zoom }) => {
        const image = new Image(); image.src = `data:image/png;base64,${screenshot}`; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
        const red = x => ctx.getImageData(Math.round(x * zoom), Math.round(210 * zoom), 1, 1).data[0]
        return { source: red(200), translation: red(700), gutter: red(500) }
      }, { screenshot, zoom })
      expect(pixels.source).toBe(255)
      expect(pixels.translation).toBe(255)
      expect(pixels.gutter).toBeLessThan(130)
    }
  })
}

for (const zoom of [0.8, 1, 1.25]) {
  test(`keyboard navigation scrolls once without recentering or bounce at zoom ${zoom}`, async ({ page }) => {
    await page.setContent('<div id="root"><div class="page-pair"><div class="trans-page-content"><p><span id="s0" class="trans-sentence">First sentence.</span><span id="s1" class="trans-sentence">Second sentence.</span><span id="s2" class="trans-sentence">Offscreen sentence.</span></p></div></div><div style="height:400px"></div><div class="page-pair"><div class="trans-page-content"><p><span id="s3" class="trans-sentence">Next page sentence.</span></p></div></div></div>')
    await page.addStyleTag({ content: css })
    await page.addStyleTag({ content: 'body{margin:0} #root{position:absolute;left:40px;top:40px;width:560px;height:240px;overflow:auto;scroll-behavior:smooth} .page-pair{display:block;width:500px;max-width:none;margin:0;padding:0;border:0} .trans-page-content{height:140px;min-height:0;padding:10px;overflow:auto;scroll-behavior:smooth} p{margin:0;font:18px/30px sans-serif} .trans-sentence{display:block} #s2{margin-top:300px}' })
    await page.evaluate(async ({ moduleSource, zoom }) => {
      document.documentElement.style.zoom = String(zoom)
      const { FocusModeController, visibleFocusRects } = await import(URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' })))
      const refs = Array.from({ length: 4 }, (_, i) => ({ pageNum: i === 3 ? 2 : 1, sentenceIdx: i, revealTranslation: true, element: document.querySelector(`#s${i}`) }))
      window.controller = new FocusModeController({ root: document.querySelector('#root'), listSentences: () => refs, resolvePair: ref => ({ elements: [ref.element], translationRects: visibleFocusRects(ref.element) }) })
      window.controller.applySettings({ enabled: true, blurStrength: 1, dimOpacity: 20, scale: 125 })
      window.controller.togglePin(refs[0])
    }, { moduleSource, zoom })
    await expect(page.locator('.focus-mode-magnification')).toBeVisible()
    await page.locator('#s0').hover()
    await expect(page.locator('.page-pair').first()).toHaveCSS('transform', 'none')
    const scrolls = () => page.evaluate(() => [document.querySelector('#root').scrollTop, ...Array.from(document.querySelectorAll('.trans-page-content'), e => e.scrollTop)])
    const initial = await scrolls()
    await page.keyboard.press('ArrowDown')
    expect(await scrolls()).toEqual(initial)
    const stable = async () => {
      await expect(page.locator('.focus-mode-magnification')).toBeVisible()
      const samples = await page.evaluate(async () => {
        const samples = []
        for (let i = 0; i < 15; i++) {
          await new Promise(requestAnimationFrame)
          const r = document.querySelector('.focus-mode-magnification')?.getBoundingClientRect()
          samples.push([document.querySelector('#root').scrollTop, ...Array.from(document.querySelectorAll('.trans-page-content'), e => e.scrollTop), r?.left, r?.top, r?.width, r?.height])
        }
        return samples
      })
      expect(samples.every(sample => sample.every(Number.isFinite))).toBe(true)
      for (const sample of samples) expect(sample).toEqual(samples[0])
    }
    await page.keyboard.press('ArrowDown')
    expect((await scrolls())[1]).toBeGreaterThan(0)
    await stable()
    await page.keyboard.press('ArrowDown')
    expect((await scrolls())[0]).toBeGreaterThan(0)
    await stable()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await stable()
    await page.keyboard.press('Escape')
    await expect(page.locator('.focus-mode-layer')).toHaveCount(0)
    await page.evaluate(() => window.controller.applySettings({ enabled: false }))
    await expect(page.locator('#root')).not.toHaveClass(/focus-mode-enabled/)
    await page.evaluate(() => { window.controller.applySettings({ enabled: true }); window.controller.destroy() })
    await expect(page.locator('#root')).not.toHaveClass(/focus-mode-enabled/)
  })
}

for (const density of [1, 2]) {
  test.describe(`single tint surface at DPR ${density}`, () => {
    test.use({ deviceScaleFactor: density })
    for (const zoom of [0.8, 1, 1.25]) {
      test(`fractional sentence edges produce no dark horizontal seams at zoom ${zoom}`, async ({ page }) => {
        await setup(page, zoom)
        await page.evaluate(() => {
          document.querySelector('#root').replaceChildren()
          window.controller.resolvePair = () => ({
            sourceRects: [
              { left: 100.125, top: 120.33333, width: 320.33333, height: 18.66667 },
              { left: 100.125, top: 160.66667, width: 250.25, height: 19.33333 },
            ],
            translationRects: [
              { left: 600.25, top: 139.00001, width: 300.125, height: 21.33333 },
              { left: 600.25, top: 180.00001, width: 180.33333, height: 22.66667 },
            ],
          })
        })
        for (const dimOpacity of [0, 20, 60]) {
          await page.evaluate(dimOpacity => window.controller.applySettings({ enabled: true, blurStrength: 0, dimOpacity, scale: 100 }), dimOpacity)
          await expect(page.locator('.focus-mode-backdrop')).toHaveCount(1)
          await expect(page.locator('.focus-mode-backdrop > rect')).toHaveCSS('fill-opacity', String(dimOpacity / 100))
          const screenshot = (await page.screenshot({ scale: 'device', path: test.info().outputPath(`tint-${dimOpacity}.png`) })).toString('base64')
          const pixels = await page.evaluate(async ({ screenshot, density }) => {
            const image = new Image(); image.src = `data:image/png;base64,${screenshot}`; await image.decode()
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
            const reds = []
            // The reported lines extend across the whole screen, far outside
            // sentence openings. Every pixel in this strip must have one tint.
            for (let y = 20 * density; y < image.height - 20 * density; y++) reds.push(ctx.getImageData(5 * density, y, 1, 1).data[0])
            return { min: Math.min(...reds), max: Math.max(...reds), hole: ctx.getImageData(200 * density, 130 * density, 1, 1).data[0] }
          }, { screenshot, density })
          expect(pixels.max - pixels.min).toBeLessThanOrEqual(1)
          expect(pixels.min).toBeCloseTo(255 - 250 * dimOpacity / 100, 0)
          expect(pixels.hole).toBe(255)
        }
      })
    }
  })
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
  await expect(page.locator('.focus-tint-hole').first()).toHaveAttribute('x', '246')
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => window.controller.current.sentenceIdx)).toBe(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.focus-mode-layer')).toHaveCount(0)
})

test('idle focus avoids per-frame resolution without delaying explicit input', async ({ page }) => {
  await setup(page)
  const counts = await page.evaluate(async () => {
    let calls = 0
    const resolve = window.controller.resolvePair
    window.controller.resolvePair = ref => { calls++; return resolve(ref) }
    const frames = async count => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame) }
    await frames(4)
    calls = 0
    await frames(12)
    const idle = calls
    // Queueing a new hover cancels the idle check and resolves on the next RAF.
    window.controller.pinned = false
    calls = 0
    window.controller.focus({ pageNum: 1, sentenceIdx: 1 })
    await frames(1)
    const hover = calls
    window.controller.clear()
    calls = 0
    await new Promise(resolve => setTimeout(resolve, 160))
    return { idle, hover, cleared: calls, timer: window.controller.idleTimer }
  })
  expect(counts.idle).toBeLessThan(8)
  expect(counts.hover).toBeGreaterThan(0)
  expect(counts.cleared).toBe(0)
  expect(counts.timer).toBeNull()
})

for (const scale of [0.8, 1, 1.25]) {
for (const strength of [1, 6, 16]) {
test(`blur ${strength}px preserves sentence pixels with offscreen overflow at scale ${scale}`, async ({ page }) => {
  await setup(page, scale)
  await page.addStyleTag({ content: '#panel, #root .sentence { background: repeating-linear-gradient(90deg, black 0 2px, white 2px 4px) }' })
  await page.locator('#root').evaluate(root => {
    const background = document.createElement('div')
    Object.assign(background.style, { position: 'absolute', left: '400px', top: '240px', width: '150px', height: '80px', background: 'repeating-linear-gradient(90deg, black 0 2px, white 2px 4px)' })
    root.append(background)
  })
  await page.evaluate(strength => window.controller.applySettings({ enabled: true, blurStrength: strength, dimOpacity: 0, scale: 100 }), strength)
  await expect.poll(() => page.locator('.focus-mode-layer').evaluate(element => element.style.getPropertyValue('--focus-blur'))).toBe(`${strength}px`)
  const screenshot = (await page.screenshot({ scale: 'css' })).toString('base64')
  const contrasts = await page.evaluate(async ({ screenshot, scale }) => {
    const image = new Image(); image.src = `data:image/png;base64,${screenshot}`; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
    const contrast = (x, y) => {
      const data = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 32, 1).data
      const samples = Array.from({ length: 32 }, (_, i) => data[i * 4])
      return Math.max(...samples) - Math.min(...samples)
    }
    return { source: contrast(220, 150), background: contrast(450, 175), viewerBackground: contrast(450, 285) }
  }, { screenshot, scale })
  expect(contrasts.source).toBeGreaterThan(200)
  for (const contrast of [contrasts.background, contrasts.viewerBackground]) {
    if (strength === 1) {
      expect(contrast).toBeGreaterThan(20)
      expect(contrast).toBeLessThan(200)
    } else expect(contrast).toBeLessThan(30)
  }
})
}
}

test('blur and tint can be independently disabled; controls release the mask before interaction', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => window.controller.applySettings({ enabled: true, blurStrength: 10, dimOpacity: 0, scale: 100 }))
  await expect.poll(() => page.locator('.focus-mode-layer').evaluate(element => element.style.getPropertyValue('--focus-blur'))).toBe('10px')
  await expect(page.locator('.focus-mode-backdrop > rect')).toHaveCSS('fill-opacity', '0')
  await page.locator('#panel').click()
  await expect(page.locator('.focus-mode-layer')).toHaveCount(0)
  await expect(page.locator('#root')).toHaveCSS('filter', 'none')
})

test('overlapping memos cannot obscure focus and are restored on release', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const memo = document.createElement('aside')
    memo.className = 'floating-memo'
    memo.textContent = 'Covering note'
    Object.assign(memo.style, { position: 'fixed', left: '100px', top: '120px', width: '200px', height: '40px', background: 'red', zIndex: '999999' })
    document.body.append(memo)
  })
  await expect(page.locator('.floating-memo')).toHaveCSS('visibility', 'hidden')
  await page.locator('.floating-memo').evaluate(element => { element.style.left = '600px' })
  await expect(page.locator('.floating-memo')).toHaveCSS('visibility', 'visible')
  await page.locator('.floating-memo').evaluate(element => { element.style.left = '100px' })
  await expect(page.locator('.floating-memo')).toHaveCSS('visibility', 'hidden')
  await page.keyboard.press('Escape')
  await expect(page.locator('.floating-memo')).toHaveCSS('visibility', 'visible')
  await expect(page.locator('.floating-memo')).toHaveCSS('filter', 'none')
})

test('focus restores existing inline filters and cleans up when disabled', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    window.controller.clear()
    document.querySelector('#root').style.setProperty('filter', 'brightness(0.8)', 'important')
    window.controller.togglePin({ pageNum: 1, sentenceIdx: 0 })
  })
  await expect(page.locator('feGaussianBlur').first()).toBeAttached()
  await page.evaluate(() => window.controller.applySettings({ enabled: false }))
  await expect(page.locator('#root')).toHaveCSS('filter', 'brightness(0.8)')
  await expect(page.locator('#root')).toHaveCSS('overflow-x', 'visible')
  await expect(page.locator('#root')).toHaveCSS('overflow-y', 'visible')
  await expect(page.locator('feGaussianBlur')).toHaveCount(0)
  await expect(page.locator('.focus-mode-layer')).toHaveCount(0)
})

for (const zoom of [0.8, 1, 1.25]) {
  test(`expanded Korean sentence openings match text, not old white boxes at scale ${zoom}`, async ({ page }) => {
    await setup(page, zoom)
    await page.evaluate(async moduleSource => {
      const { visibleFocusRects } = await import(URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' })))
      window.controller.clear()
      document.body.classList.add('light-theme')
      document.querySelector('#root').innerHTML = `<div class="trans-page-content" style="position:absolute;left:50px;top:60px;width:850px;height:300px;background:white"><p style="margin:35px;width:680px;font:20px/60px sans-serif;color:black"><span class="trans-sentence sentence-highlight" style="background:rgba(74,135,181,.2);box-shadow:0 0 0 2px blue;transition:background-color 1s">2. 합성곱 커널 가중치 시각화: 이 접근법은 모델의 합성곱 커널 가중치를 직접 시각화하고 해석하는 데 중점을 둡니다.</span> 일반적으로 임의의 두 층 간의 교차 필터 맵 연결성으로 인해</p></div>`
      const element = document.querySelector('#root .trans-sentence')
      window.controller.resolvePair = () => ({ translationRects: visibleFocusRects(element), elements: [element] })
      window.controller.applySettings({ enabled: true, blurStrength: 1, dimOpacity: 60, scale: 125 })
      window.controller.togglePin({ pageNum: 1, sentenceIdx: 0 })
    }, moduleSource)
    const group = page.locator('.focus-mode-magnification')
    await expect(group).toBeVisible()
    for (const clone of await group.locator('.trans-sentence').all()) {
      await expect(clone).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(clone).toHaveCSS('box-shadow', 'none')
    }
    const points = await page.evaluate(() => {
      const inside = (x, y, r) => x >= r.left - 1 && x <= r.left + r.width + 1 && y >= r.top - 1 && y <= r.top + r.height + 1
      const enlarged = [...document.querySelectorAll('.focus-mode-magnification')].flatMap(e => e.focusRects)
      const points = []
      for (const e of document.querySelectorAll('.focus-mode-erasure')) {
        const r = e.focusRect
        for (let y = Math.ceil(r.top + 1); y < r.bottom - 1; y += 2) for (let x = Math.ceil(r.left + 1); x < r.right - 1; x += 4) {
          if (!enlarged.some(r => inside(x, y, r))) points.push([x, y])
        }
      }
      return points
    })
    expect(points.length).toBeGreaterThan(10)
    const screenshot = (await page.screenshot({ scale: 'css', path: test.info().outputPath('korean-focus-box.png') })).toString('base64')
    const brightest = await page.evaluate(async ({ screenshot, points }) => {
      const image = new Image(); image.src = `data:image/png;base64,${screenshot}`; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      return Math.max(...points.map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[0]))
    }, { screenshot, points })
    expect(brightest).toBeLessThan(150)
  })

  test(`magnified sentences stay inside bordered panes at UI scale ${zoom}`, async ({ page }) => {
    await page.setContent(`<style>
      .pane { position:absolute; top:80px; width:240px; height:180px; border:5px solid; overflow:auto; }
      .pdf-page-wrapper { left:30px; } .trans-page-content { left:400px; }
      canvas { width:240px; height:180px; display:block; }
      p { margin:0; position:absolute; right:0; bottom:0; width:210px; font:18px/26px sans-serif; }
    </style><div class="pane pdf-page-wrapper"><canvas width="480" height="360"></canvas></div>
    <div class="pane trans-page-content"><p><span>A translated sentence across multiple lines at the edge.</span></p></div>`)
    const results = await page.evaluate(async ({ moduleSource, zoom }) => {
      const { createFocusMagnification, visibleFocusRects } = await import(URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' })))
      document.documentElement.style.zoom = String(zoom)
      const canvas = document.querySelector('canvas'), element = document.querySelector('span')
      const layer = document.createElement('div')
      Object.assign(layer.style, { position: 'fixed', inset: '0', zoom: String(1 / zoom) })
      document.body.append(layer)
      const results = []
      for (const width of [240, 190]) {
        document.querySelectorAll('.pane').forEach(pane => { pane.style.width = `${width}px` })
        const c = canvas.getBoundingClientRect()
        const sourceRects = [{ left: c.left + 10 * zoom, top: c.bottom - 35 * zoom, right: c.left + width * zoom, bottom: c.bottom, width: (width - 10) * zoom, height: 35 * zoom }]
        const translationRects = visibleFocusRects(element)
        layer.replaceChildren(...createFocusMagnification({ sourceCanvas: canvas, sourceRects, elements: [element] }, [...sourceRects, ...translationRects], 1.5))
        for (const group of layer.querySelectorAll('.focus-mode-magnification')) {
          const pane = document.querySelector(group.dataset.kind === 'source' ? '.pdf-page-wrapper' : '.trans-page-content')
          const p = pane.getBoundingClientRect(), r = group.getBoundingClientRect()
          const sx = p.width / pane.offsetWidth, sy = p.height / pane.offsetHeight
          results.push({ kind: group.dataset.kind, left: r.left - (p.left + pane.clientLeft * sx), top: r.top - (p.top + pane.clientTop * sy), right: p.left + (pane.clientLeft + pane.clientWidth) * sx - r.right, bottom: p.top + (pane.clientTop + pane.clientHeight) * sy - r.bottom })
        }
      }
      return results
    }, { moduleSource, zoom })
    expect(results).toHaveLength(4)
    for (const result of results) for (const side of ['left', 'top', 'right', 'bottom']) expect(result[side], `${result.kind} ${side}`).toBeGreaterThanOrEqual(-1)
  })

  test(`150% magnifies canvas and multiline translation without reflow at UI scale ${zoom}`, async ({ page }) => {
    await setup(page, zoom)
    const original = await page.evaluate(async moduleSource => {
      const { visibleFocusRects } = await import(URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' })))
      window.controller.clear()
      const root = document.querySelector('#root')
      const canvas = document.createElement('canvas'); canvas.id = 'focus-canvas'; canvas.width = 400; canvas.height = 80
      Object.assign(canvas.style, { position: 'absolute', left: '100px', top: '120px', width: '200px', height: '40px' })
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 80); ctx.fillStyle = 'black'; ctx.font = '28px sans-serif'; ctx.fillText('Focused source', 12, 48)
      const paragraph = document.createElement('p'); paragraph.id = 'focus-paragraph'
      Object.assign(paragraph.style, { position: 'absolute', left: '650px', top: '240px', width: '200px', margin: '0', fontSize: '18px', lineHeight: '28px' })
      paragraph.innerHTML = '<span class="trans-sentence">A <strong>translated</strong> sentence that <em>wraps</em> across multiple lines.</span>'
      root.append(canvas, paragraph)
      // The fixture inherits web fonts; newly used bold/italic faces may still
      // load after insertion. Compare layout only after font metrics settle.
      paragraph.getBoundingClientRect()
      await document.fonts.ready
      const element = paragraph.firstElementChild
      window.controller.resolvePair = () => ({ sourceCanvas: canvas, sourceRects: [canvas.getBoundingClientRect()], translationRects: visibleFocusRects(element), elements: [element] })
      const original = { canvas: canvas.getBoundingClientRect().toJSON(), paragraph: paragraph.getBoundingClientRect().toJSON() }
      window.controller.applySettings({ enabled: true, blurStrength: 1, dimOpacity: 20, scale: 150 })
      window.controller.togglePin({ pageNum: 1, sentenceIdx: 0 })
      return original
    }, moduleSource)
    const source = page.locator('.focus-mode-magnification[data-kind="source"]')
    const translation = page.locator('.focus-mode-magnification[data-kind="translation"]')
    await expect(source).toBeVisible()
    await expect(translation).toBeVisible()
    await expect(translation.locator('.focus-mode-text-copy')).toHaveCount(1)
    await expect(translation.locator('p')).toHaveCount(1)
    for (const [selector, property] of [['strong', 'font-weight'], ['em', 'font-style']]) {
      const originalStyle = await page.locator(`#focus-paragraph ${selector}`).evaluate((e, property) => getComputedStyle(e).getPropertyValue(property), property)
      await expect(translation.locator(selector)).toHaveCSS(property, originalStyle)
    }
    await expect.poll(() => page.evaluate(async () => {
      const before = document.querySelector('.focus-mode-magnification')
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      return before === document.querySelector('.focus-mode-magnification')
    })).toBe(true)
    await expect.poll(() => source.evaluate(e => Math.round(e.getBoundingClientRect().width))).toBe(Math.round(original.canvas.width * 1.5))
    await expect(translation.locator(':scope > div')).not.toHaveCount(1)
    expect(await page.locator('#focus-paragraph').boundingBox()).toEqual({ x: original.paragraph.x, y: original.paragraph.y, width: original.paragraph.width, height: original.paragraph.height })
    await expect(page.locator('.focus-mode-magnification [id]')).toHaveCount(0)
    await page.evaluate(() => window.controller.applySettings({ enabled: true, blurStrength: 1, dimOpacity: 20, scale: 120 }))
    await expect.poll(() => source.evaluate(e => Math.round(e.getBoundingClientRect().width))).toBe(Math.round(original.canvas.width * 1.2))
    await page.keyboard.press('Escape')
    await expect(page.locator('.focus-mode-magnification, .focus-mode-erasure')).toHaveCount(0)
  })
}

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
  test.setTimeout(60000)
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
    localStorage.setItem('easypaper_focus_scale_research', '100')
    localStorage.setItem('easypaper_disable_hover_tooltip', 'true')
    location.hash = '#viewer?id=focus-pdf'
  })
  const source = page.locator('.textLayer span').filter({ hasText: 'The quick brown fox' }).first()
  await expect(source).toBeVisible({ timeout: 15000 })
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
  await source.click()
  const sourceMask = await page.locator('.focus-tint-hole').evaluateAll(elements => elements.map(e => ['x', 'y', 'width', 'height'].map(p => Number(e.getAttribute(p)))))
  // Compare actual PDF canvas and translation glyph pixels, not just geometry
  // or CSS declarations. Keep native layout/scroll positions fixed for both.
  const focused = (await page.screenshot({ scale: 'css', path: test.info().outputPath('focused.png') })).toString('base64')
  await page.evaluate(() => {
    window.focusFilterStyles = Array.from(document.body.children).filter(e => e instanceof HTMLElement && e.style.filter).map(e => [e, e.style.filter, e.style.getPropertyPriority('filter')])
    for (const [element] of window.focusFilterStyles) element.style.setProperty('filter', 'none', 'important')
    document.querySelector('.focus-mode-layer').style.visibility = 'hidden'
  })
  const original = (await page.screenshot({ scale: 'css', path: test.info().outputPath('original.png') })).toString('base64')
  await page.evaluate(() => {
    for (const [element, value, priority] of window.focusFilterStyles) element.style.setProperty('filter', value, priority)
    document.querySelector('.focus-mode-layer').style.visibility = ''
    delete window.focusFilterStyles
  })
  const boxes = [await source.boundingBox(), await translation.boundingBox()]
  const differences = await page.evaluate(async ({ focused, original, boxes }) => {
    const pixels = async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      return boxes.map(b => ctx.getImageData(Math.ceil(b.x), Math.ceil(b.y), Math.floor(b.width), Math.floor(b.height)).data)
    }
    const a = await pixels(focused), b = await pixels(original)
    const sharpness = (data, width) => {
      const gray = Array.from({ length: data.length / 4 }, (_, i) => (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3)
      return { edges: gray.reduce((sum, value, i) => sum + (i % width ? Math.abs(value - gray[i - 1]) : 0), 0), contrast: Math.max(...gray) - Math.min(...gray) }
    }
    return a.map((data, box) => ({
      difference: data.reduce((sum, value, i) => sum + Math.abs(value - b[box][i]), 0) / data.length,
      focused: sharpness(data, Math.floor(boxes[box].width)), original: sharpness(b[box], Math.floor(boxes[box].width)),
    }))
  }, { focused, original, boxes })
  // Compositing changes glyph antialiasing and, on macOS, PDF canvas colors.
  // Bound the color difference while requiring the original edge detail and
  // contrast: a blank or blurred sentence must still fail on every platform.
  for (const result of differences) {
    expect(result.difference).toBeLessThan(15)
    expect(result.focused.edges).toBeGreaterThan(result.original.edges * 0.9)
    expect(result.focused.contrast).toBeGreaterThan(result.original.contrast * 0.95)
  }
  await page.evaluate(() => {
    document.querySelector('#setting-focus-mode').checked = true
    const range = document.querySelector('#setting-focus-scale')
    range.value = '150'; range.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const enlargedSource = page.locator('.focus-mode-magnification[data-kind="source"]')
  await expect(enlargedSource).toBeVisible()
  await expect(page.locator('.focus-mode-magnification[data-kind="translation"]').first()).toBeVisible()
  await expect(page.locator('.focus-mode-magnification .sentence-highlight, .focus-mode-magnification .active-mapped-sentence')).toHaveCount(0)
  expect((await enlargedSource.boundingBox()).width).toBeGreaterThan(sourceBefore.width * 1.4)
  expect((await source.boundingBox()).width).toBeCloseTo(sourceBefore.width, 0)
  const magnified = (await page.screenshot({ scale: 'css', path: test.info().outputPath('magnified-150.png') })).toString('base64')
  const enlargedBoxes = await page.locator('.focus-mode-magnification').evaluateAll(elements => elements.map(e => e.getBoundingClientRect().toJSON()))
  const glyphs = await page.evaluate(async ({ magnified, enlargedBoxes }) => {
    const image = new Image(); image.src = `data:image/png;base64,${magnified}`; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
    return enlargedBoxes.map(b => {
      const width = Math.floor(b.width), data = ctx.getImageData(Math.ceil(b.x), Math.ceil(b.y), width, Math.floor(b.height)).data
      const gray = Array.from({ length: data.length / 4 }, (_, i) => (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3)
      return { contrast: Math.max(...gray) - Math.min(...gray), edges: gray.reduce((sum, value, i) => sum + (i % width ? Math.abs(value - gray[i - 1]) : 0), 0) / gray.length }
    })
  }, { magnified, enlargedBoxes })
  for (const glyph of glyphs) {
    expect(glyph.contrast).toBeGreaterThan(100)
    expect(glyph.edges).toBeGreaterThan(4)
  }
  await page.evaluate(() => {
    const range = document.querySelector('#setting-focus-scale')
    range.value = '100'; range.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.locator('.focus-mode-magnification')).toHaveCount(0)
  await translation.hover()
  // Native hover can scroll the pane by a fractional pixel in WebKit.
  await expect.poll(() => page.locator('.focus-tint-hole').evaluateAll((elements, before) => {
    if (elements.length !== before.length) return Infinity
    return Math.max(...elements.flatMap((e, i) => ['x', 'y', 'width', 'height'].map((p, j) => Math.abs(Number(e.getAttribute(p)) - before[i][j]))))
  }, sourceMask)).toBeLessThanOrEqual(2)
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
