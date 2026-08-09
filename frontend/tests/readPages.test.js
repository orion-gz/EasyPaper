import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addDaysKey,
  computeStreakDays,
  countUniqueVerifiedPages,
  hasReadActivity,
  lastActivityIso,
  readPageCount,
  todayKey,
  uniqueVerifiedPageKeys,
} from '../src/readPages.js'

test('완독 문서는 참고문헌 시작 전까지만 읽은 페이지로 센다', () => {
  assert.equal(readPageCount({ total_pages: 12, metadata: { read: true, reference_start_page: 9 } }), 8)
})

test('진행 중 문서는 본문 페이지 상한과 잘못된 입력을 처리한다', () => {
  assert.equal(readPageCount({ total_pages: 12, metadata: { last_page: 11, reference_start_page: 9 } }), 8)
  assert.equal(readPageCount({ total_pages: 12, metadata: { last_page: 4 } }), 4)
  assert.equal(readPageCount({ total_pages: 12, metadata: { last_page: '4' } }), 0)
})

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

test('검증 페이지 키는 이벤트 종류와 유효한 페이지 번호를 검증한다', () => {
  const keys = uniqueVerifiedPageKeys([
    { type: 'read', doc_id: 'a', verified_page_numbers: [1, 1, -1, 1.5] },
    { type: 'browsed', doc_id: 'b', verified_page_numbers: [2] },
    { type: 'uploaded', doc_id: 'c', verified_page_numbers: [3] },
  ])
  assert.deepEqual([...keys], ['a:1', 'b:2'])
})

test('마지막 활동 시각과 실제 읽기 활동 여부를 구분한다', () => {
  const createdAt = '2026-08-01T00:00:00Z'
  const meta = { read_at: '2026-08-02T00:00:00Z', last_read_at: '2026-08-03T00:00:00Z' }
  assert.equal(lastActivityIso(meta, createdAt), meta.last_read_at)
  assert.equal(hasReadActivity(meta), true)
  assert.equal(hasReadActivity({}), false)
})

test('날짜 키 덧셈은 월·연도 경계를 넘는다', () => {
  assert.equal(addDaysKey('2026-01-31', 1), '2026-02-01')
  assert.equal(addDaysKey('2025-12-31', 1), '2026-01-01')
  assert.equal(addDaysKey('invalid', 1), 'invalid')
})

test('연속 활동일은 오늘 또는 어제부터만 계산한다', () => {
  const today = todayKey()
  const yesterday = addDaysKey(today, -1)
  const twoDaysAgo = addDaysKey(today, -2)
  const asNoon = key => `${key}T12:00:00`

  assert.equal(computeStreakDays([
    { timestamp: asNoon(today) },
    { timestamp: asNoon(yesterday) },
    { timestamp: asNoon(twoDaysAgo) },
  ]), 3)
  assert.equal(computeStreakDays([
    { timestamp: asNoon(yesterday) },
    { timestamp: asNoon(twoDaysAgo) },
  ]), 2)
  assert.equal(
    computeStreakDays([{ timestamp: asNoon(addDaysKey(today, -3)) }]),
    0,
  )
})
