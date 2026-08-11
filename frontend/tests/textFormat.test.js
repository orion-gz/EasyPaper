import assert from 'node:assert/strict'
import test from 'node:test'

import { formatMarkdownLatexHtml } from '../src/textFormat.js'

const passthrough = html => html

test('Markdown과 인라인·블록 LaTeX를 함께 렌더링한다', () => {
  const calls = []
  const katex = {
    renderToString(formula, options) {
      calls.push({ formula, displayMode: options.displayMode })
      return `<math>${formula}</math>`
    },
  }

  const html = formatMarkdownLatexHtml(
    '**핵심**은 $x_1$이고\n\n$$y = x^2$$',
    { katex, sanitize: passthrough },
  )

  assert.match(html, /<strong>핵심<\/strong>/)
  assert.match(html, /class="katex-inline-wrap"/)
  assert.match(html, /class="katex-display-wrap"/)
  assert.deepEqual(calls, [
    { formula: 'x_1', displayMode: false },
    { formula: 'y = x^2', displayMode: true },
  ])
})

test('KaTeX가 아직 없으면 나중에 처리할 pending 수식을 만든다', () => {
  const html = formatMarkdownLatexHtml('식: \\(a+b\\)', {
    katex: null,
    sanitize: passthrough,
  })

  assert.match(html, /class="math-pending"/)
  assert.match(html, /data-formula="a%2Bb"/)
})

test('Markdown 결과를 수식 삽입 전에 sanitizer로 정제한다', () => {
  const html = formatMarkdownLatexHtml('<img src=x onerror=alert(1)> **safe**', {
    katex: null,
    sanitize: value => value.replace(/<img[^>]*>/g, ''),
  })

  assert.doesNotMatch(html, /onerror/)
  assert.match(html, /<strong>safe<\/strong>/)
})

test('미리보기에 쓰이는 블록 Markdown도 누락 없이 렌더링한다', () => {
  const html = formatMarkdownLatexHtml(
    '# 결론\n\n- **정확도** 향상\n- `지연시간` 감소',
    { katex: null, sanitize: passthrough },
  )

  assert.match(html, /<h1>결론<\/h1>/)
  assert.match(html, /<ul>/)
  assert.match(html, /<strong>정확도<\/strong>/)
  assert.match(html, /<code>지연시간<\/code>/)
})
