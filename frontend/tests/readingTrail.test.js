import test from 'node:test'
import assert from 'node:assert/strict'
import { createReadingTrail } from '../src/readingTrail.js'
test('reference history keeps isolated snapshots and unwinds in reverse order', () => {
  const trail = createReadingTrail(2)
  const first = { page: 2, offset: .2 }
  trail.remember(first); first.page = 100
  trail.remember({ page: 3 }); trail.remember({ page: 3 })
  assert.equal(trail.pop().page, 3)
  assert.equal(trail.pop().page, 2)
  assert.equal(trail.pop(), undefined)
  trail.remember({ page: 1 }); trail.remember({ page: 2 }); trail.remember({ page: 3 })
  trail.pop(); trail.pop(); assert.equal(trail.pop(), undefined)
  trail.remember({ page: 4 }); trail.clear(); assert.equal(trail.last, undefined)
})
