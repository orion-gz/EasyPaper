import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findReadingAnchor } from '../src/readingAnchor.js'

test('mixed-height pages preserve boundary and gap position semantics', () => {
  const pages = [100, 350, 500].map(bottom => ({ getBoundingClientRect: () => ({ bottom }) }))
  assert.equal(findReadingAnchor(pages, -10), pages[0])
  assert.equal(findReadingAnchor(pages, 100), pages[1])
  assert.equal(findReadingAnchor(pages, 360), pages[2])
  assert.equal(findReadingAnchor(pages, 500), null)
  assert.equal(findReadingAnchor([], 0), null)
})

test('a textbook end position requires logarithmic geometry reads', () => {
  let reads = 0
  const pages = Array.from({ length: 2000 }, (_, index) => ({
    getBoundingClientRect: () => { reads++; return { bottom: (index + 1) * 1000 } },
  }))
  assert.equal(findReadingAnchor(pages, 1999500), pages[1999])
  assert.ok(reads <= 11, `expected at most 11 geometry reads, got ${reads}`)
})
