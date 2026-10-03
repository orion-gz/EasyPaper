import { test, expect } from '@playwright/test'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../../src/documentReaderTools.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '')

test('concurrent fit callers wait for the existing PDF rerender', async ({ page }) => {
  await page.setContent('<div id="viewer-screen"><div id="viewer-scroll-container" style="width:600px;height:500px"></div><div id="toolbar"></div><div id="floating"></div></div>')
  await page.evaluate(async source => {
    const { installReaderTools } = await import(URL.createObjectURL(new Blob([
      "const t = key => key; const icon = () => '';\n" + source,
    ], { type: 'text/javascript' })))
    const gate = new Promise(resolve => { window.releaseFit = resolve })
    const adapter = {
      state: { zoom: .5, totalPages: 1 }, pageWidth: async () => 300,
      zoom: async () => { window.fitStarted = true; await gate },
    }
    window.tools = installReaderTools(adapter, {
      scroll: document.querySelector('#viewer-scroll-container'), toolbar: document.querySelector('#toolbar'),
      floating: document.querySelector('#floating'), changed() {},
    })
    window.firstFit = window.tools.fitNow()
    window.secondFit = window.tools.fitNow().then(() => { window.secondFinished = true })
  }, source)
  await expect.poll(() => page.evaluate(() => window.fitStarted)).toBe(true)
  expect(await page.evaluate(() => Boolean(window.secondFinished))).toBe(false)
  await page.evaluate(async () => {
    window.releaseFit()
    await Promise.all([window.firstFit, window.secondFit])
    window.tools.destroy()
  })
  expect(await page.evaluate(() => window.secondFinished)).toBe(true)
})
