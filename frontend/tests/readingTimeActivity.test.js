import assert from 'node:assert/strict'
import test from 'node:test'

import { createReadingTimeActivityTracker } from '../src/readingTimeActivity.js'

test('사이드바가 열려 있어도 마지막 PDF 상호작용을 읽기 시간으로 분류한다', () => {
  let now = 1_000
  const tracker = createReadingTimeActivityTracker({ now: () => now })

  tracker.reset('reading')
  assert.equal(tracker.getCategory({ chatAvailable: true }), 'reading')
})

test('채팅 영역과 PDF 영역의 마지막 상호작용에 따라 분류를 전환한다', () => {
  let now = 1_000
  const tracker = createReadingTimeActivityTracker({ now: () => now })

  tracker.reset('reading')
  now = 2_000
  tracker.record('chat')
  assert.equal(tracker.getCategory({ chatAvailable: true }), 'chat')

  now = 3_000
  tracker.record('reading')
  assert.equal(tracker.getCategory({ chatAvailable: true }), 'reading')
})

test('유휴 제한을 넘으면 시간을 분류하지 않는다', () => {
  let now = 1_000
  const tracker = createReadingTimeActivityTracker({ idleMs: 60_000, now: () => now })

  tracker.reset('reading')
  now = 61_001
  assert.equal(tracker.getCategory(), null)
})

test('닫힌 채팅 사이드바의 과거 상호작용을 채팅 시간으로 분류하지 않는다', () => {
  let now = 1_000
  const tracker = createReadingTimeActivityTracker({ now: () => now })

  tracker.reset('reading')
  now = 2_000
  tracker.record('chat')
  assert.equal(tracker.getCategory({ chatAvailable: false }), 'reading')
})
