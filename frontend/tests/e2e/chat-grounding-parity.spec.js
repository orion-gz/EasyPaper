import { test, expect } from '@playwright/test'
import { mockBaseRoutes, gotoApp, SAMPLE_PDF_A } from './helpers.js'

const documentRecord = {
  id: 'grounded-chat-doc', filename: 'grounded.pdf', total_pages: 1,
  created_at: '2026-01-01T00:00:00Z', metadata: { title: 'Grounded Paper' },
  translated_pages: [], document_mode: 'research', document_type: 'research_paper',
  source_language: 'en', detected_source_language: 'en', preferred_target_language: 'ko',
  processing_policy: 'inherit', content_revision: 1,
}

function sse(frames) {
  return frames.map(([name, payload]) =>
    'event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n'
  ).join('')
}

test('standalone chat renders evidence and retries one failed question without duplication', async ({ page }) => {
  await mockBaseRoutes(page, { documents: [documentRecord] })
  await page.route('**/api/chat/sessions*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ sessions: [{
      doc_id: documentRecord.id, title: 'Grounded Paper', filename: 'grounded.pdf',
      created_at: documentRecord.created_at, last_message_at: documentRecord.created_at,
      document_mode: 'research', document_type: 'research_paper',
    }] }),
  }))
  await page.route('**/api/library/grounded-chat-doc/pdf', route => route.fulfill({
    status: 200, contentType: 'application/pdf', body: SAMPLE_PDF_A,
  }))
  await page.route('**/api/chat/grounded-chat-doc/history', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ history: [
      { role: 'user', content: 'saved question', content_revision: 1, stale: false },
      {
        role: 'assistant', content: 'Saved answer [p.1]', content_revision: 1, stale: false,
        evidence: [{ evidence_id: 'ev_saved', page_num: 1, section: 'Saved', quote: 'Saved source.', occurrence: 1 }],
        verification: { status: 'verified_structure', risks: [] },
      },
    ] }),
  }))

  const requests = []
  let failedOnce = false
  await page.route('**/api/chat/stream', async route => {
    const body = route.request().postDataJSON()
    requests.push(body)
    const question = body.messages.at(-1)?.content
    if (question === 'fail once' && !failedOnce) {
      failedOnce = true
      return route.fulfill({
        status: 200, contentType: 'text/event-stream',
        body: sse([
          ['context', { mode: 'standalone', page_num: null, visual_included: false }],
          ['error', { code: 'chat_stream_failed', message: 'temporary failure' }],
          ['done', { failed: true }],
        ]),
      })
    }
    const answer = question === 'fail once' ? 'Recovered answer [p.1]' : 'Grounded answer [p.1]'
    return route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: sse([
        ['context', { mode: 'standalone', page_num: null, visual_included: false }],
        ['answer', { delta: answer }],
        ['evidence', { items: [{
          evidence_id: 'ev_grounded', page_num: 1, section: 'Results',
          quote: 'Grounded source quote.', translation_quote: '근거 원문 번역.', occurrence: 1,
        }] }],
        ['verification', { status: 'verified_structure', risks: [] }],
        ['done', { answer_message_id: 7 }],
      ]),
    })
  })

  await gotoApp(page)
  await page.click('.sidebar-nav-item[data-page="chats"]')
  await page.click('.aic-action-btn[data-action="chat"]')
  await expect(page.locator('#chat-drawer')).toHaveClass(/open/)
  await expect(page.locator('#chat-drawer-messages [data-evidence-id="ev_saved"]')).toBeVisible()
  await expect(page.locator('#chat-drawer-messages .chat-verification-badge').first()).toBeVisible()

  await page.fill('#chat-drawer-input', 'ground this')
  await page.click('#chat-drawer-send-btn')
  const citation = page.locator('#chat-drawer-messages [data-page-citation="1"]').last()
  await expect(citation).toBeVisible()
  await expect(citation.locator('.chat-evidence-card')).toHaveCount(1)
  await expect(page.locator('#chat-drawer-messages .chat-verification-badge').last()).toBeVisible()
  expect(requests[0].screen_context).toEqual({ mode: 'standalone', include_visual: false })
  expect(requests[0].current_page).toBeUndefined()
  expect(requests[0].selected_text).toBeUndefined()

  await page.fill('#chat-drawer-input', 'fail once')
  await page.click('#chat-drawer-send-btn')
  const retry = page.locator('#chat-drawer-messages [data-chat-drawer-retry]')
  await expect(retry).toBeVisible()
  await retry.click()
  await expect(page.locator('#chat-drawer-messages .message-bubble').filter({ hasText: 'Recovered answer' })).toBeVisible()
  const retriedBody = requests.at(-1)
  expect(retriedBody.messages.filter(message => message.role === 'user' && message.content === 'fail once')).toHaveLength(1)

  await citation.click()
  await expect.poll(() => new URL(page.url()).hash).toContain('#viewer?id=grounded-chat-doc&page=1')
  expect(new URL(page.url()).hash).toContain('quote=Grounded+source+quote.')
})
