// ── Notes 페이지 ──────────────────────────────────────────────────────
// 뷰어에서 남긴 메모/하이라이트/언더라인을 논문별로 모아 "읽기 전용"으로
// 보여준다. 이 페이지에서는 주석을 새로 만들거나 편집할 수 없다 - 오직
// 뷰어에서 이미 만든 것을 조회하고, 클릭하면 해당 논문 뷰어로 이동한다.
//
// 데이터 출처: 메모/하이라이트/언더라인은 서버 DB가 아니라 문서(세션)별
// localStorage(`easypaper_annotations_<id>`, `easypaper_memos_<id>`)에만
// 저장된다(main.js의 loadAnnotations/loadMemos/saveAnnotations/saveMemos와
// 동일한 키·형태를 그대로 읽는다 - import는 하지 않고 패턴만 따라한다).
// 로컬이 비어있는 문서에 한해서만 서버 미러(fetchLibraryAnnotations/
// fetchLibraryMemos)로 폴백한다("로컬이 있으면 항상 로컬 우선, 병합 없음"
// - main.js의 hydrateAnnotationsAndMemosFromServer와 동일한 정책이지만,
// 여기서는 표시 전용이라 로컬에 다시 써넣지는 않는다).

import '../styles/notes.css'
import { fetchLibrary, fetchLibraryAnnotations, fetchLibraryMemos, fetchPrimer } from '../library.js'
import { icon } from '../icons.js'
import { formatTranslationHtml, formatMarkdownLatexHtml, applyKatexToElement } from '../textFormat.js'

let renderGeneration = 0

// 뷰어의 플로팅 메모 색상 이름을 Notes 카드에서 사용하는 실제 accent 색상으로
// 맞춘다. default는 사용자가 설정한 앱 accent를 그대로 사용한다.
const MEMO_ACCENT_COLORS = {
  yellow: '#eab308',
  green: '#10b981',
  blue: '#3b82f6',
  red: '#f43f5e',
}

// 즐겨찾기는 서버에 저장되는 필드가 아니라 Library 페이지가 이미 쓰고 있는
// 로컬 전용 상태다(백엔드에 star/favorite 필드가 없음 - Library 리스킨 때 같은
// 이유로 로컬로 구현됨). 같은 localStorage 키를 그대로 읽고 써서 Library와
// Notes 양쪽에서 즐겨찾기 상태가 항상 동일하게 보이도록 한다.
const FAVORITES_KEY = 'easypaper_library_favorites'
function getFavoriteIds() {
  try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')) } catch { return new Set() }
}
function isFavoriteDoc(docId) { return getFavoriteIds().has(docId) }
function toggleFavoriteDoc(docId) {
  const ids = getFavoriteIds()
  if (ids.has(docId)) ids.delete(docId); else ids.add(docId)
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(ids)))
  return ids.has(docId)
}

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── 모듈 상태 (페이지를 재방문해도 마지막 선택/탭/검색어를 기억한다) ──
let allPapers = []          // PaperEntry[] - renderNotesPage()마다 새로 집계
let filterMode = 'all'      // 'all' | 'hasNotes' | 'favorites'
let searchQuery = ''
let selectedDocId = null
let activeSubtab = 'summary' // 'summary' | 'memo' | 'highlight' | 'underline' | 'all'

// 요약(primer)은 문서당 LLM 호출 비용이 있으므로 탭을 실제로 열었을 때만
// 가져오고, 한 번 가져오면 페이지 재방문 동안 재사용한다.
// docId -> { status: 'loading'|'ready'|'error', data?: object(primer 전체) }
const summaryCache = new Map()

// ── localStorage 읽기 (main.js loadAnnotations/loadMemos와 동일한 키/형태) ──
function readLocalAnnotations(docId) {
  try {
    const raw = localStorage.getItem(`easypaper_annotations_${docId}`)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function readLocalMemos(docId) {
  try {
    const raw = localStorage.getItem(`easypaper_memos_${docId}`)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

async function getDocAnnotationsAndMemos(docId) {
  let annotationsByPage = readLocalAnnotations(docId)
  let memosByPage = readLocalMemos(docId)

  if (Object.keys(annotationsByPage).length === 0) {
    try {
      const server = await fetchLibraryAnnotations(docId)
      if (server && server.data && Object.keys(server.data).length) annotationsByPage = server.data
    } catch {
      // best-effort - 조회 실패해도 목록 표시는 계속 진행
    }
  }
  if (Object.keys(memosByPage).length === 0) {
    try {
      const server = await fetchLibraryMemos(docId)
      if (server && server.data && Object.keys(server.data).length) memosByPage = server.data
    } catch {
      // best-effort
    }
  }
  return { annotationsByPage, memosByPage }
}

// 메모 객체에는 별도 createdAt 필드가 없고, id가 `memo_${Date.now()}` 형태로
// 생성 시각을 담고 있다(main.js createFloatingMemoForSentence 참고) - 이게
// 유일한 시각 정보라 여기서 역산한다. 하이라이트/언더라인 객체는 애초에
// 시각 필드 자체가 저장되지 않으므로(타입/텍스트/오프셋/색만 저장) 카드에
// 시간을 표시할 수 없다 - 페이지 배지만 노출한다.
function memoTimestamp(memo) {
  const m = /^memo_(\d+)/.exec(String((memo && memo.id) || ''))
  if (!m) return null
  const d = new Date(Number(m[1]))
  return isNaN(d.getTime()) ? null : d
}

function formatTs(d) {
  if (!d) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 논문 하나에 대한 메모/하이라이트/언더라인을 모두 모아 화면에서 바로 쓸 수
// 있는 형태로 집계한다.
async function buildPaperEntry(doc) {
  const { annotationsByPage, memosByPage } = await getDocAnnotationsAndMemos(doc.id)

  const memoItems = []
  const highlightItems = []
  const underlineItems = []

  Object.keys(memosByPage).forEach(pageKey => {
    const pageNum = parseInt(pageKey.replace('page_', ''), 10)
    if (isNaN(pageNum)) return
    ;(memosByPage[pageKey] || []).forEach(memo => {
      const ts = memoTimestamp(memo)
      const text = (memo.content && memo.content.trim()) || memo.sentenceText || '(내용 없음)'
      const color = MEMO_ACCENT_COLORS[memo.color] || null
      memoItems.push({ kind: 'memo', docId: doc.id, page: pageNum, ts, text, color })
    })
  })

  Object.keys(annotationsByPage).forEach(pageKey => {
    const pageNum = parseInt(pageKey.replace('page_', ''), 10)
    if (isNaN(pageNum)) return
    ;(annotationsByPage[pageKey] || []).forEach(ann => {
      const item = { kind: ann.type, docId: doc.id, page: pageNum, ts: null, text: ann.text || '(내용 없음)', color: ann.color || null }
      if (ann.type === 'highlight') highlightItems.push(item)
      else if (ann.type === 'underline') underlineItems.push(item)
    })
  })

  memoItems.sort((a, b) => (b.ts ? b.ts.getTime() : 0) - (a.ts ? a.ts.getTime() : 0))
  highlightItems.sort((a, b) => a.page - b.page)
  underlineItems.sort((a, b) => a.page - b.page)
  const allItems = [...memoItems, ...highlightItems, ...underlineItems].sort((a, b) => a.page - b.page)

  const meta = doc.metadata || {}
  const title = meta.title || doc.filename
  const author = meta.author || ''
  const categories = meta.categories || []
  const read = meta.read === true

  return {
    doc,
    title,
    author,
    categories,
    read,
    favorite: isFavoriteDoc(doc.id),
    counts: { memo: memoItems.length, highlight: highlightItems.length, underline: underlineItems.length },
    items: { memo: memoItems, highlight: highlightItems, underline: underlineItems, all: allItems },
  }
}

function totalCount(entry) {
  return entry.counts.memo + entry.counts.highlight + entry.counts.underline
}

// ── 좌측 논문 목록 ────────────────────────────────────────────────────
function getFilteredPapers() {
  const q = searchQuery.trim().toLowerCase()
  return allPapers.filter(entry => {
    if (filterMode === 'hasNotes' && totalCount(entry) === 0) return false
    if (filterMode === 'favorites' && !entry.favorite) return false
    if (!q) return true
    return entry.title.toLowerCase().includes(q) || (entry.author || '').toLowerCase().includes(q)
  })
}

function renderThumb(docId, sizePx) {
  return `
    <div class="notes-thumb" style="--notes-thumb-size:${sizePx}px">
      <span class="notes-thumb-fallback">${icon('fileText', Math.round(sizePx * 0.42))}</span>
      <img class="notes-thumb-img" data-doc-id="${escapeHtml(docId)}" src="/api/library/${encodeURIComponent(docId)}/cover" alt="" loading="lazy" />
    </div>
  `
}

function renderPaperRow(entry) {
  const { doc, title, author, categories, counts, favorite } = entry
  const selected = doc.id === selectedDocId
  const metaLine = [author, categories[0]].filter(Boolean).join(' · ')
  return `
    <div class="notes-paper-row ${selected ? 'selected' : ''}" data-doc-id="${escapeHtml(doc.id)}">
      ${renderThumb(doc.id, 40)}
      <div class="notes-paper-row-body">
        <div class="notes-paper-row-title">${escapeHtml(title)}</div>
        ${metaLine ? `<div class="notes-paper-row-meta">${escapeHtml(metaLine)}</div>` : ''}
        <div class="notes-paper-row-counts">
          <span class="notes-count-chip" title="하이라이트">${icon('highlighter', 12)}${counts.highlight}</span>
          <span class="notes-count-chip" title="언더라인">${icon('underline', 12)}${counts.underline}</span>
          <span class="notes-count-chip" title="메모">${icon('edit3', 12)}${counts.memo}</span>
        </div>
      </div>
      <button type="button" class="notes-fav-btn ${favorite ? 'active' : ''}" data-fav-doc-id="${escapeHtml(doc.id)}" title="${favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
        ${icon('star', 15)}
      </button>
    </div>
  `
}

function renderPaperList(root) {
  const listEl = root.querySelector('.notes-paper-list-items')
  const countAllEl = root.querySelector('.notes-filter-count-all')
  const countHasNotesEl = root.querySelector('.notes-filter-count-hasnotes')
  const countFavEl = root.querySelector('.notes-filter-count-fav')
  if (countAllEl) countAllEl.textContent = String(allPapers.length)
  if (countHasNotesEl) countHasNotesEl.textContent = String(allPapers.filter(e => totalCount(e) > 0).length)
  if (countFavEl) countFavEl.textContent = String(allPapers.filter(e => e.favorite).length)

  const filtered = getFilteredPapers()
  if (!listEl) return

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="notes-empty"><p>${allPapers.length === 0 ? '저장된 논문이 없습니다' : '조건에 맞는 논문이 없습니다'}</p></div>`
    return
  }
  listEl.innerHTML = filtered.map(renderPaperRow).join('')
  bindThumbFallback(listEl)
}

function bindThumbFallback(container) {
  container.querySelectorAll('.notes-thumb-img').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none' }, { once: true })
  })
}

// ── 우측 상세 패널 ────────────────────────────────────────────────────
const SUBTABS = [
  { key: 'summary', label: '요약', icon: 'lightbulb' },
  { key: 'memo', label: '메모', icon: 'edit3' },
  { key: 'highlight', label: '하이라이트', icon: 'highlighter' },
  { key: 'underline', label: '언더라인', icon: 'underline' },
  { key: 'all', label: '모든 주석', icon: 'layers' },
]

const EMPTY_MESSAGES = {
  memo: '이 논문에 남긴 메모가 없습니다.',
  highlight: '하이라이트한 내용이 없습니다.',
  underline: '밑줄 친 내용이 없습니다.',
  all: '아직 저장된 주석이 없습니다.',
}

// 요약 탭: primer(읽기 전 브리핑)를 그대로 가져와 뷰어의 브리핑 모달과 같은
// 내용(핵심 한 줄, 스스로 답해볼 질문, 대표 Figure, 체크리스트, 연구 계보,
// 파인만 설명, 실험 흐름, 용어집)을 한 화면에 쭉 이어서 보여준다(Notes는
// 탭 하나짜리 읽기 전용 뷰라 모달처럼 소탭으로 나누지 않고 전부 스택한다).
// 관련 논문 그래프(citation_graph)는 클릭 시 다른 논문 뷰어로 이동하는
// 상호작용용 기능이라 "읽기 전용 열람"이라는 이 페이지 성격과 맞지 않아
// 제외한다. LLM 호출 비용이 있어 탭을 열 때만 fetchPrimer()를 호출하고
// summaryCache에 원본 데이터를 담아 재방문 시 재사용한다.
function primerHasAnyContent(data) {
  return !!(
    data.hook || data.lineage || data.feynman || data.figure ||
    (data.questions && data.questions.length) ||
    (data.checklist && data.checklist.length) ||
    (data.experiment_flow && data.experiment_flow.length) ||
    (data.glossary && data.glossary.length)
  )
}

function renderPrimerSection(labelIcon, labelText, innerHtml) {
  return `
    <div class="notes-primer-section">
      <div class="primer-label">
        <span class="primer-label-icon">${icon(labelIcon, 13)}</span>
        <span>${labelText}</span>
      </div>
      ${innerHtml}
    </div>
  `
}

function renderSummaryTabContent(docId) {
  const cached = summaryCache.get(docId)
  if (!cached || cached.status === 'loading') {
    return `<div class="notes-summary-loading">${icon('refreshCw', 15)}<span>읽기 전 브리핑을 불러오는 중...</span></div>`
  }
  if (cached.status === 'error') {
    return `<div class="notes-empty"><p style="color:var(--error)">브리핑을 불러오지 못했습니다.</p></div>`
  }
  const data = cached.data || {}
  if (!primerHasAnyContent(data)) {
    return `<div class="notes-empty"><p>이 논문에는 아직 생성된 브리핑이 없습니다.<br/>뷰어에서 논문을 열면 자동으로 생성됩니다.</p></div>`
  }

  const parts = []

  if (data.hook) {
    parts.push(`
      <div class="primer-hook-section">
        <span class="primer-hook-quote">&ldquo;</span>
        <p class="primer-hook-text">${formatTranslationHtml(data.hook)}</p>
      </div>
    `)
  }

  const questions = data.questions || []
  if (questions.length) {
    parts.push(renderPrimerSection('helpCircle', '읽기 전에 스스로 답해보기',
      `<ol class="primer-list">${questions.map(q => `<li>${formatTranslationHtml(q)}</li>`).join('')}</ol>`))
  }

  if (data.figure) {
    parts.push(renderPrimerSection('image', '핵심 그림 먼저 보기',
      `<img class="primer-figure-img" src="/api/library/${encodeURIComponent(docId)}/primer-figure?ts=${Date.now()}" alt="대표 Figure" />`))
  }

  const checklist = data.checklist || []
  if (checklist.length) {
    parts.push(renderPrimerSection('listChecks', '읽으면서 확인할 것',
      `<ul class="primer-checklist">${checklist.map(c => `<li>${formatTranslationHtml(c)}</li>`).join('')}</ul>`))
  }

  if (data.lineage) {
    parts.push(renderPrimerSection('activity', '이 논문의 연구 계보',
      `<p class="primer-lineage-text">${formatTranslationHtml(data.lineage)}</p>`))
  }

  if (data.feynman) {
    parts.push(renderPrimerSection('smile', '파인만 기법으로 쉽게 이해하기',
      `<p class="primer-feynman-text">${formatTranslationHtml(data.feynman)}</p>`))
  }

  const flow = data.experiment_flow || []
  if (flow.length) {
    const stepsHtml = flow.map((step, i) => `
      <li class="primer-experiment-step">
        <div class="primer-experiment-step-num">${i + 1}</div>
        <div class="primer-experiment-step-body">
          <div class="primer-experiment-row"><span class="primer-experiment-tag">가설</span><span>${formatTranslationHtml(step.hypothesis)}</span></div>
          <div class="primer-experiment-row"><span class="primer-experiment-tag">방법</span><span>${formatTranslationHtml(step.method)}</span></div>
          <div class="primer-experiment-row"><span class="primer-experiment-tag">결과</span><span>${formatTranslationHtml(step.result)}</span></div>
        </div>
      </li>
    `).join('')
    parts.push(renderPrimerSection('flaskConical', '가설 → 실험 → 결과 흐름',
      `<ol class="primer-experiment-flow">${stepsHtml}</ol>`))
  }

  const glossary = data.glossary || []
  if (glossary.length) {
    const itemsHtml = glossary.map(g => `
      <details class="primer-glossary-item">
        <summary class="primer-glossary-term">${formatTranslationHtml(g.term)}</summary>
        <p class="primer-glossary-def">${formatTranslationHtml(g.definition)}</p>
      </details>
    `).join('')
    parts.push(renderPrimerSection('book', '이 논문이 새로 정의한 용어',
      `<div class="primer-glossary">${itemsHtml}</div>`))
  }

  return `<div class="notes-primer-content">${parts.join('')}</div>`
}

function ensureSummaryLoaded(root, docId) {
  const cached = summaryCache.get(docId)
  if (cached && (cached.status === 'ready' || cached.status === 'error')) return
  if (cached && cached.status === 'loading') return
  summaryCache.set(docId, { status: 'loading' })
  fetchPrimer(docId).then(data => {
    summaryCache.set(docId, { status: 'ready', data })
  }).catch(err => {
    console.error('Notes 요약 로드 실패:', err)
    summaryCache.set(docId, { status: 'error' })
  }).finally(() => {
    // 로드되는 동안 사용자가 다른 논문/탭으로 이동했을 수 있으니, 여전히
    // 같은 문서의 요약 탭을 보고 있을 때만 다시 그린다.
    if (selectedDocId === docId && activeSubtab === 'summary') {
      const contentEl = root.querySelector('.notes-tab-content')
      if (contentEl) {
        contentEl.innerHTML = renderSummaryTabContent(docId)
        applyKatexToElement(contentEl)
      }
    }
  })
}

function renderAnnotationCard(item) {
  const iconName = item.kind === 'memo' ? 'edit3' : item.kind === 'highlight' ? 'highlighter' : 'underline'
  const canExpand = item.text.trim().length > 220
  const tsHtml = item.ts ? `<span class="notes-card-ts">${escapeHtml(formatTs(item.ts))}</span>` : ''
  const style = item.color ? ` style="--notes-item-accent:${escapeHtml(item.color)}"` : ''
  return `
    <div class="notes-annotation-card notes-card-${item.kind} ${canExpand ? 'notes-card-collapsible' : ''}"${style} data-doc-id="${escapeHtml(item.docId)}">
      <div class="notes-card-top">
        <span class="notes-card-badge">${icon(iconName, 12)}p. ${item.page}</span>
        ${tsHtml}
      </div>
      <div class="notes-card-text">${formatMarkdownLatexHtml(item.text)}</div>
      ${canExpand ? `<button type="button" class="notes-card-expand-btn">${icon('chevronDown', 12)}<span>더보기</span></button>` : ''}
    </div>
  `
}

function renderTabContent(entry) {
  if (activeSubtab === 'summary') return renderSummaryTabContent(entry.doc.id)
  const items = entry.items[activeSubtab] || []
  if (items.length === 0) {
    return `<div class="notes-empty"><p>${EMPTY_MESSAGES[activeSubtab]}</p></div>`
  }
  return `<div class="notes-card-list">${items.map(renderAnnotationCard).join('')}</div>`
}

function renderDetail(root) {
  const detailEl = root.querySelector('.notes-detail')
  if (!detailEl) return

  const entry = allPapers.find(e => e.doc.id === selectedDocId)
  if (!entry) {
    detailEl.innerHTML = `
      <div class="notes-detail-empty">
        ${icon('fileText', 40)}
        <p>왼쪽 목록에서 논문을 선택하면<br/>메모와 하이라이트를 확인할 수 있습니다.</p>
      </div>
    `
    return
  }

  const metaLine = [entry.author, entry.categories.join(', ')].filter(Boolean).join(' · ')

  detailEl.innerHTML = `
    <div class="notes-paper-header">
      ${renderThumb(entry.doc.id, 56)}
      <div class="notes-paper-header-info">
        <h2 class="notes-paper-header-title">${escapeHtml(entry.title)}</h2>
        ${metaLine ? `<div class="notes-paper-header-meta">${escapeHtml(metaLine)}</div>` : ''}
      </div>
      <div class="notes-paper-header-actions">
        ${entry.read ? `<span class="notes-read-badge">${icon('checkCircle', 13)}읽음</span>` : ''}
        <button type="button" class="notes-fav-btn notes-fav-btn-lg ${entry.favorite ? 'active' : ''}" data-fav-doc-id="${escapeHtml(entry.doc.id)}" title="${entry.favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
          ${icon('star', 15)}
        </button>
        <button type="button" class="notes-open-viewer-btn" data-doc-id="${escapeHtml(entry.doc.id)}">
          ${icon('externalLink', 13)}<span>뷰어에서 열기</span>
        </button>
      </div>
    </div>

    <div class="notes-tabs">
      ${SUBTABS.map(t => `
        <button type="button" class="notes-tab-btn ${activeSubtab === t.key ? 'active' : ''}" data-subtab="${t.key}">
          ${icon(t.icon, 13)}<span>${t.label}</span>
          ${t.key === 'summary' ? '' : `<span class="notes-tab-count">${t.key === 'all' ? totalCount(entry) : entry.counts[t.key]}</span>`}
        </button>
      `).join('')}
    </div>

    <div class="notes-tab-content">${renderTabContent(entry)}</div>
  `
  bindThumbFallback(detailEl)
  applyKatexToElement(detailEl)

  if (activeSubtab === 'summary') ensureSummaryLoaded(root, entry.doc.id)
}

// ── 이벤트 위임 (root는 renderNotesPage()마다 새로 생기지만, root 자체에
// 한 번만 걸어두면 내부 재렌더링(검색/필터/탭 전환)에도 계속 살아있다) ──
function attachListeners(root) {
  const searchInput = root.querySelector('.notes-search-input')
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value
      renderPaperList(root)
    })
  }

  root.querySelectorAll('.notes-filter-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.filter
      if (mode === filterMode) return
      filterMode = mode
      root.querySelectorAll('.notes-filter-tab-btn').forEach(b => b.classList.toggle('active', b === btn))
      renderPaperList(root)
    })
  })

  root.addEventListener('click', (e) => {
    // 즐겨찾기 별 토글 (목록 행/상세 헤더 공용) - 논문 선택보다 먼저 처리해서
    // 별을 눌러도 그 논문이 함께 선택되지 않도록 한다.
    const favBtn = e.target.closest('.notes-fav-btn')
    if (favBtn) {
      const docId = favBtn.dataset.favDocId
      if (docId) {
        const nowFav = toggleFavoriteDoc(docId)
        const entry = allPapers.find(en => en.doc.id === docId)
        if (entry) entry.favorite = nowFav
        renderPaperList(root)
        if (selectedDocId === docId) renderDetail(root)
      }
      return
    }

    // 좌측 목록에서 논문 선택
    const row = e.target.closest('.notes-paper-row')
    if (row) {
      const docId = row.dataset.docId
      if (docId && docId !== selectedDocId) {
        selectedDocId = docId
        renderPaperList(root)
        renderDetail(root)
      }
      return
    }

    // 우측 상세: 서브탭 전환
    const tabBtn = e.target.closest('.notes-tab-btn')
    if (tabBtn) {
      const key = tabBtn.dataset.subtab
      if (key && key !== activeSubtab) {
        activeSubtab = key
        renderDetail(root)
      }
      return
    }

    // 카드 "더보기/접기" 토글 (뷰어 이동으로 전파되지 않도록 별도 처리)
    const expandBtn = e.target.closest('.notes-card-expand-btn')
    if (expandBtn) {
      const card = expandBtn.closest('.notes-annotation-card')
      if (!card) return
      const expanded = card.classList.toggle('expanded')
      expandBtn.innerHTML = `${icon(expanded ? 'chevronUp' : 'chevronDown', 12)}<span>${expanded ? '접기' : '더보기'}</span>`
      return
    }

    // 주석 카드 클릭 → 뷰어에서 해당 논문 열기(뷰어 라우터는 정확한 페이지
    // 이동을 위한 쿼리 파라미터를 지원하지 않아 문서까지만 이동한다)
    const card = e.target.closest('.notes-annotation-card')
    if (card && card.dataset.docId) {
      location.hash = 'viewer?id=' + encodeURIComponent(card.dataset.docId)
      return
    }

    // "뷰어에서 열기" 버튼
    const openBtn = e.target.closest('.notes-open-viewer-btn')
    if (openBtn && openBtn.dataset.docId) {
      location.hash = 'viewer?id=' + encodeURIComponent(openBtn.dataset.docId)
    }
  })
}

function shellHtml() {
  return `
    <div class="notes-page-inner">
      <p class="notes-page-subtitle">논문별 메모, 하이라이트, 언더라인을 확인하세요.</p>
      <div class="notes-layout">
        <aside class="notes-sidebar">
          <div class="notes-sidebar-header">
            <h3>논문 목록</h3>
          </div>
          <div class="notes-search-box">
            ${icon('search', 14)}
            <input type="text" class="notes-search-input" placeholder="논문 검색..." />
          </div>
          <div class="notes-filter-tabs">
            <button type="button" class="notes-filter-tab-btn active" data-filter="all">전체 <span class="notes-filter-count-all">0</span></button>
            <button type="button" class="notes-filter-tab-btn" data-filter="hasNotes">메모 있음 <span class="notes-filter-count-hasnotes">0</span></button>
            <button type="button" class="notes-filter-tab-btn" data-filter="favorites">${icon('star', 12)} 즐겨찾기 <span class="notes-filter-count-fav">0</span></button>
          </div>
          <div class="notes-paper-list-items">
            <div class="notes-empty"><p>불러오는 중...</p></div>
          </div>
        </aside>
        <section class="notes-detail">
          <div class="notes-detail-empty">
            ${icon('fileText', 40)}
            <p>불러오는 중...</p>
          </div>
        </section>
      </div>
    </div>
  `
}

export async function renderNotesPage() {
  const root = document.getElementById('page-notes')
  if (!root) return
  const generation = ++renderGeneration
  const isCurrent = () => generation === renderGeneration && root.classList.contains('active')

  root.innerHTML = shellHtml()
  attachListeners(root)

  let docs = []
  try {
    const data = await fetchLibrary()
    docs = data.documents || []
  } catch (err) {
    console.error('Notes 페이지: 라이브러리 조회 실패:', err)
    if (isCurrent()) {
      const listEl = root.querySelector('.notes-paper-list-items')
      if (listEl) listEl.innerHTML = `<div class="notes-empty"><p style="color:var(--error)">논문 목록을 불러오지 못했습니다</p></div>`
    }
    return
  }

  if (!isCurrent()) return

  if (docs.length === 0) {
    allPapers = []
    selectedDocId = null
    renderPaperList(root)
    renderDetail(root)
    return
  }

  const loadedPapers = await Promise.all(docs.map(buildPaperEntry))
  if (!isCurrent()) return
  allPapers = loadedPapers

  if (!selectedDocId || !allPapers.some(e => e.doc.id === selectedDocId)) {
    selectedDocId = allPapers[0].doc.id
  }

  // 필터 탭 활성 상태를 모듈 상태와 동기화(재방문 시 이전 필터 유지)
  root.querySelectorAll('.notes-filter-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filterMode))
  const searchInput = root.querySelector('.notes-search-input')
  if (searchInput) searchInput.value = searchQuery

  renderPaperList(root)
  renderDetail(root)
}
