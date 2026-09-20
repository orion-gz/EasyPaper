import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

test('수동 번역 모드는 버튼을 누른 한 페이지만 번역한다', async ({ page }) => {
  const doc = {
    id: 'doc-manual',
    filename: 'Manual.pdf',
    total_pages: 1,
    metadata: { title: 'Manual translation document' },
    translated_pages: [],
  }
  let translationRequests = 0
  let restartRequests = 0

  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/doc-manual/pdf', route => route.fulfill({
    status: 200,
    contentType: 'application/pdf',
    body: SAMPLE_PDF_A,
  }))
  await page.route('**/api/translate/doc-manual/1**', route => {
    translationRequests += 1
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"content":"수동 페이지 번역"}\n\ndata: {"done":true,"sentences":[]}\n\n',
    })
  })
  await page.route('**/api/jobs/doc-manual/restart', route => {
    restartRequests += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  await gotoApp(page)
  await page.evaluate(() => {
    localStorage.setItem('easypaper_translation_mode', 'pane')
    location.hash = '#viewer?id=doc-manual'
  })

  const translateButton = page.locator('#trans-content-1 .translate-page-btn')
  await expect(translateButton).toBeVisible()
  expect(translationRequests).toBe(0)
  expect(restartRequests).toBe(0)

  await translateButton.click()

  await expect(page.locator('#trans-content-1 .trans-text')).toContainText('수동 페이지 번역')
  expect(translationRequests).toBe(1)
  expect(restartRequests).toBe(0)
})

for (const failure of ['sse', 'http', 'network', 'truncated']) {
  test(`수동 번역 실패 후 재시도한다: ${failure}`, async ({ page }) => {
    const doc = {
      id: 'doc-retry', filename: 'Retry.pdf', total_pages: 1,
      metadata: { title: 'Retry translation' }, translated_pages: [],
    }
    let requests = 0
    await mockBaseRoutes(page, { documents: [doc] })
    await page.route('**/api/library/doc-retry/pdf', route => route.fulfill({
      status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A,
    }))
    await page.route('**/api/translate/doc-retry/1**', async route => {
      requests += 1
      if (requests <= 2) {
        if (failure === 'network') return route.abort('failed')
        if (failure === 'http') return route.fulfill({
          status: 503, contentType: 'application/json',
          body: JSON.stringify({ detail: { code: 'generation_failed' } }),
        })
        return route.fulfill({
          status: 200, contentType: 'text/event-stream',
          body: 'data: {"content":"불완전한 번역"}\n\n' + (failure === 'sse'
            ? 'data: {"error":{"code":"generation_failed"},"done":true}\n\n' : ''),
        })
      }
      return route.fulfill({
        status: 200, contentType: 'text/event-stream',
        body: 'data: {"content":"재시도 성공"}\n\ndata: {"done":true,"sentences":[]}\n\n',
      })
    })
    await gotoApp(page)
    await page.evaluate(() => {
      localStorage.setItem('easypaper_translation_mode', 'pane')
      location.hash = '#viewer?id=doc-retry'
    })
    const content = page.locator('#trans-content-1')
    await content.getByRole('button', { name: '이 페이지 번역하기' }).click()
    const retry = content.getByRole('button', { name: '다시 시도' })
    await expect(retry).toBeVisible()
    await expect(content.getByRole('alert')).toContainText('번역 실패')
    expect(requests).toBe(1)
    await retry.click()
    await expect(retry).toBeVisible()
    expect(requests).toBe(2)
    await retry.click()
    await expect(content.locator('.trans-text')).toContainText('재시도 성공')
    await expect(content).not.toContainText('불완전한 번역')
    await expect(retry).toHaveCount(0)
    expect(requests).toBe(3)
  })
}
