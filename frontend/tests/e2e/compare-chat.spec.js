import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp } from './helpers.js'

// 여러 논문 비교 채팅: 라이브러리에서 2편 이상 선택 -> 비교 채팅 화면 -> 질문/답변 -> 뒤로가기
test('논문 2편을 선택해 비교 채팅을 시작하고, 질문에 대한 답변을 받을 수 있다', async ({ page }) => {
  const docs = [
    { id: 'doc-1', filename: 'transformer.pdf', total_pages: 3, metadata: { title: 'Attention Is All You Need' }, translated_pages: [] },
    { id: 'doc-2', filename: 'gan.pdf', total_pages: 2, metadata: { title: 'GAN Paper' }, translated_pages: [] },
    { id: 'doc-3', filename: 'vae.pdf', total_pages: 2, metadata: { title: 'VAE Paper' }, translated_pages: [] },
  ]
  await mockBaseRoutes(page, { documents: docs })

  let requestedDocIds = null
  await page.route('**/api/chat/compare/history*', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [], compare_id: 'cmp_test' }) }))
  await page.route('**/api/chat/compare/stream', route => {
    requestedDocIds = route.request().postDataJSON().doc_ids
    return route.fulfill({ status: 200, contentType: 'text/plain', body: ' 두 논문은 방법론이 다릅니다.' })
  })

  await gotoApp(page)

  await expect(page.locator('#lib-select-toolbar')).toHaveClass(/hidden/)

  const checkboxes = page.locator('.doc-card-check-btn')
  await checkboxes.nth(0).click()
  await checkboxes.nth(1).click()

  await expect(page.locator('#lib-select-count')).toHaveText('2개 선택됨')
  await expect(page.locator('#lib-select-compare-btn')).toBeEnabled()

  await page.click('#lib-select-compare-btn')
  await expect(page.locator('#compare-screen')).toHaveClass(/active/)
  await expect(page).toHaveURL(/#compare\?ids=doc-1,doc-2/)

  const chips = page.locator('.compare-doc-chip')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toHaveText('Attention Is All You Need')
  await expect(chips.nth(1)).toHaveText('GAN Paper')

  // 인사말에 두 논문이 모두 언급된다 (중복 렌더링되지 않아야 함)
  await expect(page.locator('#compare-chat-messages .chat-message.assistant')).toHaveCount(1)
  await expect(page.locator('#compare-chat-messages')).toContainText('Attention Is All You Need')
  await expect(page.locator('#compare-chat-messages')).toContainText('GAN Paper')

  await page.fill('#compare-chat-input', '두 논문의 차이가 뭐야?')
  await page.click('#compare-chat-send-btn')

  await expect(page.locator('#compare-chat-messages')).toContainText('두 논문의 차이가 뭐야?')
  await expect(page.locator('#compare-chat-messages')).toContainText('두 논문은 방법론이 다릅니다.')
  expect(requestedDocIds).toEqual(['doc-1', 'doc-2'])

  await page.click('#compare-back-btn')
  await expect(page.locator('#library-screen')).toHaveClass(/active/)
})

test('선택하지 않은 상태에서는 비교 채팅 시작 버튼이 비활성화된다', async ({ page }) => {
  const docs = [
    { id: 'doc-1', filename: 'a.pdf', total_pages: 1, metadata: { title: 'Paper A' }, translated_pages: [] },
    { id: 'doc-2', filename: 'b.pdf', total_pages: 1, metadata: { title: 'Paper B' }, translated_pages: [] },
  ]
  await mockBaseRoutes(page, { documents: docs })

  await gotoApp(page)
  await expect(page.locator('#lib-select-toolbar')).toHaveClass(/hidden/)

  const firstCheckbox = page.locator('.doc-card-check-btn').first()
  await firstCheckbox.click()
  await expect(page.locator('#lib-select-count')).toHaveText('1개 선택됨')
  await expect(page.locator('#lib-select-compare-btn')).toBeDisabled()

  await page.click('#lib-select-close-btn')
  await expect(page.locator('#lib-select-toolbar')).toHaveClass(/hidden/)
  await expect(firstCheckbox).not.toHaveClass(/checked/)
})

// 비교 선택 모드에서는 카드를 클릭하면 선택 상태만 토글되어야 한다. "열기" 버튼은
// 편집/삭제 등 다른 카드 액션과 달리 pointer-events: none 규칙에서 빠져 있어,
// 클릭 시 선택 대신 뷰어 화면으로 바로 이동해버리는 버그가 있었다.
test('비교 선택 모드에서 열기 버튼을 눌러도 뷰어로 이동하지 않고 선택만 토글된다', async ({ page }) => {
  const docs = [
    { id: 'doc-1', filename: 'a.pdf', total_pages: 1, metadata: { title: 'Paper A' }, translated_pages: [] },
    { id: 'doc-2', filename: 'b.pdf', total_pages: 1, metadata: { title: 'Paper B' }, translated_pages: [] },
  ]
  await mockBaseRoutes(page, { documents: docs })

  await gotoApp(page)
  await page.locator('.doc-card-check-btn').first().click()

  const secondCard = page.locator('.doc-card').nth(1)
  await secondCard.locator('.doc-open-btn').click({ force: true })

  await expect(page.locator('#lib-select-count')).toHaveText('2개 선택됨')
  await expect(page.locator('#lib-select-compare-btn')).toBeEnabled()
  await expect(page.locator('#library-screen')).toHaveClass(/active/)
  await expect(page.locator('#viewer-screen')).not.toHaveClass(/active/)
})
