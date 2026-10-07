import { test, expect } from '@playwright/test'
import { gotoApp, mockBaseRoutes, SAMPLE_PDF_A } from './helpers.js'
const key = 'easypaper_custom_themes_v1'
async function setup(page) {
  await mockBaseRoutes(page, { documents: [] })
  await gotoApp(page)
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('.theme-editor')).toBeVisible()
}
const base = page => page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--bg-base').trim())

test('preset preview is isolated until applied and persists after reload', async ({ page }) => {
  await setup(page)
  const original = await base(page)
  await page.locator('[data-preset="catppuccin-mocha"]').click()
  expect(await base(page)).toBe(original)
  await expect(page.locator('[data-theme-preview]')).toHaveCSS('background-color', 'rgb(30, 30, 46)')
  await page.locator('[data-theme-apply]').click()
  expect(await base(page)).toBe('#1e1e2e')
  await page.reload()
  await expect(page.locator('body')).toHaveAttribute('data-theme-id', 'catppuccin-mocha')
})

test('inactive light/general selection does not change active research/dark appearance', async ({ page }) => {
  await setup(page)
  const original = await base(page)
  await page.locator('[data-theme-mode="general"]').click()
  await page.locator('[data-theme-scheme="light"]').click()
  await page.locator('[data-preset="github-light"]').click()
  await page.locator('[data-theme-apply]').click()
  expect(await base(page)).toBe(original)
  const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)
  expect(state.selections.general.light).toBe('github-light')
  expect(state.selections.research.dark).toBe('easypaper-dark')
})

test('custom colors, duplicate, cancellation and delete use transactional drafts', async ({ page }) => {
  test.setTimeout(60000) // Includes repeated modal open/close and native dialogs on WebKit.
  await setup(page)
  await page.locator('[data-theme-copy]').click()
  await page.locator('[data-theme-name]').fill('My violet theme')
  await page.locator('[data-group="background"] summary').click()
  await page.locator('[data-color-token="bg-base"]').fill('#301040')
  expect(await base(page)).not.toBe('#301040')
  await page.locator('[data-theme-apply]').click()
  expect(await base(page)).toBe('#301040')
  await page.locator('[data-color-token="bg-base"]').fill('#ffffff')
  await page.locator('#close-settings-btn').click()
  await expect(page.locator('.theme-dialog')).toBeVisible()
  await page.locator('.theme-dialog').getByRole('button', { name: '계속 편집' }).click()
  await expect(page.locator('#settings-modal')).toBeVisible()
  await page.locator('#close-settings-btn').click()
  await page.locator('.theme-dialog').getByRole('button', { name: '버리기' }).click()
  expect(await base(page)).toBe('#301040')
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('[data-theme-delete]').click()
  await page.locator('.theme-dialog').getByRole('button', { name: '삭제', exact: true }).click()
  expect(await base(page)).toBe('#06050a')
  const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)
  expect(state.themes).toHaveLength(0)
})

test('invalid colors and storage failures never replace the applied theme', async ({ page }) => {
  await setup(page)
  const original = await base(page)
  await page.locator('[data-group="background"] summary').click()
  await page.locator('[data-color-token="bg-base"]').fill('bad')
  await page.locator('[data-theme-apply]').click()
  await expect(page.locator('[data-color-token="bg-base"]')).toHaveAttribute('aria-invalid', 'true')
  expect(await base(page)).toBe(original)
  await page.locator('[data-color-token="bg-base"]').fill('#ffffff')
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('quota') } })
  await page.locator('[data-theme-apply]').click()
  expect(await base(page)).toBe(original)
  await expect(page.locator('.theme-status')).toContainText('저장하지 못했습니다')
})

test('all preset previews render without horizontal overflow at narrow widths', async ({ page }) => {
  test.setTimeout(180000) // Exercise 64 real clicks across all presets on WebKit as well.
  await page.setViewportSize({ width: 720, height: 900 })
  await setup(page)
  for (const scheme of ['dark', 'light']) {
    if (scheme === 'light') {
      await page.locator('#close-settings-btn').click()
      await page.locator('#sidebar-theme-toggle-btn').click()
      await page.locator('#sidebar-settings-btn').click()
    }
    await page.locator('[data-theme-scheme="' + scheme + '"]').click()
    const ids = await page.locator('[data-preset]').evaluateAll(nodes => nodes.map(node => node.dataset.preset))
    for (const id of ids) {
      await page.locator('[data-preset="' + id + '"]').click()
      await page.locator('[data-theme-apply]').click()
      await expect(page.locator('[data-theme-preview]')).toHaveAttribute('data-theme-id', id)
      await expect(page.locator('body')).toHaveAttribute('data-theme-id', id)
      for (const [actual, sample] of [['#tab-workspace', '[data-theme-preview]'], ['#app-sidebar', '.theme-sample-sidebar'], ['.workspace-topnav', '.theme-sample-topbar']]) {
        const expected = await page.locator(sample).evaluate(node => getComputedStyle(node).backgroundColor)
        await expect(page.locator(actual)).toHaveCSS('background-color', expected)
      }
    }
  }
  expect(await page.locator('.theme-editor').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
})

test('JSON import creates a draft, export round trips, and HTML-like names stay text', async ({ page }) => {
  await setup(page)
  await page.locator('[data-preset="nord"]').click()
  await page.locator('[data-theme-apply]').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'JSON 내보내기', exact: true }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const exported = JSON.parse(Buffer.concat(chunks).toString())
  expect(exported.scheme).toBe('dark')
  exported.name = '<img src=x onerror=alert(1)>'
  exported.colors['bg-base'] = '#123456'
  await page.locator('.theme-editor input[type=file]').setInputFiles({ name: 'theme.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) })
  await expect(page.locator('[data-theme-name]')).toHaveValue(exported.name)
  expect(await base(page)).toBe('#2e3440')
  await page.locator('[data-theme-apply]').click()
  expect(await base(page)).toBe('#123456')
  await expect(page.locator('.theme-presets img')).toHaveCount(0)
})

test('external updates are applied but a local draft cannot overwrite them', async ({ page, context }) => {
  await setup(page)
  await page.locator('[data-theme-name]').fill('Unfinished draft')
  const other = await context.newPage()
  await mockBaseRoutes(other)
  await gotoApp(other, { navigateToLibrary: false })
  await other.evaluate(key => {
    const state = JSON.parse(localStorage.getItem(key))
    state.selections.research.dark = 'dracula'
    localStorage.setItem(key, JSON.stringify(state))
  }, key)
  await expect(page.locator('.theme-status')).toContainText('다른 창')
  expect(await base(page)).toBe('#282a36')
  await page.locator('[data-theme-apply]').click()
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).selections.research.dark, key)).toBe('dracula')
  await expect(page.locator('[data-theme-name]')).toHaveValue('Unfinished draft')
  await other.close()
})

test('Escape protects drafts and keyboard focus stays within the decision dialog', async ({ page }) => {
  await setup(page)
  await page.locator('[data-theme-name]').fill('Draft')
  await page.keyboard.press('Escape')
  await expect(page.locator('.theme-dialog')).toBeVisible()
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => Boolean(document.activeElement.closest('.theme-dialog')))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.theme-dialog')).toHaveCount(0)
  await expect(page.locator('#settings-modal')).toBeVisible()
})

test('English settings and preview layout remain usable at increased UI scale', async ({ page }) => {
  await mockBaseRoutes(page, { languageSettings: { ui_locale: 'en', default_source_language: 'auto', target_language: 'en' } })
  await page.addInitScript(() => { localStorage.setItem('easypaper_ui_locale', 'en'); localStorage.setItem('easypaper_ui_scale', '1.25') })
  await gotoApp(page)
  await page.locator('#sidebar-settings-btn').click()
  await expect(page.locator('.theme-editor h3')).toHaveText('Custom themes')
  await page.locator('[data-preset="catppuccin-mocha"]').click()
  await page.locator('[data-group="background"] summary').click()
  await page.locator('.theme-layout').scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('custom-theme-preview.png') })
  expect(await page.locator('.theme-editor').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
})

test('full theme and region tokens reach active, inactive and newly opened reader frames', async ({ page }) => {
  test.setTimeout(60000) // Three complete PDF runtimes must initialize.
  const documents = ['theme-a', 'theme-b', 'theme-c'].map(id => ({ id, filename: id + '.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [1] }))
  await mockBaseRoutes(page, { documents })
  await page.route('**/api/library/*/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/library/*/translation/1**', route => route.fulfill({ json: { translation: 'Theme preview document', sentences: [] } }))
  await gotoApp(page)
  const frame = id => page.frameLocator('iframe[data-document-id="' + id + '"]')
  async function open(id) {
    await page.evaluate(id => { location.hash = '#viewer?id=' + id }, id)
    await expect(frame(id).locator('#viewer-scroll-container')).toBeVisible({ timeout: 20000 })
  }
  await open('theme-a'); await open('theme-b')
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('[data-preset="nord"]').click()
  await page.locator('[data-group="viewer"] summary').click()
  await page.locator('[data-color-token="viewer-bg"]').fill('#123456')
  await page.locator('[data-theme-apply]').click()
  await page.locator('#close-settings-btn').click()
  for (const id of ['theme-a', 'theme-b']) {
    await expect(frame(id).locator('body')).toHaveCSS('background-color', 'rgb(46, 52, 64)')
    await expect(frame(id).locator('#viewer-scroll-container')).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  }
  await open('theme-c')
  await expect(frame('theme-c').locator('#viewer-scroll-container')).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await open('theme-a')
  await expect(frame('theme-a').locator('#viewer-scroll-container')).toHaveCSS('background-color', 'rgb(18, 52, 86)')
})

test('unsaved copy cannot delete its saved original and discarding preserves it', async ({ page }) => {
  await setup(page)
  await page.locator('[data-theme-name]').fill('Original theme')
  await page.locator('[data-theme-apply]').click()
  const original = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)
  await page.locator('[data-theme-copy]').click()
  await expect(page.locator('[data-theme-name]')).toHaveValue('Original theme (복사본)')
  await expect(page.locator('[data-theme-delete]')).toBeDisabled()
  await page.locator('#close-settings-btn').click()
  await page.locator('.theme-dialog').getByRole('button', { name: '버리기' }).click()
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).toEqual(original)
  await page.locator('#sidebar-settings-btn').click()
  await page.locator('[data-theme-copy]').click()
  await page.locator('[data-theme-apply]').click()
  await expect(page.locator('[data-theme-delete]')).toBeEnabled()
  await page.locator('[data-theme-delete]').click()
  await expect(page.locator('.theme-dialog')).toContainText('Original theme (복사본)')
  await page.locator('.theme-dialog').getByRole('button', { name: '삭제', exact: true }).click()
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).themes, key)).toEqual(original.themes)
})

test('resetting one color preserves invalid input in another color', async ({ page }) => {
  await setup(page)
  await page.locator('[data-group=background] summary').click()
  await page.locator('[data-color-token="bg-base"]').fill('#112233')
  const invalid = page.locator('[data-color-token="bg-panel"]')
  await invalid.fill('invalid')
  await page.locator('.theme-color-row').filter({ has: page.locator('[data-color-token="bg-base"]') }).getByRole('button').click()
  await expect(invalid).toHaveValue('invalid')
  await expect(invalid).toHaveAttribute('aria-invalid', 'true')
  await page.locator('[data-theme-apply]').click()
  expect(await base(page)).toBe('#06050a')
})

for (const scheme of ['light', 'dark']) {
  test(`${scheme} custom region colors reach actual shell, cards and reader elements`, async ({ page }) => {
    const doc = { id: 'theme-colors', filename: 'theme-colors.pdf', total_pages: 1, metadata: { primer_shown: true }, translated_pages: [1] }
    await mockBaseRoutes(page, { documents: [doc] })
    await page.route('**/api/library/*/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_A }))
    await page.route('**/api/library/*/translation/1**', route => route.fulfill({ json: { translation: 'Theme text', sentences: [] } }))
    await page.addInitScript(({ key, scheme }) => {
      const id = 'region-test'
      localStorage.setItem('easypaper_theme_research', scheme)
      localStorage.setItem(key, JSON.stringify({ version: 1, themes: [{ id, name: 'Region test', scheme, basePresetId: scheme === 'light' ? 'catppuccin-latte' : 'nord', overrides: {
        'bg-base': '#123456', 'sidebar-bg': '#223344', 'topbar-bg': '#334455', 'topbar-selected': '#445566',
        'card-selected': '#556677', 'translation-text': '#abcdef', 'translation-border': '#00ff00', 'translation-selected': '#aabbcc', 'viewer-selected': '#ccbbaa', 'viewer-border': '#120034', 'chat-bg': '#112233',
      } }], selections: { research: { light: scheme === 'light' ? id : 'easypaper-light', dark: scheme === 'dark' ? id : 'easypaper-dark' }, general: { light: 'easypaper-light', dark: 'easypaper-dark' } } }))
    }, { key, scheme })
    await gotoApp(page)
    await expect(page.locator('#tab-workspace')).toHaveCSS('background-color', 'rgb(18, 52, 86)')
    await expect(page.locator('#app-sidebar')).toHaveCSS('background-color', 'rgb(34, 51, 68)')
    await expect(page.locator('.workspace-topnav')).toHaveCSS('background-color', 'rgb(51, 68, 85)')
    const card = page.locator('.doc-card').first()
    await card.hover()
    await card.locator('.doc-card-check-btn').click()
    await expect(card).toHaveClass(/doc-card-selected/)
    await expect(card).toHaveCSS('background-color', 'rgb(85, 102, 119)')
    await page.evaluate(() => { location.hash = '#viewer?id=theme-colors' })
    const frame = page.frameLocator('iframe[data-document-id="theme-colors"]')
    await expect(frame.locator('.trans-text').first()).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('.trans-text').first()).toHaveCSS('color', 'rgb(171, 205, 239)')
    await expect(frame.locator('.panels')).toHaveCSS('border-top-color', 'rgb(18, 0, 52)')
    await expect(frame.locator('.trans-page-block').first()).toHaveCSS('border-top-color', 'rgb(0, 255, 0)')
    const selection = await frame.locator('.trans-text').first().evaluate(node => {
      const probe = document.createElement('span')
      probe.style.backgroundColor = 'var(--translation-selected)'
      node.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { actual: getComputedStyle(node, '::selection').backgroundColor, expected }
    })
    expect(selection.actual).toBe(selection.expected)
    await expect(frame.locator('#chat-sidebar')).toHaveCSS('background-color', 'rgb(17, 34, 51)')
    await expect(page.locator('.workspace-tab.active')).toHaveCSS('background-color', 'rgb(68, 85, 102)')
  })
}

test('preview preserves workspace and parallel reader geometry at desktop and phone widths', async ({ page }, testInfo) => {
  await setup(page)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.locator('[data-preview-tab="library"]').click()
    const sidebar = await page.locator('.theme-sample-sidebar').boundingBox()
    const topbar = await page.locator('.theme-sample-topbar').boundingBox()
    expect(topbar.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width - 1)
    expect(Math.abs(topbar.y - sidebar.y)).toBeLessThan(1)
    await expect(page.locator('.theme-sample-card')).toHaveCount(2)
    await expect(page.locator('[data-theme-preview] button')).toHaveCount(0)
    await page.locator('[data-preview-tab="reader"]').click()
    const paper = await page.locator('.theme-sample-paper').boundingBox()
    const translation = await page.locator('.theme-sample-translation').boundingBox()
    const chat = await page.locator('.theme-sample-chat').boundingBox()
    expect(translation.x).toBeGreaterThan(paper.x + paper.width)
    expect(chat.x).toBeGreaterThan(translation.x + translation.width)
    expect(Math.abs(paper.y - translation.y)).toBeLessThan(1)
    expect(await page.locator('[data-theme-preview]').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.locator('[data-theme-preview]').screenshot({ path: testInfo.outputPath(`preview-reader-${width}.png`), style: '.theme-footer { visibility: hidden; }' })
    await page.locator('[data-preview-tab="library"]').click()
    await page.locator('[data-theme-preview]').screenshot({ path: testInfo.outputPath(`preview-library-${width}.png`), style: '.theme-footer { visibility: hidden; }' })
  }
})
