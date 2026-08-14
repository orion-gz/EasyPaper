// ── 리치 텍스트 포맷터 (마크다운 헤더/볼드 + LaTeX 수식) ──────────────
// 번역창(main.js)의 formatTranslationHtml/applyKatexToElement를 그대로
// 옮겨온 것이다. 원래는 main.js 안에 있었는데, 읽기 전 브리핑(primer)
// 텍스트도 같은 서식(LLM이 **볼드**나 $...$ 수식을 섞어 반환)을 쓰는
// Notes 요약 탭에서도 그대로 재사용하려고 별도 모듈로 뺐다.
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const INDENT_MARK = String.fromCharCode(0xE000)

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Markdown과 LaTeX를 안전하게 렌더링한다. */
export function formatMarkdownLatexHtml(text, options = {}) {
  if (!text) return ''

  const mathBlocks = []
  let source = String(text)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => {
      const id = mathBlocks.push({ formula: formula.trim(), display: true }) - 1
      return `EASYPAPERMATHBLOCK${id}END`
    })
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => {
      const id = mathBlocks.push({ formula: formula.trim(), display: true }) - 1
      return `EASYPAPERMATHBLOCK${id}END`
    })
    .replace(/(?<!\$)\$([^\$\n]+?)\$(?!\$)/g, (_, formula) => {
      const id = mathBlocks.push({ formula: formula.trim(), display: false }) - 1
      return `EASYPAPERMATHBLOCK${id}END`
    })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => {
      const id = mathBlocks.push({ formula: formula.trim(), display: false }) - 1
      return `EASYPAPERMATHBLOCK${id}END`
    })

  source = source.replace(/\\+\*\*/g, '**').replace(/\\+__/g, '__')
  let html = marked.parse(source)
  const sanitize = options.sanitize || (value => {
    if (typeof DOMPurify.sanitize === 'function') return DOMPurify.sanitize(value)
    return escapeHtml(value)
  })
  html = sanitize(html)

  const katex = options.katex === undefined ? globalThis.window?.katex : options.katex
  return html.replace(/EASYPAPERMATHBLOCK(\d+)END/g, (placeholder, idText) => {
    const item = mathBlocks[Number(idText)]
    if (!item) return placeholder
    const encodedFormula = encodeURIComponent(item.formula)
    if (katex) {
      try {
        const rendered = katex.renderToString(item.formula, {
          displayMode: item.display,
          throwOnError: false,
          output: 'htmlAndMathml',
        })
        const tag = item.display ? 'div' : 'span'
        const className = item.display ? 'katex-display-wrap' : 'katex-inline-wrap'
        return `<${tag} class="${className}" data-formula="${encodedFormula}" data-display="${item.display}">${rendered}</${tag}>`
      } catch {
        return `<code class="math-error" data-formula="${encodedFormula}" data-display="${item.display}">${escapeHtml(item.formula)}</code>`
      }
    }
    const delimiter = item.display ? '$$' : '$'
    return `<code class="math-pending" data-formula="${encodedFormula}" data-display="${item.display}">${escapeHtml(delimiter + item.formula + delimiter)}</code>`
  })
}

export function formatTranslationHtml(text) {
  if (!text) return ''

  // 문장 정렬용 태그([S0], [S1], [S0:I] 등)가 렌더링에 노출되지 않도록 제거
  let t = text.replace(/\[[sS]\d+(?::[A-Za-z]+)?\]/g, '')

  const mathBlocks = []

  // 1. 블록 수식: $$...$$
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: true })
    return `::MATH_FLT_PLACEHOLDER_${id}::`
  })
  // 2. 블록 수식: \[...\]
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: true })
    return `::MATH_FLT_PLACEHOLDER_${id}::`
  })
  // 3. 인라인: $...$
  t = t.replace(/(?<!\$)\$([^\$\n]+?)\$(?!\$)/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: false })
    return `::MATH_FLT_PLACEHOLDER_${id}::`
  })
  // 4. 인라인: \(...\)
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: false })
    return `::MATH_FLT_PLACEHOLDER_${id}::`
  })

  // 4.5. 이스케이프된 볼드체 복원 및 공백 트리밍
  t = t.replace(/\\+\*\*/g, '**')
  t = t.replace(/\*\*\s*([^*]+?)\s*\*\*/g, '**$1**')

  // 5. 마크다운 헤더 & 이스케이프 처리
  const lines = t.split('\n')
  const htmlParts = lines.map(line => {
    let workingLine = line
    let isIndented = false
    const leadingWs = workingLine.match(/^\s*/)[0]
    if (workingLine.slice(leadingWs.length).startsWith(INDENT_MARK)) {
      isIndented = true
      workingLine = leadingWs + workingLine.slice(leadingWs.length + INDENT_MARK.length).replace(/^\s+/, '')
    }
    const tr = workingLine.trim()
    let rendered
    if (tr.startsWith('### ')) rendered = `<h4 class="md-h4">${escapeHtml(tr.slice(4))}</h4>`
    else if (tr.startsWith('## '))  rendered = `<h3 class="md-h3">${escapeHtml(tr.slice(3))}</h3>`
    else if (tr.startsWith('# '))   rendered = `<h2 class="md-h2">${escapeHtml(tr.slice(2))}</h2>`
    else rendered = escapeHtml(workingLine)
    return isIndented ? `<span class="trans-indent">${rendered}</span>` : rendered
  })
  let html = htmlParts.join('\n')
    .replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>')

  // 6. 볼드: **...**
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')

  // 7. 수식 플레이스홀더 복원
  html = html.replace(/::MATH_FLT_PLACEHOLDER_(\d+)::/g, (_, idStr) => {
    const item = mathBlocks[parseInt(idStr)]
    if (!item) return _
    if (window.katex) {
      try {
        const r = window.katex.renderToString(item.formula, { displayMode: item.display, throwOnError: false, output: 'htmlAndMathml' })
        if (item.display) {
          return `<div class="katex-display-wrap" data-formula="${encodeURIComponent(item.formula)}" data-display="true">${r}</div>`
        } else {
          return `<span class="katex-inline-wrap" data-formula="${encodeURIComponent(item.formula)}" data-display="false">${r}</span>`
        }
      } catch (e) {
        return `<code class="math-error" data-formula="${encodeURIComponent(item.formula)}" data-display="${item.display}">${escapeHtml(item.formula)}</code>`
      }
    }
    // KaTeX 미로드 시 pending 마킹 → 나중에 applyKatexToElement()로 재처리
    const delim = item.display ? '$$' : '$'
    return `<code class="math-pending" data-formula="${encodeURIComponent(item.formula)}" data-display="${item.display}">${escapeHtml(delim + item.formula + delim)}</code>`
  })

  return html
}

/** KaTeX 로드 후 .math-pending 코드를 실제 수식으로 교체 */
export function applyKatexToElement(el) {
  if (!el || !window.katex) return
  el.querySelectorAll('code.math-pending').forEach(code => {
    try {
      const formula = decodeURIComponent(code.dataset.formula || '')
      const display = code.dataset.display === 'true'
      const r = window.katex.renderToString(formula, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' })
      const wrapper = display
        ? Object.assign(document.createElement('div'), { className: 'katex-display-wrap', innerHTML: r })
        : Object.assign(document.createElement('span'), { className: 'katex-inline-wrap', innerHTML: r })
      wrapper.dataset.formula = encodeURIComponent(formula)
      wrapper.dataset.display = display.toString()

      if (code.classList.contains('trans-sentence')) {
        wrapper.classList.add('trans-sentence')
      }
      if (code.dataset.page) {
        wrapper.dataset.page = code.dataset.page
      }
      if (code.dataset.sentenceIdx) {
        wrapper.dataset.sentenceIdx = code.dataset.sentenceIdx
      }
      if (code.style.cursor) {
        wrapper.style.cursor = code.style.cursor
      }

      code.replaceWith(wrapper)
    } catch (e) {
      code.classList.remove('math-pending')
    }
  })
}
