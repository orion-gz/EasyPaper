// AI Chats 워크스페이스 페이지 — 논문별(단일 논문) AI 어시스턴트 채팅 세션 목록
// 검색 / 탭 필터 / 정렬 / 표·카드 보기 전환 / 페이지네이션을 지원한다.
// 데이터 원본: getChatSessionsAPI() → { sessions: [{ doc_id, title, last_message_at }] }
// "최근 메시지" 미리보기는 세션 목록 API에 없으므로, 세션별로 getChatHistoryAPI(doc_id)를
// (동시 실행 개수를 제한하며) 추가로 불러와 마지막 메시지 내용을 채운다.

import '../styles/ai-chats.css'
import { icon } from '../icons.js'
import { getChatSessionsAPI, getChatHistoryAPI } from '../api.js'
import { formatMarkdownLatexHtml, applyKatexToElement } from '../textFormat.js'

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

const PAGE_SIZE = 8
const RECENT_MS = 24 * 60 * 60 * 1000       // "최근 대화" 기준: 24시간 이내
const ACTIVE_MS = 7 * 24 * 60 * 60 * 1000   // "활성" 기준: 7일 이내
const PREVIEW_CONCURRENCY = 6
let renderGeneration = 0

function formatRelativeTime(isoString) {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return '-'
  const diffMs = Date.now() - date.getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return '방금 전'
  if (min < 60) return `${min}분 전`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}시간 전`
  const day = Math.floor(hour / 24)
  if (day === 1) return '어제'
  if (day < 7) return `${day}일 전`
  return date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatFullTime(isoString) {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// items를 limit개씩 동시 실행하며 fn(item)을 적용한다 (세션이 많을 때 서버에 한 번에
// 수십~수백 개 요청이 몰리는 것을 막기 위함).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++
      try {
        results[idx] = await fn(items[idx], idx)
      } catch {
        results[idx] = null
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

export async function renderAiChatsPage() {
  const container = document.getElementById('page-chats')
  if (!container) return
  const generation = ++renderGeneration
  const isCurrent = () => generation === renderGeneration && container.classList.contains('active')

  container.innerHTML = `
    <div class="aic-page">
      <div class="aic-header">
        <p class="aic-subtitle">논문별 AI 채팅 세션을 관리하고 이어서 대화하세요.</p>
      </div>

      <div class="aic-controls">
        <div class="aic-tabs" id="aic-tabs"></div>
        <div class="aic-controls-right">
          <div class="aic-sort-wrap">
            <button type="button" id="aic-sort-btn" class="aic-sort-btn">
              <span id="aic-sort-label">최근 업데이트순</span>
              ${icon('chevronDown', 14)}
            </button>
            <div id="aic-sort-menu" class="aic-sort-menu hidden">
              <button type="button" class="aic-sort-option active" data-sort="updated">최근 업데이트순</button>
              <button type="button" class="aic-sort-option" data-sort="title">제목순 (가나다)</button>
            </div>
          </div>
          <div class="aic-view-toggle" id="aic-view-toggle">
            <button type="button" class="aic-view-btn active" data-view="table" title="표로 보기">${icon('list', 15)}</button>
            <button type="button" class="aic-view-btn" data-view="card" title="카드로 보기">${icon('grid', 15)}</button>
          </div>
        </div>
      </div>

      <div id="aic-body" class="aic-body"></div>
      <div id="aic-pagination" class="aic-pagination"></div>
    </div>
  `

  const searchInput = container.querySelector('#aic-search-input')
  const tabsEl = container.querySelector('#aic-tabs')
  const bodyEl = container.querySelector('#aic-body')
  const paginationEl = container.querySelector('#aic-pagination')
  const sortBtn = container.querySelector('#aic-sort-btn')
  const sortLabel = container.querySelector('#aic-sort-label')
  const sortMenu = container.querySelector('#aic-sort-menu')
  const viewToggle = container.querySelector('#aic-view-toggle')

  // ── 페이지 인스턴스 로컬 상태 (재방문 시 renderAiChatsPage()가 다시 호출되어
  //    이 클로저 전체가 새로 만들어지므로, 별도 초기화 로직 없이 항상 초기값으로 시작한다) ──
  const state = {
    sessions: [],
    previews: new Map(), // doc_id -> { text, error }
    searchQuery: '',
    activeTab: 'all',
    sortMode: 'updated',
    viewMode: 'table',
    currentPage: 1,
    loading: true,
    loadError: null,
  }

  const TABS = [
    { id: 'all', label: '전체' },
    { id: 'active', label: '활성' },
    { id: 'recent', label: '최근 대화' },
  ]

  function tabMatches(tabId, session) {
    if (tabId === 'all') return true
    const t = session.last_message_at ? new Date(session.last_message_at).getTime() : 0
    const diff = Date.now() - t
    if (tabId === 'recent') return diff <= RECENT_MS
    if (tabId === 'active') return diff <= ACTIVE_MS
    return true
  }

  function getFilteredSorted() {
    const q = state.searchQuery.trim().toLowerCase()
    let list = state.sessions.filter(s => tabMatches(state.activeTab, s))
    if (q) list = list.filter(s => (s.title || '').toLowerCase().includes(q))
    list = list.slice()
    if (state.sortMode === 'title') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'))
    } else {
      list.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))
    }
    return list
  }

  function renderTabs() {
    tabsEl.innerHTML = TABS.map(tab => {
      const count = state.sessions.filter(s => tabMatches(tab.id, s)).length
      const active = state.activeTab === tab.id ? ' active' : ''
      return `<button type="button" class="aic-tab-btn${active}" data-tab="${tab.id}">${tab.label} <span class="aic-tab-count">${count}</span></button>`
    }).join('')
    tabsEl.querySelectorAll('.aic-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab
        state.currentPage = 1
        renderTabs()
        renderBody()
        renderPagination()
      })
    })
  }

  function previewCellHtml(session) {
    const p = state.previews.get(session.doc_id)
    if (!p) return `<span class="aic-preview-loading">불러오는 중...</span>`
    if (p.error || !p.text) return `<span class="aic-preview-empty">-</span>`
    return formatMarkdownLatexHtml(p.text)
  }

  function actionsHtml(session) {
    return `
      <button type="button" class="aic-action-btn aic-action-primary" data-action="chat" data-doc="${escapeHtml(session.doc_id)}" title="대화 열기">
        ${icon('messageCircle', 14)} 대화
      </button>
      <button type="button" class="aic-action-btn" data-action="viewer" data-doc="${escapeHtml(session.doc_id)}" title="뷰어 열기">
        ${icon('bookOpen', 14)} 뷰어
      </button>
    `
  }

  function bindActionButtons(root) {
    root.querySelectorAll('[data-action="chat"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.doc
        location.hash = 'chat?id=' + encodeURIComponent(id)
      })
    })
    root.querySelectorAll('[data-action="viewer"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.doc
        location.hash = 'viewer?id=' + encodeURIComponent(id)
      })
    })
  }

  function renderTable(items) {
    return `
      <div class="aic-table-wrap">
        <table class="aic-table">
          <thead>
            <tr>
              <th class="aic-col-paper">논문</th>
              <th class="aic-col-message">최근 메시지</th>
              <th class="aic-col-updated">마지막 대화</th>
              <th class="aic-col-actions">작업</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(session => `
              <tr>
                <td class="aic-col-paper">
                  <div class="aic-paper-cell">
                    <div class="aic-paper-icon">${icon('fileText', 17)}</div>
                    <div class="aic-paper-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</div>
                  </div>
                </td>
                <td class="aic-col-message"><div class="aic-preview" data-preview-doc="${escapeHtml(session.doc_id)}">${previewCellHtml(session)}</div></td>
                <td class="aic-col-updated" title="${escapeHtml(formatFullTime(session.last_message_at))}">${formatRelativeTime(session.last_message_at)}</td>
                <td class="aic-col-actions"><div class="aic-actions">${actionsHtml(session)}</div></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `
  }

  function renderCards(items) {
    return `
      <div class="aic-card-grid">
        ${items.map(session => `
          <div class="aic-card">
            <div class="aic-card-top">
              <div class="aic-paper-icon">${icon('fileText', 17)}</div>
              <span class="aic-card-updated" title="${escapeHtml(formatFullTime(session.last_message_at))}">${formatRelativeTime(session.last_message_at)}</span>
            </div>
            <div class="aic-card-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</div>
            <div class="aic-card-preview" data-preview-doc="${escapeHtml(session.doc_id)}">${previewCellHtml(session)}</div>
            <div class="aic-actions aic-card-actions">${actionsHtml(session)}</div>
          </div>
        `).join('')}
      </div>
    `
  }

  function renderBody() {
    if (state.loading) {
      bodyEl.innerHTML = `<div class="aic-state"><div class="aic-spinner"></div><p>채팅 세션을 불러오는 중...</p></div>`
      return
    }
    if (state.loadError) {
      bodyEl.innerHTML = `
        <div class="aic-state aic-state-error">
          <div class="aic-state-icon">${icon('alertTriangle', 32)}</div>
          <p>채팅 세션을 불러오지 못했습니다</p>
          <button type="button" class="aic-retry-btn" id="aic-retry-btn">다시 시도</button>
        </div>
      `
      const retryBtn = bodyEl.querySelector('#aic-retry-btn')
      if (retryBtn) retryBtn.addEventListener('click', () => load())
      return
    }

    const filteredSorted = getFilteredSorted()
    if (state.sessions.length === 0) {
      bodyEl.innerHTML = `
        <div class="aic-state">
          <div class="aic-state-icon">${icon('messageCircle', 32)}</div>
          <p>AI와 나눈 대화가 없습니다</p>
          <p class="aic-state-sub">논문 뷰어에서 AI 어시스턴트에게 질문을 시작해 보세요</p>
        </div>
      `
      return
    }
    if (filteredSorted.length === 0) {
      bodyEl.innerHTML = `
        <div class="aic-state">
          <div class="aic-state-icon">${icon('search', 32)}</div>
          <p>조건에 맞는 채팅 세션이 없습니다</p>
        </div>
      `
      return
    }

    const totalPages = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE))
    if (state.currentPage > totalPages) state.currentPage = totalPages
    const start = (state.currentPage - 1) * PAGE_SIZE
    const pageItems = filteredSorted.slice(start, start + PAGE_SIZE)

    bodyEl.innerHTML = state.viewMode === 'table' ? renderTable(pageItems) : renderCards(pageItems)
    bindActionButtons(bodyEl)
    applyKatexToElement(bodyEl)
  }

  function renderPagination() {
    if (state.loading || state.loadError || state.sessions.length === 0) {
      paginationEl.innerHTML = ''
      return
    }
    const filteredSorted = getFilteredSorted()
    const totalPages = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE))
    if (totalPages <= 1) {
      paginationEl.innerHTML = ''
      return
    }
    const cur = state.currentPage
    const pages = []
    const addPage = n => { if (!pages.includes(n) && n >= 1 && n <= totalPages) pages.push(n) }
    addPage(1)
    addPage(cur - 1); addPage(cur); addPage(cur + 1)
    addPage(totalPages)
    pages.sort((a, b) => a - b)

    let html = `<button type="button" class="aic-page-btn aic-page-nav" id="aic-page-prev" ${cur === 1 ? 'disabled' : ''} aria-label="이전 페이지">‹</button>`
    let prev = 0
    for (const p of pages) {
      if (prev && p - prev > 1) html += `<span class="aic-page-ellipsis">…</span>`
      html += `<button type="button" class="aic-page-btn${p === cur ? ' active' : ''}" data-page="${p}">${p}</button>`
      prev = p
    }
    html += `<button type="button" class="aic-page-btn aic-page-nav" id="aic-page-next" ${cur === totalPages ? 'disabled' : ''} aria-label="다음 페이지">›</button>`

    paginationEl.innerHTML = html
    paginationEl.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.currentPage = Number(btn.dataset.page)
        renderBody()
        renderPagination()
      })
    })
    const prevBtn = paginationEl.querySelector('#aic-page-prev')
    const nextBtn = paginationEl.querySelector('#aic-page-next')
    if (prevBtn) prevBtn.addEventListener('click', () => {
      if (state.currentPage > 1) { state.currentPage--; renderBody(); renderPagination() }
    })
    if (nextBtn) nextBtn.addEventListener('click', () => {
      if (state.currentPage < totalPages) { state.currentPage++; renderBody(); renderPagination() }
    })
  }

  function updatePreviewInDom(docId) {
    container.querySelectorAll(`[data-preview-doc="${CSS.escape(docId)}"]`).forEach(el => {
      el.innerHTML = previewCellHtml({ doc_id: docId })
      applyKatexToElement(el)
    })
  }

  async function loadPreviews(sessions) {
    await mapWithConcurrency(sessions, PREVIEW_CONCURRENCY, async (session) => {
      try {
        const data = await getChatHistoryAPI(session.doc_id)
        if (!isCurrent()) return
        const history = data.history || []
        const last = history.length ? history[history.length - 1] : null
        state.previews.set(session.doc_id, { text: last ? last.content : '', error: false })
      } catch {
        if (!isCurrent()) return
        state.previews.set(session.doc_id, { text: '', error: true })
      }
      updatePreviewInDom(session.doc_id)
    })
  }

  async function load() {
    state.loading = true
    state.loadError = null
    renderBody()
    renderPagination()
    try {
      const data = await getChatSessionsAPI()
      if (!isCurrent()) return
      state.sessions = data.sessions || []
      state.loading = false
      renderTabs()
      renderBody()
      renderPagination()
      // 목록 API에는 마지막 메시지 내용이 없으므로, 세션별 히스토리를 추가로 불러와
      // 표시된 행의 미리보기 텍스트만 점진적으로 채워 넣는다.
      loadPreviews(state.sessions)
    } catch (err) {
      if (!isCurrent()) return
      console.error('AI 채팅 세션 목록 로드 실패:', err)
      state.loading = false
      state.loadError = err
      renderTabs()
      renderBody()
      renderPagination()
    }
  }

  // ── 정적 컨트롤 이벤트 바인딩 ──
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value
      state.currentPage = 1
      renderBody()
      renderPagination()
    })
  }

  sortBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    sortMenu.classList.toggle('hidden')
  })
  sortMenu.querySelectorAll('.aic-sort-option').forEach(opt => {
    opt.addEventListener('click', () => {
      state.sortMode = opt.dataset.sort
      sortLabel.textContent = opt.textContent
      sortMenu.querySelectorAll('.aic-sort-option').forEach(o => o.classList.toggle('active', o === opt))
      sortMenu.classList.add('hidden')
      renderBody()
      renderPagination()
    })
  })
  // 페이지를 재방문할 때마다 renderAiChatsPage()가 새로 호출되며 이전 DOM은
  // container.innerHTML 교체로 사라지지만, document 리스너는 자동으로 제거되지
  // 않으므로 매번 쌓이지 않도록 sortBtn이 더는 문서에 붙어있지 않으면 스스로 해제한다.
  function handleOutsideClick(e) {
    if (!sortBtn.isConnected) {
      document.removeEventListener('click', handleOutsideClick)
      return
    }
    if (!sortMenu.contains(e.target) && e.target !== sortBtn && !sortBtn.contains(e.target)) {
      sortMenu.classList.add('hidden')
    }
  }
  document.addEventListener('click', handleOutsideClick)

  viewToggle.querySelectorAll('.aic-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view
      viewToggle.querySelectorAll('.aic-view-btn').forEach(b => b.classList.toggle('active', b === btn))
      renderBody()
    })
  })

  renderTabs()
  await load()
}
