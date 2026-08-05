// 대시보드 페이지 — 워크스페이스 셸의 #page-dashboard 컨테이너를 전담 렌더링한다.
// 모든 위젯은 실제 백엔드 데이터(/api/library/dashboard, /timeline, /library,
// /graph, /graph/recommendations, /library/reading-stats)에서 가져오거나 그
// 위에서 클라이언트단으로 정직하게 계산한 값만 사용한다 - 뒷받침할 데이터가
// 없는 지표(연구 점수 등)는 만들어내지 않고 통째로 생략했다(자세한 내용은
// 각 렌더 함수 주석 참고). 읽기 시간은 main.js의 읽기 시간 하트비트
// (뷰어/비교 화면이 보이고 포커스된 동안 적립 → 서버 전송)가 쌓은 실측치를
// fetchReadingTimeStats()로 가져온 것이다.
import './../styles/dashboard.css'
import { fetchLibraryDashboard, fetchLibraryTimeline, fetchReadingRecommendations, fetchCachedReadingRecommendations, fetchLibrary, fetchLibraryGraph, fetchReadingTimeStats, fetchReadingAnalyticsSummary } from '../library.js'
import { icon } from '../icons.js'
import { readPageCount, lastActivityIso, hasReadActivity, computeStreakDays, todayKey, addDaysKey, isWithinDaysLocal } from '../readPages.js'
import { periodStats, sumSecondsByDayRange, buildDailyActivityStats, formatDuration } from './readingHistoryPage.js'

function renderReadingAnalyticsCard(analyticsData) {
  if (!analyticsData) return ''

  const avgScore = analyticsData.overall_avg_score || 0.0
  const avgConfidence = analyticsData.overall_avg_confidence || 0.0
  const verifiedPages = analyticsData.overall_verified_pages || 0
  const profile = analyticsData.user_profile || {}
  const emaMinPerPage = Math.round((profile.ema_seconds_per_page || 600.0) / 60)

  return `
    <div class="dash-analytics-card">
      <div class="dash-analytics-header">
        <h3>${icon('activity', 16)} Reading Analytics Summary</h3>
        <span class="reading-depth-badge depth-reading">Score Engine Active</span>
      </div>
      <div class="dash-analytics-grid">
        <div class="dash-analytics-metric">
          <span class="dash-analytics-metric-label">평균 Reading Score</span>
          <div class="dash-analytics-metric-value">${avgScore.toFixed(1)} <span style="font-size: 14px; font-weight: normal; color: var(--text-tertiary);">/ 100</span></div>
          <div class="reading-score-bar-bg">
            <div class="reading-score-bar-fill" style="width: ${Math.min(100, avgScore)}%;"></div>
          </div>
        </div>

        <div class="dash-analytics-metric">
          <span class="dash-analytics-metric-label">평균 Reading Confidence</span>
          <div class="dash-analytics-metric-value">${avgConfidence.toFixed(1)}%</div>
          <span class="dash-analytics-metric-sub">페이지 정독 확률 기반</span>
        </div>

        <div class="dash-analytics-metric">
          <span class="dash-analytics-metric-label">Verified Pages (검증 페이지)</span>
          <div class="dash-analytics-metric-value">${formatNumber(verifiedPages)} <span style="font-size: 13px; font-weight: normal;">p</span></div>
          <span class="dash-analytics-metric-sub">실제 읽기 패턴 인정 페이지</span>
        </div>

        <div class="dash-analytics-metric">
          <span class="dash-analytics-metric-label">개인 EMA 정독 페이스</span>
          <div class="dash-analytics-metric-value">~${emaMinPerPage} <span style="font-size: 13px; font-weight: normal;">분/p</span></div>
          <span class="dash-analytics-metric-sub">EMA 지수이동평균 학습</span>
        </div>
      </div>
    </div>
  `
}

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

function truncateLabel(s, n) {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// ── 통계 카드 ──────────────────────────────────────────────────────────
const STAT_DEFS = [
  { key: 'total_papers', label: '논문', iconName: 'bookOpen', tint: 1, weekly: (c7) => c7?.uploadedPapers || 0 },
  { key: 'read_papers', label: '읽은 논문', iconName: 'checkCircle', tint: 2, weekly: (c7) => c7?.papersRead || 0 },
  { key: 'read_pages', label: '읽은 페이지 수', iconName: 'fileText', tint: 3, weekly: (c7, wp) => wp || 0 },
  // 개념은 생성 시각이 저장되지 않아 "이번 주 신규 개념 수"를 계산할 근거가
  // 없다 - 지어내지 않고 주간 델타 자체를 생략한다.
  { key: 'total_concepts', label: '개념', iconName: 'layers', tint: 4, weekly: null },
  { key: 'total_questions', label: '질문', iconName: 'messageCircle', tint: 5, weekly: (c7) => c7?.questions || 0 },
  { key: 'total_notes', label: '메모', iconName: 'edit3', tint: 6, weekly: (c7) => c7?.notes || 0 },
]

function renderStatCard(def, value, curr7, weeklyPagesRead) {
  const delta = def.weekly ? def.weekly(curr7, weeklyPagesRead) : null
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

function renderStatGrid(stats, curr7, weeklyPagesRead) {
  const safeStats = stats || {}
  return `
    <div class="dash-stat-grid">
      ${STAT_DEFS.map(def => renderStatCard(def, safeStats[def.key], curr7, weeklyPagesRead)).join('')}
    </div>
  `
}

// ── AI 인사이트 ── services/knowledge_graph.get_ai_insights가 사용자의 최근
// 질문/메모 내용을 근거로 LLM(llm_client.generate_dashboard_insights, 지도교수
// 멘토 페르소나)을 호출해 이해도 진단/교수자 조언/관점 제시/근거 있는 격려를
// 생성한다(하루 단위로 캐싱 - 매일 최신화). LLM 호출이 실패하면 백엔드가
// 조용히 규칙 기반 지식 격차 감지 결과로 대체하므로, 프론트는 type이 둘 중
// 어느 체계든 적절한 아이콘만 골라주면 된다.
const INSIGHT_TYPE_ICON = {
  gap_diagnosis: 'helpCircle',
  mentor_advice: 'lightbulb',
  perspective: 'compare',
  encouragement: 'smile',
  low_question_concept: 'messageCircle',
  no_notes_paper: 'edit3',
}

function renderInsightsCard(insights) {
  const items = (insights || []).slice(0, 4)
  return `
    <div class="dash-card dash-card-insights">
      <div class="dash-card-head"><h3>${icon('lightbulb', 15)}AI 인사이트</h3></div>
      ${items.length === 0
        ? emptyNote('아직 표시할 인사이트가 없습니다. 논문을 더 읽고 질문/메모를 남기면 여기에 제안이 쌓입니다.')
        : `<ul class="dash-insight-list">${items.map(g => `
            <li class="dash-insight-item">
              <span class="dash-insight-icon">${icon(INSIGHT_TYPE_ICON[g.type] || 'lightbulb', 14)}</span>
              <span>${escapeHtml(g.message)}</span>
            </li>`).join('')}</ul>`
      }
    </div>
  `
}

// ── 이번 주 활동 ── Reading History 통계 엔진과 동일한 주간 집계 데이터를 공유하여 시각화한다.
function renderWeeklyActivityCard(curr7, weeklyPagesRead, weeklySeconds, stats, readingStats, docs) {
  const safeDocs = Array.isArray(docs) ? docs : []
  const totalCompletedCount = stats?.read_papers ?? safeDocs.filter(d => d?.metadata?.read === true).length
  const totalSeconds = readingStats?.total_seconds || 0
  const rows = [
    { iconName: 'bookOpen', label: '읽은 논문', value: curr7?.papersRead || 0, total: totalCompletedCount, kind: 'count' },
    { iconName: 'fileText', label: '읽은 페이지', value: weeklyPagesRead || 0, total: stats?.total_pages || 0, kind: 'count' },
    { iconName: 'messageCircle', label: '질문', value: curr7?.questions || 0, total: stats?.total_questions || 0, kind: 'count' },
    { iconName: 'clock', label: '읽은 시간', value: weeklySeconds || 0, total: totalSeconds, kind: 'duration' },
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

// ── 연구 성과 & Reading Score ──
function renderProgressSummaryCard(events, heatmap, weeklySeconds, analyticsSummary) {
  const streak = computeStreakDays(events)
  const focusTopic = heatmap[0]
  const score = analyticsSummary?.overall_avg_score || 0.0
  const scorePct = Math.max(0, Math.min(100, score))

  return `
    <div class="dash-card">
      <div class="dash-card-head">
        <h3>${icon('award', 15)}활동 요약</h3>
      </div>
      <div class="dash-score-pie-container" style="display: flex; align-items: center; gap: 14px; padding: 12px; margin-bottom: 12px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
        <div style="position: relative; width: 64px; height: 64px; flex-shrink: 0;">
          <svg width="64" height="64" viewBox="0 0 36 36" style="transform: rotate(-90deg);">
            <path stroke="var(--bg-hover)" stroke-width="3.6" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            <path stroke="url(#dashReadingScoreGrad)" stroke-width="3.6" stroke-dasharray="${scorePct.toFixed(1)}, 100" stroke-linecap="round" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            <defs>
              <linearGradient id="dashReadingScoreGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#3b82f6" />
                <stop offset="100%" stop-color="#8b5cf6" />
              </linearGradient>
            </defs>
          </svg>
          <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; color: var(--text-primary);">
            ${score.toFixed(1)}
          </div>
        </div>
        <div style="flex: 1;">
          <div style="font-size: 13px; font-weight: 700; color: var(--text-primary);">Reading Score Engine</div>
          <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 2px;">정독 패턴, verified pages & interaction 종합 평가</div>
        </div>
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
//
// 정렬/날짜 표시 기준: last_read_at(뷰어를 열거나 페이지를 넘길 때마다 갱신되는
// "마지막으로 읽은 시각") / read_at(완독 표시 시각) / created_at(업로드 시각)
// 중 가장 최근 값을 쓴다. read_at만 쓰면 완독 표시를 안 하고 읽던 중인 논문은
// 계속 created_at으로 떨어져, 방금 읽었어도 날짜가 업로드 시점("3일 전" 등)에
// 고정되어 보이는 문제가 있었다.


function renderRecentPapersCard(docs) {
  const read = docs
    .filter(d => (d.metadata && d.metadata.read) || Number.isInteger(d.metadata?.last_page))
    .sort((a, b) => new Date(lastActivityIso(b.metadata, b.created_at)).getTime() - new Date(lastActivityIso(a.metadata, a.created_at)).getTime())
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
                  <span class="dash-paper-time">${relativeTimeKo(lastActivityIso(d.metadata, d.created_at))}</span>
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

// ── AI 추천 논문 ── /library/graph/recommendations(전체 생성)는 LLM+OpenAlex를
// 여러 번 호출하는 무거운 엔드포인트라, 백엔드 주석과 기존 그래프 탭 구현이
// 그러듯 사용자가 버튼을 눌렀을 때만 새로 생성한다(불필요한 지연/비용 방지).
// 다만 이미 생성된 캐시가 있으면(/recommendations/cached, 유효기간 이내 조회만
// 하고 새로 생성하진 않는 가벼운 엔드포인트) 대시보드 진입 시 바로 보여줘,
// 캐시가 있는데도 매번 버튼을 눌러야 했던 문제를 없앤다.
function scholarSearchUrl(title) {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(title || '')}`
}

const REC_DISPLAY_LIMIT = 10

function renderRecItemsHtml(recommendations) {
  return `
    <ul class="dash-rec-list">
      ${recommendations.slice(0, REC_DISPLAY_LIMIT).map(r => `
        <li class="dash-rec-item">
          <a href="${escapeHtml(scholarSearchUrl(r.title))}" target="_blank" rel="noopener noreferrer" class="dash-rec-title">${escapeHtml(r.title || '')}</a>
          ${r.year ? `<span class="dash-rec-year">${escapeHtml(String(r.year))}</span>` : ''}
          ${r.reason ? `<div class="dash-rec-reason">${escapeHtml(r.reason)}</div>` : ''}
        </li>
      `).join('')}
    </ul>
  `
}

function renderRecommendationsCard(cachedRecommendations) {
  const hasCached = Array.isArray(cachedRecommendations) && cachedRecommendations.length > 0
  return `
    <div class="dash-card dash-card-list dash-card-recs">
      <div class="dash-card-head">
        <h3>${icon('star', 15)}AI 추천 논문</h3>
        <button type="button" class="dash-recs-head-btn ${hasCached ? '' : 'is-hidden'}" data-recs-refresh-btn title="새로운 추천을 다시 받아옵니다">${icon('refreshCw', 12)} 다시 받기</button>
      </div>
      <div class="dash-recs-body" data-recs-body>
        ${hasCached ? renderRecItemsHtml(cachedRecommendations) : `
          ${emptyNote('읽은 논문들을 바탕으로 다음에 읽으면 좋을 논문을 추천받아 보세요.')}
          <button type="button" class="dash-recs-btn" data-recs-btn>${icon('zap', 13)}추천 받기</button>
        `}
      </div>
    </div>
  `
}

// ── 개념 히트맵 ── dashboard.heatmap(paper_count+question_count 합인 score
// 기준 정렬)을 그대로 타일로 표시하고, 색 진하기는 이 목록 안에서의
// 상대적 score로 정규화한다.
function renderHeatmapCard(heatmap) {
  const safeHeatmap = Array.isArray(heatmap) ? heatmap : []
  const maxScore = safeHeatmap.length ? Math.max(...safeHeatmap.map(h => h?.score || 0)) : 0
  return `
    <div class="dash-card dash-card-heatmap">
      <div class="dash-card-head">
        <h3>${icon('tag', 15)}개념 히트맵</h3>
        <a href="#" class="dash-link" data-nav="graph" data-subview="heatmap">전체보기 ›</a>
      </div>
      ${safeHeatmap.length === 0 ? emptyNote('아직 추출된 개념이 없습니다.') : `
      <div class="dash-heat-grid">
        ${safeHeatmap.slice(0, 8).map(h => {
          const pct = maxScore > 0 ? Math.max(6, Math.round(((h?.score || 0) / maxScore) * 100)) : 6
          return `
            <div class="dash-heat-cell" data-node-id="concept:${escapeHtml(String(h?.concept_id || ''))}" title="${escapeHtml(h?.name || '')} · 논문 ${h?.paper_count || 0}편 · 질문 ${h?.question_count || 0}개 · 클릭하면 연구 그래프에서 보기">
              <div class="dash-heat-swatch" style="--heat-pct:${pct}%"></div>
              <div class="dash-heat-label">${escapeHtml(h?.name || '')}</div>
              <div class="dash-heat-count">${formatNumber(h?.score || 0)}</div>
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
  const safeEvents = Array.isArray(events) ? events : []
  const recent = safeEvents.filter(e => e && isWithinDaysLocal(e.timestamp, 7)).slice(0, 7)
  return `
    <div class="dash-card">
      <div class="dash-card-head">
        <h3>${icon('clock', 15)}연구 타임라인</h3>
        <a href="#" class="dash-link" data-nav="history">전체보기 ›</a>
      </div>
      <div class="dash-card-tag dash-card-tag-inline">최근 7일</div>
      ${recent.length === 0 ? emptyNote('최근 7일간 활동이 없습니다.') : `
      <ul class="dash-timeline-list">
        ${recent.map(e => {
          const isDeleted = Boolean(e.is_deleted)
          return `
          <li class="dash-timeline-item dash-timeline-${escapeHtml(e.type || '')} ${isDeleted ? 'is-deleted' : ''}" data-doc-id="${escapeHtml(e.doc_id || '')}" data-type="${escapeHtml(e.type || '')}" data-is-deleted="${isDeleted ? 'true' : 'false'}" title="${isDeleted ? '삭제된 논문입니다' : '이 논문 열기'}">
            <span class="dash-timeline-dot"></span>
            <div class="dash-timeline-body">
              <div class="dash-timeline-top">
                <span class="dash-timeline-type">${escapeHtml(TIMELINE_TYPE_LABEL[e.type] || e.type || '')}</span>
                <span class="dash-timeline-time">${relativeTimeKo(e.timestamp)}</span>
              </div>
              <div class="dash-timeline-title">
                ${escapeHtml(e.doc_title || '')}
                ${isDeleted ? '<span class="rh-deleted-badge">삭제됨</span>' : ''}
              </div>
              ${e.summary ? `<div class="dash-timeline-summary">${escapeHtml(e.summary)}</div>` : ''}
            </div>
          </li>
        `}).join('')}
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
  if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges) || !Array.isArray(heatmap) || !heatmap.length) return null
  const nodeById = new Map(graphData.nodes.map(n => [n?.id, n]).filter(([id]) => Boolean(id)))
  const top = heatmap.find(h => h && nodeById.has(`concept:${h.concept_id}`))
  if (!top) return null
  const centerId = `concept:${top.concept_id}`
  const center = nodeById.get(centerId)
  if (!center) return null

  const seen = new Set()
  const neighbors = []
  for (const e of graphData.edges) {
    if (!e || e.source === undefined || e.target === undefined) continue
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
      const subview = elm.dataset.subview
      if (subview) {
        sessionStorage.setItem('easypaper_graph_subview', subview)
      }
      if (page) location.hash = page
    })
  })

  root.querySelectorAll('.dash-paper-item[data-doc-id]').forEach(elm => {
    elm.addEventListener('click', () => {
      const id = elm.dataset.docId
      if (id) location.hash = `viewer?id=${encodeURIComponent(id)}`
    })
  })

  // 최근 질문 → 논문 뷰어가 아니라 AI Chats의 채팅 드로어를 바로 연다
  // (aiChatsPage.js의 "대화" 버튼과 동일한 '#chat?id=' 해시 라우트 사용).
  root.querySelectorAll('.dash-question-item[data-doc-id]').forEach(elm => {
    elm.addEventListener('click', () => {
      const id = elm.dataset.docId
      if (id) location.hash = `chat?id=${encodeURIComponent(id)}`
    })
  })

  // 연구 타임라인 항목 → 해당 논문 열기(질문 이벤트는 채팅까지 함께 열기).
  root.querySelectorAll('.dash-timeline-item[data-doc-id]').forEach(elm => {
    elm.addEventListener('click', () => {
      const id = elm.dataset.docId
      if (!id || elm.dataset.isDeleted === 'true') return
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

  const recsCard = root.querySelector('.dash-card-recs')
  if (recsCard) {
    const recsBody = recsCard.querySelector('[data-recs-body]')
    const refreshBtn = recsCard.querySelector('[data-recs-refresh-btn]')

    const runRecsFetch = async (triggerBtn, force) => {
      if (triggerBtn) triggerBtn.disabled = true
      if (refreshBtn) refreshBtn.disabled = true

      recsBody.innerHTML = emptyNote('추천 논문을 찾는 중입니다... (다소 시간이 걸릴 수 있어요)')
      try {
        const { recommendations } = await fetchReadingRecommendations({ force })
        if (!recommendations || recommendations.length === 0) {
          recsBody.innerHTML = emptyNote('추천할 만한 논문을 찾지 못했습니다.')
          if (refreshBtn) refreshBtn.classList.add('is-hidden')
          return
        }
        recsBody.innerHTML = renderRecItemsHtml(recommendations)
        if (refreshBtn) refreshBtn.classList.remove('is-hidden')
      } catch (err) {
        console.error('추천 논문 조회 실패:', err)
        recsBody.innerHTML = `<p class="dash-empty-note dash-error-note">추천 논문을 불러오지 못했습니다.</p>`
      } finally {
        if (triggerBtn) triggerBtn.disabled = false
        if (refreshBtn) refreshBtn.disabled = false
      }
    }

    if (refreshBtn) refreshBtn.addEventListener('click', () => runRecsFetch(refreshBtn, true))
    const recsBtn = recsBody?.querySelector('[data-recs-btn]')
    if (recsBtn) recsBtn.addEventListener('click', () => runRecsFetch(recsBtn, false))
  }
}

// ── 진입점 ──────────────────────────────────────────────────────────
export async function renderDashboardPage() {
  const el = document.getElementById('page-dashboard')
  if (!el) return

  el.innerHTML = `<div class="dash-loading">${icon('refreshCw', 20)}<span>대시보드를 불러오는 중...</span></div>`

  let dashboard, timelineData, libraryData, graphData, readingStats, cachedRecs, analyticsSummary
  try {
    const results = await Promise.all([
      fetchLibraryDashboard().catch(() => null),
      fetchLibraryTimeline().catch(() => ({ events: [] })),
      fetchLibrary().catch(() => ({ documents: [] })),
      fetchLibraryGraph().catch(() => null),
      fetchReadingTimeStats().catch(() => null),
      fetchCachedReadingRecommendations().catch(() => ({ recommendations: null })),
      fetchReadingAnalyticsSummary().catch(() => null),
    ])
    dashboard = results[0]
    timelineData = results[1]
    libraryData = results[2]
    graphData = results[3]
    readingStats = results[4]
    cachedRecs = results[5]
    analyticsSummary = results[6]
  } catch (err) {
    console.error('대시보드 데이터 로드 실패:', err)
    el.innerHTML = `<div class="dash-error">${icon('alertTriangle', 20)}<p>대시보드를 불러오지 못했습니다.</p></div>`
    return
  }

  try {
    const events = (timelineData && Array.isArray(timelineData.events)) ? timelineData.events : []
    const docs = (libraryData && Array.isArray(libraryData.documents)) ? libraryData.documents : []
    const stats = (dashboard && dashboard.stats) ? dashboard.stats : {}
    const heatmap = (dashboard && Array.isArray(dashboard.heatmap)) ? dashboard.heatmap : []
    const insights = (dashboard && Array.isArray(dashboard.insights)) ? dashboard.insights : []
    const recentQuestions = (dashboard && Array.isArray(dashboard.recent_questions)) ? dashboard.recent_questions : []

    const docsById = new Map(docs.map(d => [d.id, d]))
    const tKey = todayKey()
    const currStart7 = addDaysKey(tKey, -6)
    const currEnd7 = addDaysKey(tKey, 1)

    const curr7 = periodStats(events, docsById, currStart7, currEnd7)
    const weeklySeconds = sumSecondsByDayRange(readingStats?.total_seconds_by_day, currStart7, currEnd7)
    const dailyStatsMap = buildDailyActivityStats(events, readingStats)

    let currEstPages7 = 0
    for (const [day, item] of dailyStatsMap.entries()) {
      if (day >= currStart7 && day < currEnd7) {
        currEstPages7 += item.estPagesRead
      }
    }
    const weeklyPagesRead = Math.max(curr7.pagesRead, currEstPages7)

    el.innerHTML = `
      <div class="dash-root">
        ${renderStatGrid(stats, curr7, weeklyPagesRead)}
        <div class="dash-row dash-row-3">
          ${renderInsightsCard(insights)}
          ${renderWeeklyActivityCard(curr7, weeklyPagesRead, weeklySeconds, stats, readingStats, docs)}
          ${renderProgressSummaryCard(events, heatmap, weeklySeconds, analyticsSummary)}
        </div>
        <div class="dash-row dash-row-recent">
          ${renderRecentPapersCard(docs)}
          ${renderRecentQuestionsCard(recentQuestions)}
          ${renderRecommendationsCard(cachedRecs && cachedRecs.recommendations)}
        </div>
        <div class="dash-row dash-row-bottom">
          ${renderHeatmapCard(heatmap)}
          ${renderTimelineCard(events)}
          ${renderGraphPreviewCard(graphData, heatmap)}
        </div>
      </div>
    `

    attachHandlers(el)
  } catch (renderErr) {
    console.error('대시보드 렌더링 예외 발생:', renderErr)
    el.innerHTML = `<div class="dash-error">${icon('alertTriangle', 20)}<p>대시보드를 불러오지 못했습니다.</p></div>`
  }
}
