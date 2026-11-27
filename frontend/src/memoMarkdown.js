import { marked } from 'marked'
import DOMPurify from 'dompurify'

const CALLOUT_TITLES = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

const VALID_MEMO_COLORS = new Set(['default', 'yellow', 'green', 'blue', 'red'])

export function normalizeMemoColor(color) {
  return VALID_MEMO_COLORS.has(color) ? color : 'default'
}

function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * GitHub/Obsidian 스타일의 `> [!NOTE]` 블록을 marked가 렌더링할 수 있는
 * 안전한 인라인 마커로 바꾼다. blockquote 구조는 그대로 두므로 내부의 목록,
 * 코드, 강조 표시도 일반 Markdown과 동일하게 파싱된다.
 */
export function prepareMemoMarkdown(markdown) {
  const lines = String(markdown || '').split('\n')
  let fence = null

  return lines.map(line => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = { char: marker[0], length: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null
      return line
    }
    if (fence) return line

    return line.replace(
      /^((?:[ \t]*>[ \t]*)+)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[+-])?(?:[ \t]+(.*))?$/i,
      (_, prefix, typeText, titleText) => {
        const type = typeText.toLowerCase()
        const title = titleText?.trim() || CALLOUT_TITLES[type]
        return `${prefix}<span class="memo-callout-marker" data-callout="${type}">${escapeHtml(title)}</span>`
      },
    )
  }).join('\n')
}

function extractMathOutsideCode(source, mathBlocks) {
  const storeMath = (formula, display) => {
    const id = mathBlocks.push({ formula: formula.trim(), display }) - 1
    return `EASYPAPERMEMOMATH${id}END`
  }
  const replaceMathInSegment = segment => segment
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => storeMath(formula, true))
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => storeMath(formula, true))
    .replace(/(?<!\$)\$([^\$\n]+?)\$(?!\$)/g, (_, formula) => storeMath(formula, false))
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => storeMath(formula, false))

  const lines = source.split('\n')
  const nonFenceChunk = []
  const output = []
  let fence = null

  const flushChunk = () => {
    if (!nonFenceChunk.length) return
    const text = nonFenceChunk.join('\n')
    nonFenceChunk.length = 0
    // 인라인 코드(`...`) 내부의 $ 기호는 수식으로 치환하지 않는다.
    const parts = text.split(/(`+[^`]*?`+)/g)
    output.push(parts.map((part, idx) => (idx % 2 === 1 ? part : replaceMathInSegment(part))).join(''))
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) {
        flushChunk()
        fence = { char: marker[0], length: marker.length }
        output.push(line)
        continue
      }
      if (marker[0] === fence.char && marker.length >= fence.length) {
        fence = null
        output.push(line)
        continue
      }
    }
    if (fence) output.push(line)
    else nonFenceChunk.push(line)
  }
  flushChunk()
  return output.join('\n')
}

/**
 * 뷰어 메모(콜아웃, GFM 표/체크리스트/코드블록, LaTeX 수식 포함)를 안전한 HTML로 렌더링한다.
 */
export function renderMemoMarkdownHtml(markdown, options = {}) {
  if (!markdown) return ''

  const mathBlocks = []
  const prepared = prepareMemoMarkdown(markdown)
  const source = extractMathOutsideCode(prepared, mathBlocks)
    .replace(/\\+\*\*/g, '**')
    .replace(/\\+__/g, '__')

  let html = marked.parse(source)
  const sanitize = options.sanitize || (value => {
    if (typeof DOMPurify.sanitize === 'function') return DOMPurify.sanitize(value)
    return escapeHtml(value)
  })
  html = sanitize(html)

  const katex = options.katex === undefined ? globalThis.window?.katex : options.katex
  return html.replace(/EASYPAPERMEMOMATH(\d+)END/g, (placeholder, idText) => {
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
