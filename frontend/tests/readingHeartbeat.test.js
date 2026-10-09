import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadingClock, createReadingOutbox, isReadingWindowActive } from '../src/readingHeartbeat.js'

function storage() {
  const data = new Map()
  return { get length() { return data.size }, key: i => [...data.keys()][i], getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
}

test('visible iframe uses shell focus; hidden documents and unfocused windows do not count', () => {
  const parent = { document: { visibilityState: 'visible', hasFocus: () => true } }
  const win = { parent, frameElement: { hidden: false }, document: { body: { dataset: {} }, visibilityState: 'visible', hasFocus: () => false } }
  assert.equal(isReadingWindowActive(win), true)
  win.frameElement.hidden = true
  assert.equal(isReadingWindowActive(win), false)
  win.frameElement.hidden = false
  parent.document.hasFocus = () => false
  assert.equal(isReadingWindowActive(win), false)
  parent.document.hasFocus = () => true
  win.document.body.dataset.workspaceInactive = 'true'
  assert.equal(isReadingWindowActive(win), false)
})

test('clock settles short visits, category switches and idle cutoff without counting background gaps', () => {
  let now = 1000
  const records = []
  const clock = createReadingClock({ now: () => now, record: (...args) => records.push(args) })
  clock.update({ docIds: ['a'], category: 'reading', until: 61000 })
  now = 3500
  clock.update({ docIds: ['a'], category: 'chat', until: 63500 })
  now = 5000
  clock.update(null)
  now = 100000
  clock.update({ docIds: ['b'], category: 'reading', until: 160000 })
  now = 200000
  clock.update(null)
  clock.update(null)
  assert.deepEqual(records, [['a', 'reading', 2500], ['a', 'chat', 1500], ['b', 'reading', 60000]])
})

test('failed delivery survives runtime replacement and retains the same request id', async () => {
  const saved = storage()
  const attempts = []
  let success = false
  const send = async (...args) => { attempts.push(args); return success }
  const options = { storage: saved, username: 'alice', send }
  const first = createReadingOutbox(options)
  first.record('a', 'reading', 7)
  await first.flush()
  assert.equal(saved.length, 1)
  success = true
  await createReadingOutbox(options).flush()
  assert.equal(saved.length, 0)
  assert.equal(attempts[0][3].requestId, attempts[1][3].requestId)
})

test('concurrent flushes share in-flight requests and retain new work', async () => {
  const saved = storage()
  const sends = []
  let release
  const pending = new Promise(resolve => { release = resolve })
  const box = createReadingOutbox({ storage: saved, username: 'alice', send: async (...args) => { sends.push(args); return pending } })
  box.record('a', 'reading', 3)
  const first = box.flush()
  const second = box.flush()
  await Promise.resolve()
  assert.equal(sends.length, 1)
  box.record('b', 'chat', 2)
  release(true)
  await Promise.all([first, second])
  assert.equal(saved.length, 1)
  await box.flush()
  assert.equal(sends.length, 2)
  assert.equal(saved.length, 0)
})

test('backlogs respect server cap and user scope; deleted documents are discarded', async () => {
  const saved = storage()
  const records = []
  const alice = createReadingOutbox({ storage: saved, username: 'alice', send: async (_, seconds) => { records.push(seconds); return 'discard' } })
  const bob = createReadingOutbox({ storage: saved, username: 'bob', send: () => { throw new Error('wrong account') } })
  alice.record('a', 'reading', 301)
  await bob.flush()
  assert.equal(saved.length, 3)
  await alice.flush()
  assert.deepEqual(records, [120, 120, 61])
  assert.equal(saved.length, 0)
})

test('renaming an account keeps pending request identities under the new scope', async () => {
  const saved = storage()
  const box = createReadingOutbox({ storage: saved, username: 'old', send: async () => false })
  box.record('a', 'reading', 3)
  const old = JSON.parse(saved.getItem(saved.key(0)))
  box.rename('new')
  assert.equal(saved.length, 1)
  assert.equal(saved.key(0), `easypaper_reading_time:new:${old.requestId}`)
  assert.equal(box.username, 'new')
  const delivered = []
  await createReadingOutbox({ storage: saved, username: 'new', send: async (...args) => { delivered.push(args); return true } }).flush()
  assert.equal(delivered[0][3].requestId, old.requestId)
  assert.equal(delivered[0][3].day, old.day)
})

test('recording still works when randomUUID is unavailable on HTTP origins', async t => {
  t.mock.method(globalThis.crypto, 'randomUUID', () => undefined)
  const saved = storage()
  const box = createReadingOutbox({ storage: saved, username: 'alice', send: async () => true })
  box.record('a', 'reading', 3)
  box.record('b', 'chat', 4)
  assert.equal(saved.length, 2)
  await box.flush()
  assert.equal(saved.length, 0)
})
