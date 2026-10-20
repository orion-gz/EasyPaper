import { test, expect } from '@playwright/test'
import { activeReader, mockBaseRoutes, gotoApp, SAMPLE_PDF_CITATION } from './helpers.js'

const result = {
  status: 'complete', score: 85, method_score: 35, understanding_score: 35, background_score: 15,
  score_reason: 'The method is needed to understand the experiment.',
  citation_reason: 'The authors adopt this architecture.', roles: ['method'],
  evidence: [{ page_num: 1, quote: 'We use this method [1].' }],
}

async function openReference(page, { automatic = false, cached = false, fail = false } = {}) {
  const doc = { id: 'doc-C', filename: 'Citation.pdf', total_pages: 1, metadata: { title: 'Citation' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/doc-C/pdf', route => route.fulfill({ contentType: 'application/pdf', body: SAMPLE_PDF_CITATION }))
  await page.route('**/api/library/doc-C/references', route => route.fulfill({ json: { references: { '1': 'Vaswani et al. Attention Is All You Need. 2017.' } } }))
  const requests = []
  await page.route('**/api/library/doc-C/references/1/analysis*', route => {
    requests.push(route.request().method())
    if (route.request().method() === 'GET') return route.fulfill({ json: cached ? result : { status: 'not_analyzed' } })
    if (fail) { fail = false; return route.fulfill({ status: 502, json: { detail: 'Temporary failure' } }) }
    cached = true
    return route.fulfill({ json: result })
  })
  await gotoApp(page)
  await page.evaluate(({ automatic }) => {
    localStorage.setItem('easypaper_reference_auto_analysis_research', JSON.stringify(automatic))
    localStorage.setItem('easypaper_figure_overlay_trigger_research', 'click')
    location.hash = '#viewer?id=doc-C'
  }, { automatic })
  const reader = activeReader(page)
  const marker = reader.locator('.citation-marker-box').first()
  await expect(marker).toBeVisible({ timeout: 15000 })
  await marker.click()
  const card = reader.locator('.reference-analysis-card')
  await expect(card).toBeVisible()
  return { requests, card, marker, reader }
}

test('manual analysis renders score, source and reason, survives retry and reuses saved result', async ({ page }) => {
  const { requests, card, reader, marker } = await openReference(page, { fail: true })
  const analyze = card.locator(':scope > button')
  await expect(analyze).toBeEnabled()
  expect(requests).toEqual(['GET'])
  await analyze.click()
  await expect(card).toContainText(/다시 시도|retry/i)
  await analyze.click()
  await expect(card).toContainText('85/100')
  await expect(card).toContainText(result.citation_reason)
  await expect(card.locator('blockquote')).toHaveText(result.evidence[0].quote)
  await analyze.focus()
  await expect(analyze).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(reader.locator('.citation-tooltip')).toBeHidden()
  await marker.click()
  await expect(card).toContainText('85/100')
  expect(requests.filter(method => method === 'POST')).toHaveLength(2)
  await card.locator('.reference-analysis-body button').click()
  await expect(reader.locator('.citation-tooltip')).toBeHidden()
})

test('automatic setting analyzes on open and cached result does not generate again', async ({ page }) => {
  const { requests, card, marker, reader } = await openReference(page, { automatic: true })
  await expect(card).toContainText('85/100')
  expect(requests.filter(method => method === 'POST')).toHaveLength(1)
  await page.keyboard.press('Escape')
  await expect(reader.locator('.citation-tooltip')).toBeHidden()
  await marker.click()
  await expect(card).toContainText('85/100')
  await page.waitForTimeout(600)
  expect(requests.filter(method => method === 'POST')).toHaveLength(1)
})

for (const light of [false, true]) {
  test(`analysis typography follows the citation overlay in ${light ? 'light' : 'dark'} mode`, async ({ page }) => {
    const { card, reader } = await openReference(page, { cached: true })
    await expect(card).toContainText('85/100')
    await page.evaluate(light => document.body.classList.toggle('light-theme', light), light)
    const reference = reader.locator('.citation-tooltip-text')
    await expect(card).toHaveCSS('font-size', await reference.evaluate(el => getComputedStyle(el).fontSize))
    await expect(card).toHaveCSS('color', await reference.evaluate(el => getComputedStyle(el).color))
    await expect(card.locator('blockquote')).toHaveCSS('white-space', 'pre-wrap')
    const fonts = await card.evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el.querySelector('button')).fontFamily])
    expect(fonts[0]).toBe(fonts[1])
  })
}
