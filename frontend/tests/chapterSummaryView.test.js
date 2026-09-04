import test from 'node:test'
import assert from 'node:assert/strict'
import { renderChapterSummaryHtml, renderFullSummaryHtml } from '../src/chapterSummaryView.js'

test('chapter summary renders details and escapes model output', () => {
  const html = renderChapterSummaryHtml({ headline: '<script>x</script>', summary: 'body', key_points: ['point'], terms: [{ term: 'API', definition: 'interface' }], limitations: ['limited'] })
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/)
  assert.match(html, /point/)
  assert.match(html, /API — interface/)
  assert.match(html, /limited/)
  assert.doesNotMatch(html, /<script>/)
})

test('full summary renders chapter connections', () => {
  const html = renderFullSummaryHtml({ headline: 'Full', summary: 'body', chapter_connections: ['1 → 2'] })
  assert.match(html, /1 → 2/)
})
