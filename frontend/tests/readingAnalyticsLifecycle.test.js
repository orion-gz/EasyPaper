import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.window = { addEventListener() {} }
const { ReadingAnalyticsTracker } = await import('../src/readingAnalytics.js')

test('a late session start cannot restart timers after the reader closes', async t => {
  let release
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { release = resolve }))
  const timers = t.mock.method(globalThis, 'setInterval', () => 1)
  const tracker = new ReadingAnalyticsTracker()
  const start = tracker.startSession('a')
  await tracker.stopSession()
  release({ ok: true, json: async () => ({ sessionId: 'late-a', version: 1 }) })
  await start
  assert.equal(tracker.isTracking, false)
  assert.equal(tracker.sessionId, null)
  assert.equal(timers.mock.callCount(), 0)
})

test('out-of-order starts keep the newer document session', async t => {
  let release
  t.mock.method(globalThis, 'fetch', url => url.endsWith('/a/reading-session/start')
    ? new Promise(resolve => { release = resolve })
    : Promise.resolve({ ok: true, json: async () => ({ sessionId: 'session-b', version: 1 }) }))
  const timers = t.mock.method(globalThis, 'setInterval', () => 1)
  t.mock.method(globalThis, 'clearInterval', () => {})
  const tracker = new ReadingAnalyticsTracker()
  const first = tracker.startSession('a')
  await tracker.startSession('b')
  release({ ok: true, json: async () => ({ sessionId: 'late-a', version: 1 }) })
  await first
  assert.equal(tracker.paperId, 'b')
  assert.equal(tracker.sessionId, 'session-b')
  assert.equal(timers.mock.callCount(), 2)
  await tracker.stopSession()
})

test('returning to a document waits for its previous session to end', async t => {
  let releaseEnd
  let starts = 0
  t.mock.method(globalThis, 'fetch', url => {
    if (url.endsWith('/end')) return new Promise(resolve => { releaseEnd = resolve })
    if (url.endsWith('/start')) starts += 1
    return Promise.resolve({ ok: true, json: async () => ({ sessionId: `session-${starts}`, version: 0 }) })
  })
  t.mock.method(globalThis, 'setInterval', () => 1)
  t.mock.method(globalThis, 'clearInterval', () => {})
  const tracker = new ReadingAnalyticsTracker()
  await tracker.startSession('a')
  const end = tracker.stopSession()
  const returning = tracker.startSession('a')
  assert.equal(starts, 1)
  releaseEnd({ ok: true })
  await end
  await returning
  assert.equal(starts, 2)
  assert.equal(tracker.sessionId, 'session-2')
  const finalEnd = tracker.stopSession()
  releaseEnd({ ok: true })
  await finalEnd
})
