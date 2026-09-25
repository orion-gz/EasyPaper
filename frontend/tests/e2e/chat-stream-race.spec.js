import { test, expect } from '@playwright/test'
import { activeReader, evaluateReader, mockBaseRoutes, gotoApp, SAMPLE_PDF_A, SAMPLE_PDF_B } from './helpers.js'

// 문서 A에서 스트리밍 중이던 채팅 응답이, 문서 B로 전환한 뒤 뒤늦게 도착해도
// 문서 B의 채팅창에 섞여 들어가면 안 된다 (openFromLibrary가 이전 스트림을
// 취소하지 않던 경쟁 조건의 회귀 테스트)
test('문서 전환 시 이전 문서의 채팅 스트림이 새 문서에 섞이지 않는다', async ({ page }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  const docB = { id: 'doc-B', filename: 'DocB.pdf', total_pages: 1, metadata: { title: 'Document B' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [docA, docB] })

  await page.route('**/api/library/doc-A/pdf', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/library/doc-B/pdf', route => route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_B }))

  let streamARoute = null
  await page.route('**/api/chat/stream', async route => {
    streamARoute = route // 응답을 보류해 "아직 진행 중인 스트림" 상태를 만든다
  })

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1000)

  await expect(activeReader(page).locator('#workspace-reading-mode')).toBeVisible()
  await activeReader(page).locator('#chat-input').fill('문서 A에 대한 질문')
  await activeReader(page).locator('#chat-send-btn').click()
  await page.waitForTimeout(400)

  // 스트림이 아직 pending인 상태에서 문서 B로 전환 (뒤로가기 라우팅과 동일 경로)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-B' })
  await page.waitForTimeout(1000)

  await expect(activeReader(page).locator('#doc-title')).toHaveText('Document B')

  // 이제서야 문서 A의 스트림 응답이 뒤늦게 도착했다고 가정
  if (streamARoute) {
    await streamARoute.fulfill({ status: 200, contentType: 'text/plain', body: '이것은 문서 A에 대한 뒤늦은 응답입니다.' }).catch(() => {})
  }
  await page.waitForTimeout(500)

  const chatText = await activeReader(page).locator('#chat-messages').textContent()
  expect(chatText).not.toContain('문서 A에 대한 뒤늦은 응답')
})
