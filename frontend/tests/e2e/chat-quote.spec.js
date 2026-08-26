import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

// AI 채팅 답변에서 텍스트를 선택하면 "Ask AI"로 후속 질문을 인용할 수 있어야 한다
// (PDF/번역본 인용 기능을 채팅 답변에도 확장한 기능의 회귀 테스트)
test('AI 채팅 답변 텍스트를 선택하면 Ask AI로 인용할 수 있다', async ({ page }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [docA] })
  const chatRequests = []

  await page.route('**/api/library/doc-A/pdf', route =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/chat/stream', async route => {
    chatRequests.push(await route.request().postDataJSON())
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '트랜스포머 아키텍처는 셀프 어텐션 메커니즘을 핵심으로 사용하는 딥러닝 모델입니다.' })
  })

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1200)

  await page.click('#chat-toggle-btn')
  await page.fill('#chat-input', '트랜스포머 아키텍처가 뭐야?')
  await page.click('#chat-send-btn')
  await page.waitForTimeout(800)

  const bubbleSelector = '.chat-message.assistant:not(.temp-typing) .message-bubble'
  await page.waitForSelector(bubbleSelector)

  const selection = await page.evaluate((sel) => {
    const bubbles = document.querySelectorAll(sel)
    const bubble = bubbles[bubbles.length - 1]
    const text = bubble.textContent
    const target = '셀프 어텐션'
    const start = text.indexOf(target)
    if (start === -1) return null

    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT)
    let node, offset = 0, startNode = null, startOffset = 0, endNode = null, endOffset = 0
    while ((node = walker.nextNode())) {
      const len = node.textContent.length
      if (startNode === null && start >= offset && start < offset + len) {
        startNode = node; startOffset = start - offset
      }
      const end = start + target.length
      if (end >= offset && end <= offset + len) {
        endNode = node; endOffset = end - offset
      }
      offset += len
    }
    if (!startNode || !endNode) return null

    const sel_ = window.getSelection()
    sel_.removeAllRanges()
    const r = document.createRange()
    r.setStart(startNode, startOffset)
    r.setEnd(endNode, endOffset)
    sel_.addRange(r)
    const rect = r.getBoundingClientRect()
    return { text: sel_.toString(), rect: { x: rect.left, y: rect.top } }
  }, bubbleSelector)

  expect(selection).not.toBeNull()
  expect(selection.text).toBe('셀프 어텐션')

  await page.mouse.move(selection.rect.x + 5, selection.rect.y + 5)
  await page.mouse.up()

  await expect(page.locator('.selection-menu .ask-ai-btn')).toBeVisible()

  await page.click('.selection-menu .ask-ai-btn')

  await expect(page.locator('#chat-quote-area')).not.toHaveClass(/hidden/)
  await expect(page.locator('#chat-quote-text')).toHaveText('셀프 어텐션')

  await page.fill('#chat-input', '이 부분을 더 설명해줘')
  await page.click('#chat-send-btn')
  await expect.poll(() => chatRequests.length).toBe(2)

  expect(chatRequests[1].selected_text).toBeUndefined()
  expect(chatRequests[1].messages.at(-1).content).toContain('셀프 어텐션')
})

// 사용자 자신이 보낸 메시지는 인용 대상에서 제외되어야 한다
test('사용자 자신의 채팅 메시지는 Ask AI 인용 대상이 아니다', async ({ page }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [docA] })
  await page.route('**/api/library/doc-A/pdf', route =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/chat/stream', route =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '답변입니다.' }))

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1200)
  await page.click('#chat-toggle-btn')
  await page.fill('#chat-input', '이것은 사용자 질문 텍스트')
  await page.click('#chat-send-btn')
  await page.waitForTimeout(500)

  const userBubbleFound = await page.evaluate(() => {
    const bubble = document.querySelector('.chat-message.user .message-bubble')
    if (!bubble) return false
    const range = document.createRange()
    range.selectNodeContents(bubble)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
    return true
  })
  expect(userBubbleFound).toBe(true)

  await page.mouse.move(200, 200)
  await page.mouse.up()
  await page.waitForTimeout(300)

  // 사용자 메시지 선택으로는 Ask AI 메뉴가 뜨지 않아야 한다
  const menuHidden = await page.evaluate(() => {
    const menu = document.querySelector('.selection-menu')
    return !menu || menu.classList.contains('hidden')
  })
  expect(menuHidden).toBe(true)
})

// KaTeX 수식이 포함된 답변을 인용하면, 수식이 시각 렌더링(katex-html)과
// 스크린리더용 MathML(katex-mathml) 두 번 겹쳐 나오면서 중복+줄바꿈 깨짐이
// 발생하던 회귀 테스트
test('수식이 포함된 답변을 인용하면 중복이나 줄바꿈 없이 깨끗한 텍스트로 인용된다', async ({ page }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [docA] })
  await page.route('**/api/library/doc-A/pdf', route =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/chat/stream', route =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '이 값은 $3 \\times 3 \\times 3$ 크기입니다.' }))

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1200)

  await page.click('#chat-toggle-btn')
  await page.fill('#chat-input', '크기가 뭐야?')
  await page.click('#chat-send-btn')
  await page.waitForTimeout(800)

  const bubbleSelector = '.chat-message.assistant:not(.temp-typing) .message-bubble'
  await page.waitForSelector(bubbleSelector)
  // 수식이 실제로 KaTeX로 렌더링됐는지(katex-mathml이 존재하는지) 확인 -
  // 렌더링 자체가 안 됐다면 이 테스트는 애초에 버그를 재현하지 못한다
  await expect(page.locator(`${bubbleSelector} .katex-mathml`).first()).toBeAttached()

  await page.evaluate((sel) => {
    const bubbles = document.querySelectorAll(sel)
    const bubble = bubbles[bubbles.length - 1]
    const range = document.createRange()
    range.selectNodeContents(bubble)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }, bubbleSelector)

  await page.mouse.move(200, 200)
  await page.mouse.up()
  await page.waitForTimeout(300)

  await page.click('.selection-menu .ask-ai-btn')

  await expect(page.locator('#chat-quote-area')).not.toHaveClass(/hidden/)
  const quotedText = await page.locator('#chat-quote-text').textContent()
  expect(quotedText).toBe('이 값은 3×3×3 크기입니다.')
})

// 이미지 인용 메시지는 채팅 히스토리(백엔드 DB)에 텍스트 placeholder만
// 저장되고 실제 이미지는 저장되지 않는다 - 새로고침/재접속 후 히스토리를
// 다시 불러오면 인용했던 이미지가 사라지고 placeholder 텍스트만 남던 회귀 테스트.
// 실제 이미지는 로컬 스토리지에 별도 보관되므로, 같은 브라우저에서 이전에
// 저장해둔 이미지가 있으면 히스토리 렌더링 시 복원되어야 한다.
test('새로고침 후에도 로컬에 저장된 인용 이미지가 채팅 히스토리에 복원된다', async ({ page }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [docA] })
  await page.route('**/api/library/doc-A/pdf', route =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))

  const fakeImg = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const quoteId = 'qimg_1700000000000_ab12cd'

  await page.route('**/api/chat/doc-A/history', route =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        history: [
          { role: 'user', content: `[인용된 이미지 (Page 2)|${quoteId}]\n\n질문:\n이 그림이 뭐야?` },
          { role: 'assistant', content: '이 그림은 실험 결과 그래프입니다.' },
        ],
      }),
    }))

  await gotoApp(page)
  // 이전 세션에서 이미 이 브라우저에 저장해둔 인용 이미지를 시뮬레이션
  await page.evaluate(({ quoteId, fakeImg }) => {
    localStorage.setItem('easypaper_chat_quote_images_doc-A', JSON.stringify({ [quoteId]: fakeImg }))
  }, { quoteId, fakeImg })

  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1200)

  const quoteImg = page.locator('.chat-message.user .message-quote-img')
  await expect(quoteImg).toHaveCount(1)
  await expect(quoteImg).toHaveAttribute('src', fakeImg)
})

// 반대로 로컬 스토리지에 해당 이미지가 없으면(다른 기기/브라우저 등) 기존과
// 동일하게 텍스트 placeholder로 안전하게 대체되어야 한다(깨지지 않아야 함)
test('로컬에 저장된 인용 이미지가 없으면 텍스트 placeholder로 대체된다', async ({ page }) => {
  const docA = { id: 'doc-A', filename: 'DocA.pdf', total_pages: 1, metadata: { title: 'Document A' }, translated_pages: [] }
  await mockBaseRoutes(page, { documents: [docA] })
  await page.route('**/api/library/doc-A/pdf', route =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A }))
  await page.route('**/api/chat/doc-A/history', route =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        history: [
          { role: 'user', content: '[인용된 이미지 (Page 2)|qimg_missing]\n\n질문:\n이 그림이 뭐야?' },
          { role: 'assistant', content: '답변입니다.' },
        ],
      }),
    }))

  await gotoApp(page)
  await page.evaluate(() => { location.hash = '#viewer?id=doc-A' })
  await page.waitForTimeout(1200)

  await expect(page.locator('.chat-message.user .message-quote-img')).toHaveCount(0)
  await expect(page.locator('.chat-message.user .quote-body')).toContainText('Page 2')
})
