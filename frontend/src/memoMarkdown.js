const CALLOUT_TITLES = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

function escapeHtml(value) {
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
