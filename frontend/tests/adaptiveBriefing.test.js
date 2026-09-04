import test from 'node:test'
import assert from 'node:assert/strict'

import { adaptiveBriefingSummary, hasAdaptiveBriefing, renderAdaptiveBriefingHtml } from '../src/adaptiveBriefing.js'

test('renders server section titles and supported kinds', () => {
  const data = {
    schema_version: 3,
    headline: 'Overview',
    sections: [
      { id: 'taxonomy', title: '분류 체계', kind: 'bullets', content: '', items: ['A', 'B'] },
      { id: 'terms', title: '용어', kind: 'glossary', content: '', items: [{ term: 'API', definition: 'Interface' }] },
    ],
    suggested_questions: ['왜 그런가?'],
  }
  const html = renderAdaptiveBriefingHtml(data, { suggestedQuestions: 'Suggested questions' })
  assert.equal(hasAdaptiveBriefing(data), true)
  assert.match(html, /분류 체계/)
  assert.match(html, /API/)
  assert.match(html, /Suggested questions/)
  assert.equal(adaptiveBriefingSummary(data), 'Overview')
})

test('escapes section content and labels', () => {
  const html = renderAdaptiveBriefingHtml({
    schema_version: 3,
    sections: [{ id: 'x', title: '<img>', kind: 'prose', content: '<script>x</script>', items: [] }],
  })
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})


test('renders academic book roadmap as title, pages, and focus without raw field labels', () => {
  const html = renderAdaptiveBriefingHtml({
    schema_version: 3,
    sections: [{
      id: 'chapter_roadmap', title: '장별 안내', kind: 'bullets', content: '',
      items: [{ title: 'Chapter 1: Foundations', pages: '1–32', focus: '인터넷의 기본 구조' }],
    }],
  })
  assert.match(html, /Chapter 1: Foundations/)
  assert.match(html, /1–32/)
  assert.match(html, /인터넷의 기본 구조/)
  assert.doesNotMatch(html, />title</)
  assert.doesNotMatch(html, />focus</)
})
