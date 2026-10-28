import { test, expect } from '@playwright/test'
import { gotoApp, mockBaseRoutes } from './helpers.js'

for (const width of [1280, 500]) {
  test(`settings controls share a right edge at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockBaseRoutes(page, { documents: [] })
    await gotoApp(page)
    await page.locator('#sidebar-settings-btn').click()

    const rightEdge = async locator => locator.evaluate(el => el.getBoundingClientRect().right)
    const switchEdge = async id => rightEdge(page.locator(`#${id} + .toggle-switch-track`))
    const pickerEdge = async id => rightEdge(page.locator(`#${id}`).locator('..').locator('.provider-picker-btn'))
    const assertAligned = async (left, right) => expect(Math.abs(await left() - await right())).toBeLessThan(3)

    await assertAligned(() => switchEdge('setting-minimal-ui'), () => pickerEdge('setting-ui-scale'))
    if (width === 500) {
      const scaleSpacing = await page.locator('#setting-ui-scale-group').evaluate(row => {
        const label = row.querySelector('label').getBoundingClientRect()
        const help = row.querySelector('small').getBoundingClientRect()
        const picker = row.querySelector('.provider-picker-btn').getBoundingClientRect()
        return [help.top - label.bottom, picker.top - help.bottom]
      })
      expect(scaleSpacing.every(gap => gap >= 0)).toBe(true)
    }
    await page.locator('#settings-nav-translation').click()
    await assertAligned(() => switchEdge('setting-ignore-math'), () => pickerEdge('setting-target-lang'))
    await page.locator('#settings-nav-viewer').click()
    await page.locator('#setting-focus-mode').locator('..').click()
    const zoomEdge = () => pickerEdge('setting-default-zoom')
    for (const id of [
      'setting-focus-mode', 'setting-focus-hide-overlays', 'setting-disable-hover-tooltip',
      'setting-disable-bookmark', 'setting-disable-figure-overlay', 'setting-reader-commandSearch',
      'setting-reader-referenceReturn',
    ]) await assertAligned(() => switchEdge(id), zoomEdge)
    const viewerSwitches = await page.locator('#tab-viewer .toggle-switch-track:visible').evaluateAll(tracks =>
      tracks.map(track => track.getBoundingClientRect().right))
    expect(viewerSwitches.length).toBeGreaterThan(10)
    for (const edge of viewerSwitches) expect(Math.abs(edge - await zoomEdge())).toBeLessThan(3)
    await assertAligned(() => pickerEdge('setting-figure-overlay-trigger'), zoomEdge)
    await assertAligned(() => pickerEdge('setting-reader-memoRightPosition'), zoomEdge)
    await assertAligned(() => pickerEdge('setting-reader-memoOverflow'), zoomEdge)
    await expect(page.locator('#tab-viewer')).toBeVisible()
    expect(await page.locator('#tab-viewer').evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true)

    await page.locator('#settings-nav-model').click()
    const modelEdge = () => rightEdge(page.locator('#setting-default-ai-provider .provider-picker-btn'))
    await assertAligned(() => rightEdge(page.locator('#setting-ollama-host')), modelEdge)
    await assertAligned(() => rightEdge(page.locator('#setting-pdf-parser-picker .provider-picker-btn')), modelEdge)
    await page.locator('#tab-model details').first().evaluate(el => { el.open = true })
    for (const name of ['trans', 'analysis', 'chat', 'library']) {
      await assertAligned(() => switchEdge(`setting-${name}-same-as-default`), modelEdge)
    }
  })
}
