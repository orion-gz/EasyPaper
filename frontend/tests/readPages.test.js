import assert from 'node:assert/strict'
import test from 'node:test'

import { countUniqueVerifiedPages } from '../src/readPages.js'

test('검증 페이지를 논문과 페이지 번호 기준으로 중복 없이 센다', () => {
  const events = [
    { type: 'browsed', doc_id: 'paper-a', verified_page_numbers: [1] },
    { type: 'read', doc_id: 'paper-a', verified_page_numbers: [1, 2] },
    { type: 'read', doc_id: 'paper-b', verified_page_numbers: [1] },
    { type: 'read', doc_id: 'paper-a', verified_page_numbers: [2, 0, null] },
    { type: 'uploaded', doc_id: 'paper-a', verified_page_numbers: [3] },
  ]

  assert.equal(countUniqueVerifiedPages(events), 3)
})

test('검증 페이지 번호가 없는 과거 이벤트를 추정해서 세지 않는다', () => {
  const events = [
    { type: 'read', doc_id: 'paper-a', verified_pages: 8, start_page: 1, end_page: 8 },
  ]

  assert.equal(countUniqueVerifiedPages(events), 0)
})
