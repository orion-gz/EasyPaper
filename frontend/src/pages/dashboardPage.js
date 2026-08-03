// 대시보드 페이지 — 워크스페이스 셸의 #page-dashboard 컨테이너를 전담 렌더링한다.
// 모든 위젯은 실제 백엔드 데이터(/api/library/dashboard, /timeline, /library,
// /graph, /graph/recommendations, /library/reading-stats)에서 가져오거나 그
// 위에서 클라이언트단으로 정직하게 계산한 값만 사용한다 - 뒷받침할 데이터가
// 없는 지표(연구 점수 등)는 만들어내지 않고 통째로 생략했다(자세한 내용은
// 각 렌더 함수 주석 참고). 읽기 시간은 main.js의 읽기 시간 하트비트
// (뷰어/비교 화면이 보이고 포커스된 동안 적립 → 서버 전송)가 쌓은 실측치를
// fetchReadingTimeStats()로 가져온 것이다.
import './../styles/dashboard.css'
import { fetchLibraryDashboard, fetchLibraryTimeline, fetchReadingRecommendations, fetchLibrary, fetchLibraryGraph, fetchReadingTimeStats } from '../library.js'
import { icon } from '../icons.js'

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function emptyNote(text) {
  return `<p class="dash-empty-note">${escapeHtml(text)}</p>`
}

function formatNumber(n) {
  return (n || 0).toLocaleString('ko-KR')
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return s > 0 ? `${s}s` : '0m'
}

function sumSecondsInDays(byDay, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let total = 0
  for (const [day, seconds] of Object.entries(byDay || {})) {
    const t = new Date(`${day}T00:00:00`).getTime()
    if (!Number.isNaN(t) && t >= cutoff) total += seconds
  }
  return total
}

// ── 시간 계산 헬퍼 ── 전부 백엔드가 이미 내려주는 ISO 타임스탬프(timeline
// events, metadata.read_at)를 그대로 재사용한다. 새 저장소나 서버 집계가
// 필요 없다.
function isWithinDays(iso, days) {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return t >= Date.now() - days * 24 * 60 * 60 * 1000
}

function relativeTimeKo(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diffMs = Date.now() - t
  if (diffMs < 60000) return '방금 전'
  const min = Math.floor(diffMs / 60000)
  if (min < 60) return `${min}분 전`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}시간 전`
  const day = Math.floor(hour / 24)
  if (day === 1) return '어제'
  if (day < 7) return `${day}일 전`
  const week = Math.floor(day / 7)
  if (week < 5) return `${week}주 전`
  return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })
}

function dateKey(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

// 활동(업로드/읽음/질문/메모) 타임스탬프가 찍힌 날짜들을 모아 오늘(또는
// 어제, 아직 오늘 활동을 안 했을 수 있으니)부터 거슬러 며칠 연속으로
// 활동이 있었는지 센다 - 순수하게 실제 이벤트 날짜만으로 계산.
function computeStreakDays(events) {
  const dates = new Set()
  events.forEach(e => { const k = dateKey(e.timestamp); if (k) dates.add(k) })
  if (dates.size === 0) return 0
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  let cursor = null
  if (dates.has(dateKey(today))) cursor = today
  else if (dates.has(dateKey(yesterday))) cursor = yesterday
  else return 0
  const c = new Date(cursor)
  let streak = 0
  while (dates.has(dateKey(c))) {
    streak++
    c.setDate(c.getDate() - 1)
  }
  return streak
}

function countEventsInDays(events, type, days) {
  return events.filter(e => e.type === type && isWithinDays(e.timestamp, days)).length
}

// "이번 주 읽은 페이지"는 서버에 별도 집계가 없어, 이번 주 안에 읽음
// 처리(read_at)된 논문들의 total_pages 합으로 근사한다 - 실존하는 필드만
// 조합한 값이라 근거가 있는 근사치다.
function pagesReadInDays(docs, days) {
  return docs.reduce((sum, d) => {
    const meta = d.metadata || {}
    if (meta.read && meta.read_at && isWithinDays(meta.read_at, days)) return sum + (d.total_pages || 0)
    return sum
  }, 0)
}

function truncateLabel(s, n) {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// ── 통계 카드 ──────────────────────────────────────────────────────────
const STAT_DEFS = [
  { key: 'total_papers', label: '논문', iconName: 'bookOpen', tint: 1, weekly: (events) => countEventsInDays(events, 'uploaded', 7) },
  { key: 'read_papers', label: '읽은 논문', iconName: 'checkCircle', tint: 2, weekly: (events) => countEventsInDays(events, 'read', 7) },
  { key: 'total_pages', label: '페이지', iconName: 'fileText', tint: 3, weekly: (events, docs) => pagesReadInDays(docs, 7) },
  // 개념은 생성 시각이 저장되지 않아 "이번 주 신규 개념 수"를 계산할 근거가
  // 없다 - 지어내지 않고 주간 델타 자체를 생략한다.
  { key: 'total_concepts', label: '개념', iconName: 'layers', tint: 4, weekly: null },
  { key: 'total_questions', label: '질문', iconName: 'messageCircle', tint: 5, weekly: (events) => countEventsInDays(events, 'question', 7) },
  { key: 'total_notes', label: '메모', iconName: 'edit3', tint: 6, weekly: (events) => countEventsInDays(events, 'note', 7) },
]

function renderStatCard(def, value, events, docs) {
  const delta = def.weekly ? def.weekly(events, docs) : null
  const deltaHtml = delta === null ? '' : `
    <div class="dash-stat-delta ${delta > 0 ? 'is-up' : ''}">
      ${delta > 0 ? icon('chevronUp', 11) : ''}
      <span>${delta > 0 ? `+${formatNumber(delta)}` : '0'} 이번 주</span>
    </div>
  `
  return `
    <div class="dash-stat-card">
      <div class="dash-stat-top">
        <div class="dash-stat-icon dash-tint-${def.tint}">${icon(def.iconName, 18)}</div>
        <div class="dash-stat-textwrap">
          <div class="dash-stat-label">${escapeHtml(def.label)}</div>
          <div class="dash-stat-value">${formatNumber(value)}</div>
        </div>
      </div>
      ${deltaHtml}
    </div>
  `
}

function renderStatGrid(stats, events, docs) {
  return `
    <div class="dash-stat-grid">
      ${STAT_DEFS.map(def => renderStatCard(def, stats[def.key], events, docs)).join('')}
    </div>
  `
}

// ── AI 인사이트 ── 지식 격차 감지(services/knowledge_graph.get_knowledge_gaps)
// 결과를 그대로 인사이트 문구로 노출한다 - 규칙 기반이라 매번 근거가 있다.
function renderInsightsCard(gaps) {
  const items = (gaps || []).slice(0, 4)
  return `
    <div class="dash-card dash-card-insights">
      <div class="dash-card-head"><h3>${icon('lightbulb', 15)}AI 인사이트</h3></div>
      ${items.length === 0
        ? emptyNote('아직 표시할 인사이트가 없습니다. 논문을 더 읽고 질문/메모를 남기면 여기에 제안이 쌓입니다.')
        : `<ul class="dash-insight-list">${items.map(g => `
            <li class="dash-insight-item">
              <span class="dash-insight-icon">${icon(g.type === 'no_notes_paper' ? 'edit3' : 'messageCircle', 14)}</span>
              <span>${escapeHtml(g.message)}</span>
            </li>`).join('')}</ul>`
      }
    </div>
  `
}

// ── 이번 주 활동 ── 목표(target)를 알 수 없어 mockup처럼 "goal" 대비
// 진행률을 표시하는 대신, 실제 라이브러리 전체 규모 대비 이번 주 활동
// 비중으로 바를 채운다(둘 다 실존 값).
function renderWeeklyActivityCard(events, stats, docs, readingStats) {
  const weeklySeconds = sumSecondsInDays(readingStats?.total_seconds_by_day, 7)
  const totalSeconds = readingStats?.total_seconds || 0
  const rows = [
    { iconName: 'bookOpen', label: '읽은 논문', value: countEventsInDays(events, 'read', 7), total: stats.total_papers || 0, kind: 'count' },
    { iconName: 'fileText', label: '읽은 페이지', value: pagesReadInDays(docs, 7), total: stats.total_pages || 0, kind: 'count' },
    { iconName: 'messageCircle', label: '질문', value: countEventsInDays(events, 'question', 7), total: stats.total_questions || 0, kind: 'count' },
    { iconName: 'clock', label: '읽은 시간', value: weeklySeconds, total: totalSeconds, kind: 'duration' },
  ]
  return `
    <div class="dash-card">
      <div class="dash-card-head">
        <h3>${icon('zap', 15)}이번 주 활동</h3>
        <span class="dash-card-tag">최근 7일</span>
      </div>
      <div class="dash-activity-list">
        ${rows.map(r => {
          const pct = r.total > 0 ? Math.min(100, Math.round((r.value / r.total) * 100)) : 0
          const valueText = r.kind === 'duration' ? `${formatDuration(r.value)} / ${formatDuration(r.total)}` : `${formatNumber(r.value)} / ${formatNumber(r.total)}`
          return `
            <div class="dash-activity-row">
              <div class="dash-activity-top">
                <span class="dash-activity-label">${icon(r.iconName, 13)}${escapeHtml(r.label)}</span>
                <span class="dash-activity-value">${valueText}</span>
              </div>
              <div class="dash-activity-track"><div class="dash-activity-fill" style="width:${pct}%"></div></div>
            </div>
          `
        }).join('')}
      </div>
    </div>
  `
}

// ── 연구 진행 요약 ── mockup의 "연구 점수"(0~100 + 스파크라인)는 뒷받침할
// 시계열 데이터가 전혀 없어 생략했다(임의 가중치로 점수를 지어내는 건
// 지시사항 위반). 대신 실제 타임스탬프/읽기 시간 하트비트에서 계산 가능한
// 세 지표(연구 연속일, 주간 읽기 시간, 집중 주제)를 보여준다.
function renderProgressSummaryCard(events, heatmap, readingStats) {
  const streak = computeStreakDays(events)
  const weeklySeconds = sumSecondsInDays(readingStats?.total_seconds_by_day, 7)
  const focusTopic = heatmap[0]
  return `
    <div class="dash-card">
      <div class="dash-card-head">
        <h3>${icon('award', 15)}연구 진행 요약</h3>
        <a href="#" class="dash-link" data-nav="graph">자세히 보기 ›</a>
      </div>
      <div class="dash-summary-grid">
        <div class="dash-summary-box">
          <div class="dash-summary-value">${formatNumber(streak)}<span class="dash-summary-unit">일</span></div>
          <div class="dash-summary-label">연구 연속일</div>
        </div>
        <div class="dash-summary-box">
          <div class="dash-summary-value dash-summary-value-text">${formatDuration(weeklySeconds)}</div>
          <div class="dash-summary-label">주간 읽기 시간</div>
        </div>
        <div class="dash-summary-box">
          <div class="dash-summary-value dash-summary-value-text">${focusTopic ? escapeHtml(truncateLabel(focusTopic.name, 12)) : '—'}</div>
          <div class="dash-summary-label">집중 주제</div>
        </div>
      </div>
    </div>
  `
}

// ── 최근 읽은 논문 ── 완독 표시(metadata.read)된 논문뿐 아니라 읽던 중인
// 논문(metadata.last_page - 뷰어의 책갈피 기능이 저장하는 마지막 읽은 페이지)도
// 함께 보여준다("최근 읽은" = 최근에 펼쳐본 논문). 퍼센트는 번역 진행률이 아니라
// last_page/total_pages로 계산한 실제 읽은 진행률이고, 완독 표시된 논문은
// 퍼센트 대신 "완료" 칩을 보여준다.
function renderRecentPapersCard(docs) {
  const read = docs
    .filter(d => (d.metadata && d.metadata.read) || Number.isInteger(d.metadata?.last_page))
    .sort((a, b) => new Date(b.metadata.read_at || b.created_at).getTime() - new Date(a.metadata.read_at || a.created_at).getTime())
    .slice(0, 5)

  return `
    <div class="dash-card dash-card-list">
      <div class="dash-card-head">
        <h3>${icon('bookOpen', 15)}최근 읽은 논문</h3>
        <a href="#" class="dash-link" data-nav="library">전체보기 ›</a>
      </div>
      ${read.length === 0 ? emptyNote('아직 읽음으로 표시한 논문이 없습니다.') : `
      <ul class="dash-paper-list">
        ${read.map(d => {
          const title = (d.metadata && d.metadata.title) || d.filename
          const isDone = d.metadata?.read === true
          const total = d.total_pages || 1
          const lastPage = d.metadata?.last_page
          const pct = isDone ? 100 : (Number.isInteger(lastPage) ? Math.min(100, Math.round((lastPage / total) * 100)) : 0)
          const cats = ((d.metadata && d.metadata.categories) || []).slice(0, 2)
          const progressHtml = isDone
            ? `<span class="dash-paper-done-chip">${icon('checkCircle', 12)}완료</span>`
            : `
              <div class="dash-activity-track small"><div class="dash-activity-fill" style="width:${pct}%"></div></div>
              <span class="dash-paper-pct">${pct}%</span>
            `
          return `
            <li class="dash-paper-item" data-doc-id="${escapeHtml(d.id)}">
              <img class="dash-paper-cover" src="/api/library/${encodeURIComponent(d.id)}/cover" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
              <div class="dash-paper-info">
                <div class="dash-paper-title">${escapeHtml(title)}</div>
                <div class="dash-paper-meta">
                  <span>${cats.length ? escapeHtml(cats.join(' · ')) : ''}</span>
                  <span class="dash-paper-time">${relativeTimeKo(d.metadata.read_at || d.created_at)}</span>
                </div>
                <div class="dash-paper-progress-row">
                  ${progressHtml}
                </div>
              </div>
            </li>
          `
        }).join('')}
      </ul>`}
    </div>
  `
}

// ── 최근 질문 ── dashboard.recent_questions를 그대로 사용(이미 timeline에서
// type==='question'만 골라 최신순으로 내려준다).
function renderRecentQuestionsCard(list) {
  const items = (list || []).slice(0, 5)
  return `
    <div class="dash-card dash-card-list">
      <div class="dash-card-head">
        <h3>${icon('messageCircle', 15)}최근 질문</h3>
        <a href="#" class="dash-link" data-nav="chats">전체보기 ›</a>
      </div>
      ${items.length === 0 ? emptyNote('최근 질문이 없습니다.') : `
      <ul class="dash-question-list">
        ${items.map(q => `
          <li class="dash-question-item" data-doc-id="${escapeHtml(q.doc_id || '')}" title="이 논문의 채팅으로 이동">
            <span class="dash-question-icon">${icon('messageCircle', 13)}</span>
            <div class="dash-question-body">
              <div class="dash-question-text">${escapeHtml(q.summary || '')}</div>
              <div class="dash-question-meta">${escapeHtml(q.doc_title || '')}<span class="dash-dot">·</span>${relativeTimeKo(q.timestamp)}</div>
            </div>
          </li>
        `).join('')}
      </ul>`}
    </div>
  `
}

// ── AI 추천 논문 ── /library/graph/recommendations는 LLM+OpenAlex를 여러 번
// 호출하는 무거운 엔드포인트라, 백엔드 주석과 기존 그래프 탭 구현이 그러듯
// 대시보드 진입 시 자동 호출하지 않고 사용자가 버튼을 눌렀을 때만 지연
// 로드한다(불필요한 지연/비용을 방지).
function renderRecommendationsCard() {
  return `
    <div class="dash-card dash-card-list dash-card-recs">
      <div class="dash-card-head">
        <h3>${icon('star', 15)}AI 추천 논문</h3>
        <a href="#" class="dash-link" data-nav="library">더 보기 ›</a>
      </div>
      <div class="dash-recs-body" data-recs-body>
        ${emptyNote('읽은 논문들을 바탕으로 다음에 읽으면 좋을 논문을 추천받아 보세요.')}
        <button type="button" class="dash-recs-btn" data-recs-btn>${icon('zap', 13)}추천 받기</button>
      </div>
    </div>
  `
}

// ── 개념 히트맵 ── dashboard.heatmap(paper_count+question_count 합인 score
// 기준 정렬)을 그대로 타일로 표시하고, 색 진하기는 이 목록 안에서의
// 상대적 score로 정규화한다.
function renderHeatmapCard(heatmap) {
  const maxScore = heatmap.length ? Math.max(...heatmap.map(h => h.score || 0)) : 0
  return `
    <div class="dash-card dash-card-heatmap">
      <div class="dash-card-head">
        <h3>${icon('tag', 15)}개념 히트맵</h3>
        <a href="#" class="dash-link" data-nav="graph">전체보기 ›</a>
      </div>
      ${heatmap.length === 0 ? emptyNote('아직 추출된 개념이 없습니다.') : `
      <div class="dash-heat-grid">
        ${heatmap.slice(0, 8).map(h => {
          const pct = maxScore > 0 ? Math.max(6, Math.round(((h.score || 0) / maxScore) * 100)) : 6
          return `
            <div class="dash-heat-cell" data-node-id="concept:${escapeHtml(String(h.concept_id))}" title="${escapeHtml(h.name)} · 논문 ${h.paper_count}편 · 질문 ${h.question_count}개 · 클릭하면 연구 그래프에서 보기">
              <div class="dash-heat-swatch" style="--heat-pct:${pct}%"></div>
              <div class="dash-heat-label">${escapeHtml(h.name)}</div>
              <div class="dash-heat-count">${formatNumber(h.score)}</div>
            </div>
          `
        }).join('')}
      </div>
      <div class="dash-heat-legend"><span>낮음</span><div class="dash-heat-legend-bar"></div><span>높음</span></div>
      `}
    </div>
  `
}

// ── 연구 타임라인(최근 7일) ── /library/timeline 이벤트를 그대로 시간순
// 미니 리스트로 보여준다.
const TIMELINE_TYPE_LABEL = { uploaded: '업로드', read: '읽음', question: '질문', note: '메모' }

function renderTimelineCard(events) {
  const recent = events.filter(e => isWithinDays(e.timestamp, 7)).slice(0, 7)
  return `
    <div class="dash-card">
      <div class="dash-card-head">
        <h3>${icon('clock', 15)}연구 타임라인</h3>
        <a href="#" class="dash-link" data-nav="history">전체보기 ›</a>
      </div>
      <div class="dash-card-tag dash-card-tag-inline">최근 7일</div>
      ${recent.length === 0 ? emptyNote('최근 7일간 활동이 없습니다.') : `
      <ul class="dash-timeline-list">
        ${recent.map(e => `
          <li class="dash-timeline-item dash-timeline-${escapeHtml(e.type)}" data-doc-id="${escapeHtml(e.doc_id || '')}" data-type="${escapeHtml(e.type)}" title="이 논문 열기">
            <span class="dash-timeline-dot"></span>
            <div class="dash-timeline-body">
              <div class="dash-timeline-top">
                <span class="dash-timeline-type">${escapeHtml(TIMELINE_TYPE_LABEL[e.type] || e.type)}</span>
                <span class="dash-timeline-time">${relativeTimeKo(e.timestamp)}</span>
              </div>
              <div class="dash-timeline-title">${escapeHtml(e.doc_title || '')}</div>
              ${e.summary ? `<div class="dash-timeline-summary">${escapeHtml(e.summary)}</div>` : ''}
            </div>
          </li>
        `).join('')}
      </ul>`}
    </div>
  `
}

// ── 연구 그래프 미리보기 ── /library/graph의 실제 노드/엣지에서, 개념
// 히트맵 1위 개념을 중심으로 직접 연결된 이웃(해당 개념을 가진 논문 =
// has_concept 엣지, 유사 개념 = similar_to 엣지)만 뽑아 작은 방사형
// SVG로 그린다. "추천 논문"은 아직 라이브러리에 없는 논문이라 그래프
// 노드 자체가 없으므로 범례에서 제외했다(실데이터 없는 항목은 만들지
// 않는다는 원칙).
function buildGraphPreview(graphData, heatmap) {
  if (!graphData || !graphData.nodes || !heatmap.length) return null
  const nodeById = new Map(graphData.nodes.map(n => [n.id, n]))
  const top = heatmap.find(h => nodeById.has(`concept:${h.concept_id}`))
  if (!top) return null
  const centerId = `concept:${top.concept_id}`
  const center = nodeById.get(centerId)

  const seen = new Set()
  const neighbors = []
  for (const e of graphData.edges) {
    if (e.source !== centerId && e.target !== centerId) continue
    const otherId = e.source === centerId ? e.target : e.source
    if (seen.has(otherId)) continue
    const node = nodeById.get(otherId)
    if (!node || (node.type !== 'paper' && node.type !== 'concept')) continue
    seen.add(otherId)
    neighbors.push(node)
    if (neighbors.length >= 7) break
  }
  if (neighbors.length === 0) return null
  return { center, neighbors }
}

function renderMiniGraphSvg({ center, neighbors }) {
  const W = 280, H = 176
  const cx = W / 2, cy = H / 2 + 6
  const r = 66
  const n = neighbors.length
  const points = neighbors.map((node, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    return { node, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
  })

  const lines = points.map(p => `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" class="dash-graph-edge" />`).join('')
  const nodesHtml = points.map(p => {
    const isPaper = p.node.type === 'paper'
    const labelY = p.y > cy ? p.y + 16 : p.y - 11
    return `
      <g class="dash-graph-node ${isPaper ? 'is-paper' : 'is-concept'}" data-node-id="${escapeHtml(p.node.id || '')}">
        <title>${escapeHtml(p.node.label || '')} (클릭하면 연구 그래프에서 보기)</title>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isPaper ? 8 : 6.5}" />
        <text x="${p.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${escapeHtml(truncateLabel(p.node.label, 13))}</text>
      </g>
    `
  }).join('')

  return `
    <svg class="dash-graph-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${lines}
      ${nodesHtml}
      <g class="dash-graph-node is-center" data-node-id="${escapeHtml(center.id || '')}">
        <title>${escapeHtml(center.label || '')} (클릭하면 연구 그래프에서 보기)</title>
        <circle cx="${cx}" cy="${cy}" r="13" />
        <text x="${cx}" y="${cy + 26}" text-anchor="middle" class="dash-graph-center-label">${escapeHtml(truncateLabel(center.label, 12))}</text>
      </g>
    </svg>
    <div class="dash-graph-legend">
      <span><i class="dash-legend-dot is-center"></i>현재 개념</span>
      <span><i class="dash-legend-dot is-paper"></i>연결된 논문</span>
      <span><i class="dash-legend-dot is-concept"></i>관련 개념</span>
    </div>
  `
}

function renderGraphPreviewCard(graphData, heatmap) {
  const preview = buildGraphPreview(graphData, heatmap)
  return `
    <div class="dash-card dash-card-graph">
      <div class="dash-card-head">
        <h3>${icon('network', 15)}연구 그래프 미리보기</h3>
        <a href="#" class="dash-link" data-nav="graph">그래프 보기 ›</a>
      </div>
      ${!preview ? emptyNote('아직 미리 볼 만큼 연결된 그래프 데이터가 없습니다.') : renderMiniGraphSvg(preview)}
    </div>
  `
}

// Research Graph 페이지(main.js의 renderLibraryGraphTab)가 로드된 뒤 이 키를
// 확인해서, 있으면 그 노드를 실제로 클릭한 것과 동일하게 선택하고(showGraphDetailPanel
// 호출 + 하이라이트) 지운다. main.js를 거치지 않고 URL만으로 넘기면 해시 라우터가
// 페이지 이름만 정확히 매칭하는 방식과 충돌하므로, 세션 스토리지로 핸드오프한다.
const GRAPH_FOCUS_NODE_KEY = 'easypaper_graph_focus_node'
function goToGraphNode(nodeId) {
  if (!nodeId) return
  sessionStorage.setItem(GRAPH_FOCUS_NODE_KEY, nodeId)
  location.hash = 'graph'
}

// ── 이벤트 바인딩 ──────────────────────────────────────────────────────
function attachHandlers(root) {
  root.querySelectorAll('[data-nav]').forEach(elm => {
    elm.addEventListener('click', (ev) => {
      ev.preventDefault()
      const page = elm.dataset.nav
      if (page) location.hash = page
    })
  })

  root.querySelectorAll('.dash-paper-item[data-doc-id]').forEach(elm => {
    elm.addEventListener('click', () => {
      const id = elm.dataset.docId
      if (id) location.hash = `viewer?id=${encodeURIComponent(id)}`
    })
  })

  // 최근 질문 → 해당 논문을 채팅 사이드바가 열린 채로 연다.
  root.querySelectorAll('.dash-question-item[data-doc-id]').forEach(elm => {
    elm.addEventListener('click', () => {
      const id = elm.dataset.docId
      if (id) location.hash = `viewer?id=${encodeURIComponent(id)}&chat=1`
    })
  })

  // 연구 타임라인 항목 → 해당 논문 열기(질문 이벤트는 채팅까지 함께 열기).
  root.querySelectorAll('.dash-timeline-item[data-doc-id]').forEach(elm => {
    elm.addEventListener('click', () => {
      const id = elm.dataset.docId
      if (!id) return
      const wantChat = elm.dataset.type === 'question'
      location.hash = `viewer?id=${encodeURIComponent(id)}${wantChat ? '&chat=1' : ''}`
    })
  })

  // 개념 히트맵 타일 → 연구 그래프에서 해당 개념 노드를 선택된 상태로 연다.
  root.querySelectorAll('.dash-heat-cell[data-node-id]').forEach(elm => {
    elm.addEventListener('click', () => goToGraphNode(elm.dataset.nodeId))
  })

  // 연구 그래프 미리보기의 노드(중심 개념/이웃 논문·개념) → 연구 그래프에서 이어서 보기.
  root.querySelectorAll('.dash-graph-node[data-node-id]').forEach(elm => {
    elm.addEventListener('click', () => goToGraphNode(elm.dataset.nodeId))
  })

  const recsBtn = root.querySelector('[data-recs-btn]')
  if (recsBtn) {
    recsBtn.addEventListener('click', async () => {
      const body = root.querySelector('[data-recs-body]')
      if (!body) return
      recsBtn.disabled = true
      body.innerHTML = emptyNote('추천 논문을 찾는 중입니다... (다소 시간이 걸릴 수 있어요)')
      try {
        const { recommendations } = await fetchReadingRecommendations()
        if (!recommendations || recommendations.length === 0) {
          body.innerHTML = emptyNote('추천할 만한 논문을 찾지 못했습니다.')
          return
        }
        body.innerHTML = `
          <ul class="dash-rec-list">
            ${recommendations.slice(0, 5).map(r => `
              <li class="dash-rec-item">
                <a href="${escapeHtml(r.url || '#')}" target="_blank" rel="noopener noreferrer" class="dash-rec-title">${escapeHtml(r.title || '')}</a>
                ${r.year ? `<span class="dash-rec-year">${escapeHtml(String(r.year))}</span>` : ''}
                ${r.reason ? `<div class="dash-rec-reason">${escapeHtml(r.reason)}</div>` : ''}
              </li>
            `).join('')}
          </ul>
        `
      } catch (err) {
        console.error('추천 논문 조회 실패:', err)
        body.innerHTML = `<p class="dash-empty-note dash-error-note">추천 논문을 불러오지 못했습니다.</p>`
      } finally {
        if (root.contains(recsBtn)) recsBtn.disabled = false
      }
    })
  }
}

// ── 진입점 ──────────────────────────────────────────────────────────
export async function renderDashboardPage() {
  const el = document.getElementById('page-dashboard')
  if (!el) return

  el.innerHTML = `<div class="dash-loading">${icon('refreshCw', 20)}<span>대시보드를 불러오는 중...</span></div>`

  let dashboard, timelineData, libraryData, graphData, readingStats
  try {
    const results = await Promise.all([
      fetchLibraryDashboard(),
      fetchLibraryTimeline(),
      fetchLibrary(),
      fetchLibraryGraph().catch(() => null),
      fetchReadingTimeStats().catch(() => null),
    ])
    dashboard = results[0]
    timelineData = results[1]
    libraryData = results[2]
    graphData = results[3]
    readingStats = results[4]
  } catch (err) {
    console.error('대시보드 데이터 로드 실패:', err)
    el.innerHTML = `<div class="dash-error">${icon('alertTriangle', 20)}<p>대시보드를 불러오지 못했습니다.</p></div>`
    return
  }

  const events = (timelineData && timelineData.events) || []
  const docs = (libraryData && libraryData.documents) || []
  const stats = dashboard.stats || {}
  const heatmap = dashboard.heatmap || []
  const gaps = dashboard.gaps || []
  const recentQuestions = dashboard.recent_questions || []

  el.innerHTML = `
    <div class="dash-root">
      ${renderStatGrid(stats, events, docs)}
      <div class="dash-row dash-row-3">
        ${renderInsightsCard(gaps)}
        ${renderWeeklyActivityCard(events, stats, docs, readingStats)}
        ${renderProgressSummaryCard(events, heatmap, readingStats)}
      </div>
      <div class="dash-row dash-row-recent">
        ${renderRecentPapersCard(docs)}
        ${renderRecentQuestionsCard(recentQuestions)}
        ${renderRecommendationsCard()}
      </div>
      <div class="dash-row dash-row-bottom">
        ${renderHeatmapCard(heatmap)}
        ${renderTimelineCard(events)}
        ${renderGraphPreviewCard(graphData, heatmap)}
      </div>
    </div>
  `

  attachHandlers(el)
}
