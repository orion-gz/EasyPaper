import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A, SAMPLE_PDF_B } from './helpers.js'

// pdf-page-wrapper DOM은 문서 전환 시 재사용되는데, 이전 문서의 비동기
// _renderPage()가 뒤늦게 끝나며 새 문서용으로 이미 정리된 wrapper에 옛
// canvas를 덮어쓰던 경쟁 조건의 회귀 테스트 (renderGeneration 카운터로 방지)
test('문서를 빠르게 연속 전환해도 최종적으로 올바른 문서 상태로 수렴한다', async ({ page, browserName }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  const docB = { id: 'doc-B', filename: 'DocB.pdf', total_pages: 1, metadata: { title: 'Document B' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [docA, docB] })
  // 이 테스트는 PDF 전환 경합만 검증하므로 외부 KaTeX CDN 상태와 분리한다.
  await page.route('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/copy-tex.min.css', route => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '',
  }))
  await page.route('**/api/library/doc-A/pdf', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/library/doc-B/pdf', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_B }))

  const consoleErrors = []
  page.on('console', msg => {
    const isCancelledWebKitImport = browserName === 'webkit'
      && msg.text() === 'TypeError: Importing a module script failed.'
    if (msg.type() === 'error' && !msg.text().includes('katex') && !msg.text().includes('jsdelivr') && !isCancelledWebKitImport) {
      consoleErrors.push(msg.text())
    }
  })

  await gotoApp(page)

  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1500)

  const initialCanvas = await page.evaluate(() => {
    const wrapper = document.querySelector('.pdf-page-wrapper[data-page="1"]')
    const canvas = wrapper?.querySelector('canvas')
    return canvas ? { width: canvas.width, height: canvas.height } : null
  })
  expect(initialCanvas).not.toBeNull()
  expect(initialCanvas.width).toBeGreaterThan(0)

  // 문서를 빠르게 연속 전환 (경쟁 조건 유발 시도)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-B' })
  await page.waitForTimeout(50)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(50)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-B' })

  await expect(page.locator('#doc-title')).toHaveText('Document B')
  await expect(page.locator('.pdf-page-wrapper[data-page="1"] canvas')).toBeAttached({ timeout: 5_000 })

  const finalState = await page.evaluate(() => {
    const wrappers = document.querySelectorAll('.pdf-page-wrapper')
    const canvas = wrappers[0]?.querySelector('canvas')
    return { wrapperCount: wrappers.length, hasCanvas: !!canvas }
  })
  expect(finalState.wrapperCount).toBe(1)
  expect(finalState.hasCanvas).toBe(true)

  expect(consoleErrors, `예상치 못한 콘솔 에러: ${consoleErrors.join(', ')}`).toHaveLength(0)
})
