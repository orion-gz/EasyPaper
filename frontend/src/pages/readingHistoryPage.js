// Reading History 페이지
//
// "읽은 시간"은 main.js의 읽기 시간 하트비트(뷰어/비교 화면이 보이고 포커스된
// 동안 5초 tick으로 현재 문서+카테고리에 적립 → 20초마다 서버로 flush,
// POST /library/{doc_id}/reading-heartbeat)가 쌓은 실측치를
// fetchReadingTimeStats()로 집계해서 쓴다. 카테고리는 실제로 구분 가능한 화면
// 상태 3가지뿐이다: reading(최근 PDF 상호작용) / chat(최근 채팅 상호작용) /
// compare(논문 비교 채팅). 이 기능을 도입하기 전에 만든 페이지라 이 시점
// 이전의 활동에는 시간 데이터가 없을 수 있다 - 그런 경우 위젯은 "아직 기록된
// 읽기 시간이 없습니다"로 정직하게 표시한다.

import { fetchLibraryTimeline, fetchLibraryDashboard, fetchLibrary, fetchReadingTimeStats, fetchReadingAnalyticsSummary } from '../library.js'
import { icon } from '../icons.js'
import { countUniqueVerifiedPages, readPageCount, lastActivityIso, lastActivityDateKey, isoToLocalDateKey } from '../readPages.js'
import '../styles/reading-history.css'
import '../styles/dashboard.css'

let renderGeneration = 0

function renderReadingAnalyticsSummaryCard(analyticsSummary) {
  if (!analyticsSummary) return ''

  const avgScore = analyticsSummary.overall_avg_score || 0.0
  const avgConfidence = analyticsSummary.overall_avg_confidence || 0.0
  const verifiedPages = analyticsSummary.overall_verified_pages || 0
  const profile = analyticsSummary.user_profile || {}
  const emaMinPerPage = Math.round((profile.ema_seconds_per_page || 600.0) / 60)

  return `
    <div class="rh-card" style="margin-top: 16px;">
      <div class="rh-card-head">
        <span class="rh-card-title">${icon('activity', 15)} Reading Analytics Summary</span>
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
          <div class="dash-analytics-metric-value">${verifiedPages.toLocaleString()} <span style="font-size: 13px; font-weight: normal;">p</span></div>
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

const TYPE_LABEL = { uploaded: '업로드', read: '읽음', browsed: '열람', question: '질문', note: '메모' }
const TYPE_ICON = { uploaded: 'archive', read: 'bookOpen', browsed: 'activity', question: 'messageCircle', note: 'edit3' }
// 활동 구성 막대(part-to-whole)의 분류 색 - dataviz 팔레트 슬롯을
// 고정 순서(blue→orange→aqua→yellow)로만 사용해 색맹 인접성 검증을 그대로 유지한다.
const TYPE_COLOR_VAR = { read: '--rh-c1', browsed: '--rh-c5', question: '--rh-c2', note: '--rh-c3', uploaded: '--rh-c4' }
const TYPE_ORDER = ['read', 'browsed', 'question', 'note', 'uploaded']

// 읽기 시간 하트비트의 카테고리 3종(PDF 상호작용/채팅 상호작용/논문 비교) - 대시보드
// 활동 요약 카드의 "활동 유형별 시간 분포"에서도 동일 팔레트/라벨을 공유한다.
export const CATEGORY_LABEL = { reading: '논문 읽기', chat: 'AI 채팅', compare: '논문 비교' }
export const CATEGORY_COLOR_VAR = { reading: '--rh-c1', chat: '--rh-c2', compare: '--rh-c5' }
export const CATEGORY_ORDER = ['reading', 'chat', 'compare']

const DAY_MS = 86400000
const WEEKDAY_LABELS = ['월', '', '수', '', '금', '', '일']

// ── 날짜 키 유틸: 로컬 자정 기준 "YYYY-MM-DD". 이벤트 timestamp는
// 백엔드가 UTC ISO 문자열로 내려주므로 .slice(0,10) 자체가 이미 날짜 키다. ──
function localDateToKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function keyToLocalDate(key) {
  return new Date(`${key}T00:00:00`)
}
function addDaysKey(key, delta) {
  const d = keyToLocalDate(key)
  d.setDate(d.getDate() + delta)
  return localDateToKey(d)
}
function todayKey() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return localDateToKey(d)
}
function eventKey(e) {
  return (e.timestamp || '').slice(0, 10)
}

function formatDayLabel(dateKey) {
  const day = keyToLocalDate(dateKey)
  if (isNaN(day.getTime())) return { primary: dateKey, secondary: '' }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((today - day) / DAY_MS)
  const primary = diffDays === 0 ? '오늘' : diffDays === 1 ? '어제'
    : day.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
  return { primary, secondary: day.toLocaleDateString('ko-KR', { weekday: 'long' }) }
}
function formatTime(timestamp) {
  const d = new Date(timestamp)
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
}
function formatShortDate(dateKey) {
  const d = keyToLocalDate(dateKey)
  if (isNaN(d.getTime())) return dateKey
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function buildDailyActivityStats(events, readingStats) {
  const byDay = new Map()

  function getOrCreate(key) {
    if (!byDay.has(key)) {
      byDay.set(key, {
        readingSeconds: 0,
        verifiedPages: 0,
        hasVerifiedPages: false,
        questions: 0,
        notes: 0,
        uploaded: 0,
        readEvents: 0,
        score: 0,
      })
    }
    return byDay.get(key)
  }

  // 1. 하트비트 읽기 시간 반영
  const timeByDay = readingStats?.total_seconds_by_day || {}
  for (const [dayKey, seconds] of Object.entries(timeByDay)) {
    if (!dayKey || seconds <= 0) continue
    const item = getOrCreate(dayKey)
    item.readingSeconds += seconds
  }

  // 2. 타임라인 이벤트 분류 및 검증된 실측 읽은 페이지 수 집계
  for (const e of events) {
    const k = eventKey(e)
    if (!k) continue
    const item = getOrCreate(k)
    if (e.type === 'question') item.questions += 1
    else if (e.type === 'note') item.notes += 1
    else if (e.type === 'uploaded') item.uploaded += 1
    else if (e.type === 'read' || e.type === 'browsed') {
      if (e.type === 'read') item.readEvents += 1
      if (Array.isArray(e.verified_page_numbers)) {
        item.hasVerifiedPages = true
        item.verifiedPageKeys ||= new Set()
        for (const page of e.verified_page_numbers) {
          if (Number.isInteger(page) && page > 0 && e.doc_id) {
            item.verifiedPageKeys.add(`${e.doc_id}:${page}`)
          }
        }
        item.verifiedPages = item.verifiedPageKeys.size
      }
    }
  }

  // 3. 일별 활동 점수 계산. 페이지 점수는 시간 추정치가 아니라 실제 검증
  // 페이지에만 부여한다. 읽은 시간 자체는 별도 점수로 이미 반영된다.
  for (const [_, item] of byDay.entries()) {
    const displayPages = item.verifiedPages

    const readTimeScore = Math.floor(item.readingSeconds / 60)
    const pageScore = displayPages * 3
    const readEventScore = item.readEvents * 2
    const readScore = readTimeScore + pageScore + readEventScore

    const noteScore = item.notes * 3
    const uploadScore = item.uploaded * 2

    let questionScore = 0
    if (item.questions > 0) {
      if (item.questions <= 5) {
        questionScore = item.questions * 1.0
      } else if (item.questions <= 15) {
        questionScore = 5 + (item.questions - 5) * 0.5
      } else {
        questionScore = 10 + (item.questions - 15) * 0.2
      }
      questionScore = Math.min(15, Math.round(questionScore * 10) / 10)
    }

    item.score = Math.round((readScore + noteScore + uploadScore + questionScore) * 10) / 10
  }

  return byDay
}

function bucketOfScore(score) {
  if (!score || score <= 0) return 0
  if (score < 5) return 1
  if (score < 15) return 2
  if (score < 35) return 3
  return 4
}

function formatActivityTooltip(dateKey, item) {
  const dateStr = formatShortDate(dateKey)
  if (!item || item.score <= 0) {
    return `${dateStr}: 활동 없음`
  }

  const parts = []
  const pages = item.verifiedPages
  if (item.readingSeconds > 0 || pages > 0) {
    const durStr = formatDuration(item.readingSeconds)
    const pageStr = pages > 0 ? ` [실제 ${pages}페이지 정독]` : ''
    parts.push(`읽기 ${durStr}${pageStr}`)
  }
  if (item.questions > 0) parts.push(`질문 ${item.questions}건`)
  if (item.notes > 0) parts.push(`메모 ${item.notes}건`)
  if (item.uploaded > 0) parts.push(`업로드 ${item.uploaded}건`)

  const detailStr = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `${dateStr}: 활동 ${item.score}pt${detailStr}`
}


// 실제 연속일 스트릭(현재/최장)을 날짜 집합에서 그대로 계산한다 - 절대 임의의
// 숫자를 넣지 않는다.
function computeStreaks(activeDayKeys) {
  const sorted = Array.from(activeDayKeys).sort()
  let longest = 0, longestEnd = null
  let run = 0, prevKey = null
  for (const k of sorted) {
    if (prevKey && addDaysKey(prevKey, 1) === k) {
      run += 1
    } else {
      run = 1
    }
    if (run > longest) { longest = run; longestEnd = k }
    prevKey = k
  }
  const longestStart = longestEnd ? addDaysKey(longestEnd, -(longest - 1)) : null

  // 현재 스트릭: 오늘부터, 오늘 기록이 아직 없으면 어제부터 거슬러 올라가며 연속일 수를 센다.
  const today = todayKey()
  let cursor = activeDayKeys.has(today) ? today : addDaysKey(today, -1)
  let current = 0
  while (activeDayKeys.has(cursor)) {
    current += 1
    cursor = addDaysKey(cursor, -1)
  }
  return { current, longest, longestStart, longestEnd }
}

export function periodStats(events, docsById, startKey, endKeyExclusive) {
  const safeEvents = Array.isArray(events) ? events : []
  const inPeriod = safeEvents.filter(e => {
    const k = eventKey(e)
    return k && k >= startKey && k < endKeyExclusive
  })
  const activeDays = new Set(inPeriod.map(eventKey)).size

  // 완독 체크(read === true)를 누른 논문만 해당 기간 읽은 논문으로 집계
  const completedDocIds = new Set()
  if (docsById && typeof docsById.values === 'function') {
    for (const doc of docsById.values()) {
      if (!doc) continue
      const meta = doc.metadata || {}
      if (meta.read === true) {
        const k = isoToLocalDateKey(meta.read_at || meta.last_read_at || doc.created_at)
        if (k && k >= startKey && k < endKeyExclusive) {
          completedDocIds.add(doc.id)
        }
      }
    }
  }

  // 타임라인 세션의 검증 페이지 번호만 사용한다. 같은 논문의 같은 페이지를
  // 기간 안에서 여러 번 읽어도 (doc_id, page) 합집합이므로 한 번만 집계된다.
  const pagesRead = countUniqueVerifiedPages(inPeriod)
  const questions = inPeriod.filter(e => e.type === 'question').length
  const notes = inPeriod.filter(e => e.type === 'note').length
  const uploadedPapers = inPeriod.filter(e => e.type === 'uploaded').length
  return { activeDays, papersRead: completedDocIds.size, pagesRead, questions, notes, uploadedPapers }
}

export function deltaHtml(curr, prev, unit = '', compareText = '이전 30일 대비') {
  const c = curr || 0
  const p = prev || 0
  const diff = c - p
  if (diff === 0) return `<span class="rh-stat-delta">±0${unit ? ' ' + unit : ''} ${compareText}</span>`
  const cls = diff > 0 ? 'up' : 'down'
  const arrow = diff > 0 ? '↑' : '↓'
  return `<span class="rh-stat-delta ${cls}">${arrow} ${Math.abs(diff).toLocaleString()}${unit ? ' ' + unit : ''} ${compareText}</span>`
}

// ── 읽기 시간 포맷/집계 헬퍼 ──────────────────────────────────
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return s > 0 ? `${s}s` : '0m'
}
export function deltaDurationHtml(currSeconds, prevSeconds, compareText = '이전 30일 대비') {
  const diff = Math.round(currSeconds - prevSeconds)
  if (diff === 0) return `<span class="rh-stat-delta">±0m ${compareText}</span>`
  const cls = diff > 0 ? 'up' : 'down'
  const arrow = diff > 0 ? '↑' : '↓'
  return `<span class="rh-stat-delta ${cls}">${arrow} ${formatDuration(Math.abs(diff))} ${compareText}</span>`
}
export function sumSecondsByDayRange(byDay, startKey, endKeyExclusive) {
  let total = 0
  for (const [day, seconds] of Object.entries(byDay || {})) {
    if (day >= startKey && day < endKeyExclusive) total += seconds
  }
  return total
}

// ── 캘린더 히트맵 호버 툴팁 ───────────────────────────────────
// rh-cal-scroll이 overflow-x:auto라 overflow-y도 함께 clip되므로(CSS 스펙상
// 한 축이라도 visible이 아니면 다른 축도 auto로 강제됨), 셀 위에 절대배치로
// 띄우면 그리드 밖으로 잘려 안 보일 수 있다 - body에 fixed로 붙여 스크롤
// 컨테이너의 클리핑을 피하는 싱글턴 툴팁을 쓴다.
let rhTooltipEl = null
function getRhTooltipEl() {
  if (!rhTooltipEl) {
    rhTooltipEl = document.createElement('div')
    rhTooltipEl.className = 'rh-cal-tooltip'
    document.body.appendChild(rhTooltipEl)
  }
  return rhTooltipEl
}
function showRhTooltip(cellEl) {
  const text = cellEl.dataset.tooltip
  if (!text) return
  const tip = getRhTooltipEl()
  tip.textContent = text
  tip.classList.add('visible')
  const rect = cellEl.getBoundingClientRect()
  const tipRect = tip.getBoundingClientRect()
  let top = rect.top - tipRect.height - 8
  if (top < 4) top = rect.bottom + 8 // 화면 맨 위 줄 셀은 위 공간이 없으므로 아래로 표시
  let left = rect.left + rect.width / 2 - tipRect.width / 2
  left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4))
  tip.style.top = `${top}px`
  tip.style.left = `${left}px`
}
function hideRhTooltip() {
  if (rhTooltipEl) rhTooltipEl.classList.remove('visible')
}

// ── 렌더 ───────────────────────────────────────────────────
export async function renderReadingHistoryPage(documentMode = 'research') {
  const el = document.getElementById('page-history')
  if (!el) return
  const generation = ++renderGeneration
  const isCurrent = () => generation === renderGeneration && el.classList.contains('active')

  hideRhTooltip() // 다른 페이지로 이동한 뒤에도 뜬 채로 남아있지 않도록
  el.innerHTML = '<div class="rh-page"><div class="rh-empty">읽기 기록을 불러오는 중...</div></div>'

  let events = []
  let dashboard = null
  let libraryDocs = []
  let readingStats = null
  let analyticsSummary = null
  try {
    const [timelineRes, dashboardRes, libraryRes, readingStatsRes, analyticsSummaryRes] = await Promise.all([
      fetchLibraryTimeline().catch(() => ({ events: [] })),
      fetchLibraryDashboard().catch(() => null),
      fetchLibrary({ documentMode }).catch(() => ({ documents: [] })),
      fetchReadingTimeStats(null, documentMode).catch(() => null),
      fetchReadingAnalyticsSummary(null, documentMode).catch(() => null),
    ])
    libraryDocs = libraryRes?.documents || []
    const visibleDocIds = new Set(libraryDocs.map(doc => doc.id))
    events = (timelineRes?.events || []).filter(event => !event.doc_id || visibleDocIds.has(event.doc_id))
    dashboard = documentMode === 'research' ? dashboardRes : null
    readingStats = readingStatsRes
    analyticsSummary = analyticsSummaryRes
  } catch (err) {
    console.error('Reading History 로드 실패:', err)
    if (isCurrent()) {
      el.innerHTML = '<div class="rh-page"><div class="rh-empty" style="color:var(--error)">읽기 기록을 불러오지 못했습니다.</div></div>'
    }
    return
  }

  if (!isCurrent()) return

  const docsById = new Map(libraryDocs.map(d => [d.id, d]))
  // readingStats.title_by_doc: 하트비트 시 스냅샷된 doc별 제목 (영구 삭제 후에도 복원 가능)
  const titleByDoc = new Map(Object.entries(readingStats?.title_by_doc || {}))
  const timelineDocTitles = new Map()
  events.forEach(e => {
    if (e.doc_id && e.doc_title && !timelineDocTitles.has(e.doc_id)) {
      timelineDocTitles.set(e.doc_id, e.doc_title)
    }
  })
  const docTitle = (docId, fallback) => {
    const d = docsById.get(docId)
    // 우선순위: 1) 현재 documents 테이블 제목  2) reading_time 스냅샷 제목
    //           3) 타임라인 이벤트 제목        4) fallback  5) '제목 없음'
    return (d?.metadata?.title) || d?.filename
      || titleByDoc.get(docId)
      || timelineDocTitles.get(docId)
      || fallback
      || '제목 없음'
  }



  // ── 스탯 카드: 최근 7일, 최근 30일, 전체 ──
  const tKey = todayKey()

  // 최근 7일 vs 그 이전 7일
  const currStart7 = addDaysKey(tKey, -6)
  const currEnd7 = addDaysKey(tKey, 1)
  const prevStart7 = addDaysKey(tKey, -13)
  const prevEnd7 = currStart7
  const curr7 = periodStats(events, docsById, currStart7, currEnd7)
  const prev7 = periodStats(events, docsById, prevStart7, prevEnd7)
  const activeDaysPct7 = Math.round((curr7.activeDays / 7) * 100)

  // 최근 30일 vs 그 이전 30일
  const currStart = addDaysKey(tKey, -29)
  const currEnd = addDaysKey(tKey, 1)
  const prevStart = addDaysKey(tKey, -59)
  const prevEnd = currStart
  const curr = periodStats(events, docsById, currStart, currEnd)
  const prev = periodStats(events, docsById, prevStart, prevEnd)
  const activeDaysPct = Math.round((curr.activeDays / 30) * 100)

  const totalQuestions = dashboard?.stats?.total_questions ?? events.filter(e => e.type === 'question').length
  const totalNotes = dashboard?.stats?.total_notes ?? events.filter(e => e.type === 'note').length

  const byDay = readingStats?.total_seconds_by_day || {}
  const currReadingSeconds7 = sumSecondsByDayRange(byDay, currStart7, currEnd7)
  const prevReadingSeconds7 = sumSecondsByDayRange(byDay, prevStart7, prevEnd7)
  const currReadingSeconds = sumSecondsByDayRange(byDay, currStart, currEnd)
  const prevReadingSeconds = sumSecondsByDayRange(byDay, prevStart, prevEnd)

  // 일별 종합 활동 스탯 집계 (검증 페이지 + 실측 시간 + 질문 편향 보정)
  const dailyStatsMap = buildDailyActivityStats(events, readingStats)
  const currPagesReadDisplay7 = curr7.pagesRead
  const prevPagesReadDisplay7 = prev7.pagesRead
  const currPagesReadDisplay = curr.pagesRead
  const prevPagesReadDisplay = prev.pagesRead
  const totalReadPagesDisplay = countUniqueVerifiedPages(events)

  const allActiveKeys = new Set(
    Array.from(dailyStatsMap.entries())
      .filter(([_, item]) => item.score > 0)
      .map(([k, _]) => k)
  )

  const byCategory = readingStats?.total_seconds_by_category || {}
  const mixTotalSeconds = CATEGORY_ORDER.reduce((s, c) => s + (byCategory[c] || 0), 0)

  const allReadingSeconds = mixTotalSeconds > 0
    ? mixTotalSeconds
    : Object.values(byDay).reduce((sum, sec) => sum + (Number(sec) || 0), 0)

  const totalUploadedCount = Math.max(dashboard?.stats?.total_papers ?? 0, docsById.size)
  const completedDocsCount = Array.from(docsById.values()).filter(d => d.metadata?.read === true).length
  const totalReadCount = Math.max(dashboard?.stats?.read_papers ?? 0, completedDocsCount, curr.papersRead, curr7.papersRead)

  const getStatCards = (period) => {
    if (period === '7') {
      return [
        {
          icon: 'bookOpen', color: 'var(--rh-c4)', label: '등록 논문',
          value: (curr7.uploadedPapers || 0).toLocaleString(),
          sub: deltaHtml(curr7.uploadedPapers, prev7.uploadedPapers, '', '이전 7일 대비'),
        },
        {
          icon: 'checkCircle', color: 'var(--rh-c2)', label: '읽은 논문',
          value: (curr7.papersRead || 0).toLocaleString(),
          sub: deltaHtml(curr7.papersRead, prev7.papersRead, '', '이전 7일 대비'),
        },
        {
          icon: 'calendar', color: 'var(--rh-c1)', label: '활동일',
          value: `${curr7.activeDays || 0} / 7`,
          sub: `<span class="rh-stat-delta">최근 7일 중 ${activeDaysPct7}%</span>`,
        },
        {
          icon: 'clock', color: 'var(--rh-c3)', label: '읽은 시간',
          value: formatDuration(currReadingSeconds7),
          sub: deltaDurationHtml(currReadingSeconds7, prevReadingSeconds7, '이전 7일 대비'),
        },
        {
          icon: 'layers', color: 'var(--rh-c6)', label: '읽은 페이지',
          value: currPagesReadDisplay7.toLocaleString(),
          sub: deltaHtml(currPagesReadDisplay7, prevPagesReadDisplay7, '', '이전 7일 대비'),
        },
        {
          icon: 'messageCircle', color: 'var(--rh-c5)', label: '질문 수',
          value: (curr7.questions || 0).toLocaleString(),
          sub: deltaHtml(curr7.questions, prev7.questions, '', '이전 7일 대비'),
        },
        {
          icon: 'edit3', color: 'var(--rh-c2)', label: '작성한 메모',
          value: (curr7.notes || 0).toLocaleString(),
          sub: deltaHtml(curr7.notes, prev7.notes, '', '이전 7일 대비'),
        },
      ]
    }

    if (period === 'all') {
      return [
        {
          icon: 'bookOpen', color: 'var(--rh-c4)', label: '등록 논문',
          value: totalUploadedCount.toLocaleString(),
          sub: `<span class="rh-stat-delta">전체 등록 논문</span>`,
        },
        {
          icon: 'checkCircle', color: 'var(--rh-c2)', label: '읽은 논문',
          value: totalReadCount.toLocaleString(),
          sub: `<span class="rh-stat-delta">전체 완독/읽기 문서</span>`,
        },
        {
          icon: 'calendar', color: 'var(--rh-c1)', label: '활동일',
          value: `${allActiveKeys.size}일`,
          sub: `<span class="rh-stat-delta">총 ${allActiveKeys.size}일 동안 활동</span>`,
        },
        {
          icon: 'clock', color: 'var(--rh-c3)', label: '읽은 시간',
          value: formatDuration(allReadingSeconds),
          sub: `<span class="rh-stat-delta">전체 누적 시간</span>`,
        },
        {
          icon: 'layers', color: 'var(--rh-c6)', label: '읽은 페이지',
          value: totalReadPagesDisplay.toLocaleString(),
          sub: `<span class="rh-stat-delta">전체 누적 페이지</span>`,
        },
        {
          icon: 'messageCircle', color: 'var(--rh-c5)', label: '질문 수',
          value: totalQuestions.toLocaleString(),
          sub: `<span class="rh-stat-delta">전체 누적 질문</span>`,
        },
        {
          icon: 'edit3', color: 'var(--rh-c2)', label: '작성한 메모',
          value: totalNotes.toLocaleString(),
          sub: `<span class="rh-stat-delta">전체 누적 메모</span>`,
        },
      ]
    }

    return [
      {
        icon: 'bookOpen', color: 'var(--rh-c4)', label: '등록 논문',
        value: (curr.uploadedPapers || 0).toLocaleString(),
        sub: deltaHtml(curr.uploadedPapers, prev.uploadedPapers),
      },
      {
        icon: 'checkCircle', color: 'var(--rh-c2)', label: '읽은 논문',
        value: (curr.papersRead || 0).toLocaleString(),
        sub: deltaHtml(curr.papersRead, prev.papersRead),
      },
      {
        icon: 'calendar', color: 'var(--rh-c1)', label: '활동일',
        value: `${curr.activeDays || 0} / 30`,
        sub: `<span class="rh-stat-delta">최근 30일 중 ${activeDaysPct}%</span>`,
      },
      {
        icon: 'clock', color: 'var(--rh-c3)', label: '읽은 시간',
        value: formatDuration(currReadingSeconds),
        sub: deltaDurationHtml(currReadingSeconds, prevReadingSeconds),
      },
      {
        icon: 'layers', color: 'var(--rh-c6)', label: '읽은 페이지',
        value: currPagesReadDisplay.toLocaleString(),
        sub: deltaHtml(currPagesReadDisplay, prevPagesReadDisplay),
      },
      {
        icon: 'messageCircle', color: 'var(--rh-c5)', label: '질문 수',
        value: (curr.questions || 0).toLocaleString(),
        sub: deltaHtml(curr.questions, prev.questions),
      },
      {
        icon: 'edit3', color: 'var(--rh-c2)', label: '작성한 메모',
        value: (curr.notes || 0).toLocaleString(),
        sub: deltaHtml(curr.notes, prev.notes),
      },
    ]
  }

  // ── 캘린더 히트맵: 최근 12주(84일), 월~일 ──
  const WEEKS = 12
  const gridEnd = tKey
  const gridEndDate = keyToLocalDate(gridEnd)
  const endDow = (gridEndDate.getDay() + 6) % 7 // 0=Mon..6=Sun
  const gridStart = addDaysKey(gridEnd, -(endDow) - (WEEKS - 1) * 7)

  const weeks = []
  let cursorKey = gridStart
  for (let w = 0; w < WEEKS; w++) {
    const week = []
    for (let d = 0; d < 7; d++) {
      const item = dailyStatsMap.get(cursorKey) || { score: 0 }
      const isFuture = cursorKey > gridEnd
      week.push({ key: cursorKey, item, isFuture })
      cursorKey = addDaysKey(cursorKey, 1)
    }
    weeks.push(week)
  }

  // rh-cal-months(월 라벨)와 rh-cal-grid(요일 칸)는 서로 다른 grid라, 둘 다
  // 명시적으로 같은 grid-template-columns(렌더 시 인라인 스타일로 주입)를
  // 쓰지 않으면 라벨 열의 auto 폭 계산이 칸 그리드와 어긋나 최근 달(예: 이번
  // 달) 라벨이 실제 칸 밖으로 밀려나 잘려 보인다 - 라벨 위치는 grid-column
  // span만으로 정하고, 폭은 항상 두 grid가 동일하게 갖도록 한다.
  const monthMarkers = []
  weeks.forEach((week, wi) => {
    const firstOfMonthDay = week.find(d => keyToLocalDate(d.key).getDate() <= 7)
    if (firstOfMonthDay) {
      const label = `${keyToLocalDate(firstOfMonthDay.key).getMonth() + 1}월`
      if (!monthMarkers.length || monthMarkers[monthMarkers.length - 1].label !== label) {
        monthMarkers.push({ col: wi + 1, label })
      }
    }
  })

  const calGridHtml = weeks.map(week => week.map(cell => {
    if (cell.isFuture) return '<div class="rh-cal-cell rh-future"></div>'
    const bucket = bucketOfScore(cell.item.score)
    const tooltip = formatActivityTooltip(cell.key, cell.item)
    return `<div class="rh-cal-cell rh-heat-${bucket}" data-tooltip="${escapeHtml(tooltip)}"></div>`
  }).join('')).join('')

  const monthsHtml = (() => {
    // 각 마커부터 다음 마커 전까지 grid-column span으로 라벨을 배치
    let out = ''
    for (let i = 0; i < monthMarkers.length; i++) {
      const start = monthMarkers[i].col
      const end = i + 1 < monthMarkers.length ? monthMarkers[i + 1].col : WEEKS + 1
      out += `<span class="rh-cal-month-label" style="grid-column:${start} / ${end}">${escapeHtml(monthMarkers[i].label)}</span>`
    }
    return out
  })()

  const streaks = computeStreaks(allActiveKeys)
  let bestDayKey = null, bestDayScore = 0, bestDayDetail = ''
  for (const [k, item] of dailyStatsMap.entries()) {
    if (item.score > bestDayScore) {
      bestDayScore = item.score
      bestDayKey = k
      const p = []
      if (item.readingSeconds > 0) p.push(`읽기 ${formatDuration(item.readingSeconds)}`)
      if (item.questions > 0) p.push(`질문 ${item.questions}건`)
      if (item.notes > 0) p.push(`메모 ${item.notes}건`)
      bestDayDetail = p.join(', ')
    }
  }

  // ── Reading Time Distribution (part-to-whole, 전체 기간 실측치) ──
  // 카테고리는 main.js 하트비트가 실제로 구분하는 화면 상태 3가지뿐이다:
  // reading(최근 PDF 상호작용) / chat(최근 채팅 상호작용) / compare(논문 비교).
  const mixBarHtml = CATEGORY_ORDER.map(c => {
    const seconds = byCategory[c] || 0
    const pct = mixTotalSeconds ? (seconds / mixTotalSeconds) * 100 : 0
    if (pct <= 0) return ''
    return `<div class="rh-mix-seg" style="width:${pct}%;background:var(${CATEGORY_COLOR_VAR[c]})" title="${escapeHtml(CATEGORY_LABEL[c])}: ${formatDuration(seconds)}"></div>`
  }).join('')

  const mixLegendHtml = CATEGORY_ORDER.map(c => {
    const seconds = byCategory[c] || 0
    const pct = mixTotalSeconds ? Math.round((seconds / mixTotalSeconds) * 100) : 0
    return `
      <div class="rh-mix-row">
        <span class="rh-mix-dot" style="background:var(${CATEGORY_COLOR_VAR[c]})"></span>
        <span class="rh-mix-label">${escapeHtml(CATEGORY_LABEL[c])}</span>
        <span class="rh-mix-count">${formatDuration(seconds)}</span>
        <span class="rh-mix-pct">${pct}%</span>
      </div>`
  }).join('')

  // ── Top Papers by Reading Time (전체 기간 실측 초 합계 기준) ──
  const byDoc = readingStats?.total_seconds_by_doc || {}
  const topPapers = Object.entries(byDoc)
    .map(([docId, seconds]) => ({ doc_id: docId, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 5)
  const topMaxSeconds = topPapers.length ? topPapers[0].seconds : 1

  const paperAnalyticsMap = analyticsSummary?.paper_stats || {}
  const topPapersHtml = topPapers.length ? topPapers.map((p, i) => {
    const doc = docsById.get(p.doc_id)
    const isDeleted = !doc || doc.is_deleted === 1
    // 삭제된 논문: titleByDoc(reading_time 스냅샷) → timelineDocTitles → '삭제된 논문' 순으로 fallback
    const deletedFallback = titleByDoc.get(p.doc_id) || timelineDocTitles.get(p.doc_id) || '삭제된 논문'
    const title = docTitle(p.doc_id, deletedFallback)
    const widthPct = Math.max(6, Math.round((p.seconds / topMaxSeconds) * 100))
    const pStat = paperAnalyticsMap[p.doc_id]
    const depth = pStat?.reading_depth || 'Opened'
    const depthCls = `depth-${depth.toLowerCase().replace(/\s+/g, '-')}`
    const score = pStat ? pStat.reading_score.toFixed(1) : '-'
    const verifiedPages = pStat ? pStat.verified_pages_count : '-'

    return `
      <div class="rh-top-row ${isDeleted ? 'is-deleted' : ''}" data-doc-id="${escapeHtml(p.doc_id || '')}" data-is-deleted="${isDeleted ? 'true' : 'false'}" title="${isDeleted ? '삭제된 논문입니다' : ''}">
        <span class="rh-top-rank">${i + 1}</span>
        <div class="rh-top-body">
          <div class="rh-top-title" style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
            <span>
              ${escapeHtml(title)}
              ${isDeleted ? '<span class="rh-deleted-badge">삭제됨</span>' : ''}
            </span>
            <span class="reading-depth-badge ${depthCls}">${escapeHtml(depth)}</span>
          </div>
          <div class="rh-top-track"><div class="rh-top-fill" style="width:${widthPct}%"></div></div>
          <div style="font-size:11px; color:var(--text-tertiary); margin-top:2px; display:flex; gap:10px;">
            <span>Score: <b>${score}</b></span>
            <span>Verified Pages: <b>${verifiedPages}</b></span>
          </div>
        </div>
        <span class="rh-top-value">${formatDuration(p.seconds)}</span>
      </div>`
  }).join('') : '<div class="rh-empty">아직 기록된 읽기 시간이 없습니다. 뷰어에서 논문을 열어 읽으면 자동으로 쌓입니다.</div>'

  // ── Reading Streak 위젯: 이번 주(월~일) ──
  const weekStartOffset = (keyToLocalDate(tKey).getDay() + 6) % 7
  const weekStartKey = addDaysKey(tKey, -weekStartOffset)
  const weekDayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
  const streakWeekHtml = weekDayLabels.map((label, i) => {
    const k = addDaysKey(weekStartKey, i)
    const isFuture = k > tKey
    const isToday = k === tKey
    const isActive = allActiveKeys.has(k)
    const cls = ['rh-streak-day']
    if (isActive) cls.push('active')
    if (isFuture) cls.push('future')
    if (isToday) cls.push('today')
    return `<span class="${cls.join(' ')}" title="${escapeHtml(formatShortDate(k))}">${label}</span>`
  }).join('')

  const initialCards = getStatCards('30')

  // ── HTML 조립 ──
  el.innerHTML = `
    <div class="rh-page">
      <div class="rh-header">
        <div>
          <p class="rh-header-subtitle">읽기 활동과 연구 여정을 확인하세요.</p>
        </div>
        <div class="rh-header-chips" id="rh-period-chips">
          <button type="button" class="rh-chip" data-period="7">${icon('calendar', 13)} 최근 7일</button>
          <button type="button" class="rh-chip active" data-period="30">${icon('calendar', 13)} 최근 30일</button>
          <button type="button" class="rh-chip" data-period="all">${icon('clock', 13)} 전체 기록</button>
        </div>
      </div>

      <div class="rh-stat-grid" id="rh-stat-grid">
        ${initialCards.map(c => `
          <div class="rh-stat-card">
            <div class="rh-stat-icon" style="--rh-stat-color:${c.color}">${icon(c.icon, 17)}</div>
            <div class="rh-stat-body">
              <div class="rh-stat-label">${escapeHtml(c.label)}</div>
              <div class="rh-stat-value">${c.value}</div>
              <div>${c.sub}</div>
            </div>
          </div>
        `).join('')}
      </div>

      ${renderReadingAnalyticsSummaryCard(analyticsSummary)}

      <div class="rh-columns">
        <div class="rh-col">
          <div class="rh-card">
            <div class="rh-card-head">
              <span class="rh-card-title">${icon('calendar', 15)} 읽기 활동</span>
              <div class="rh-cal-legend" title="검증 페이지와 실측 시간, 메모, 질문, 업로드를 종합 반영한 활동 포인트">
                적음
                <span class="rh-cal-legend-swatch rh-heat-0" style="background:color-mix(in srgb, var(--accent-mid) 6%, var(--bg-elevated))"></span>
                <span class="rh-cal-legend-swatch rh-heat-1" style="background:color-mix(in srgb, var(--accent-mid) 28%, var(--bg-elevated))"></span>
                <span class="rh-cal-legend-swatch rh-heat-2" style="background:color-mix(in srgb, var(--accent-mid) 50%, var(--bg-elevated))"></span>
                <span class="rh-cal-legend-swatch rh-heat-3" style="background:color-mix(in srgb, var(--accent-mid) 72%, var(--bg-elevated))"></span>
                <span class="rh-cal-legend-swatch rh-heat-4" style="background:var(--accent-mid)"></span>
                많음 (pt)
              </div>
            </div>
            <div class="rh-cal-scroll">
              <div class="rh-cal">
                <div class="rh-cal-months" style="grid-template-columns:repeat(${WEEKS}, 12px)">${monthsHtml}</div>
                <div class="rh-cal-body">
                  <div class="rh-cal-weekday-labels">${WEEKDAY_LABELS.map(l => `<span>${l}</span>`).join('')}</div>
                  <div class="rh-cal-grid" style="grid-template-columns:repeat(${WEEKS}, 12px)">${calGridHtml}</div>
                </div>
              </div>
            </div>
            <div class="rh-cal-footer">
              <span>${formatShortDate(gridStart)} &ndash; ${formatShortDate(gridEnd)}</span>
              <span>총 <b>${allActiveKeys.size}</b>일 활동 &bull; 최장 연속 <b>${streaks.longest}</b>일</span>
            </div>
          </div>

          <div class="rh-card">
            <div class="rh-card-head">
              <span class="rh-card-title">${icon('list', 15)} <span id="rh-timeline-title">최근 30일 활동</span></span>
            </div>
            <div class="rh-tabs" id="rh-filter-tabs">
              <button type="button" class="rh-tab-btn active" data-type="all">전체</button>
              ${TYPE_ORDER.map(t => `<button type="button" class="rh-tab-btn" data-type="${t}">${escapeHtml(TYPE_LABEL[t])}</button>`).join('')}
            </div>
            <div id="rh-timeline-list"></div>
            <button type="button" class="rh-more-btn hidden" id="rh-more-btn">${icon('chevronDown', 14)} 활동 더 보기</button>
          </div>
        </div>

        <div class="rh-col">
          <div class="rh-card">
            <div class="rh-card-head">
              <span class="rh-card-title">${icon('grid', 15)} 읽기 시간 분포</span>
              <span class="rh-card-sub">뷰어/비교 화면 실측 시간</span>
            </div>
            ${mixTotalSeconds > 0 ? `
              <div class="rh-mix-total">전체 누적: <b>${formatDuration(mixTotalSeconds)}</b></div>
              <div class="rh-mix-bar">${mixBarHtml}</div>
              <div class="rh-mix-legend">${mixLegendHtml}</div>
            ` : `<div class="rh-empty">아직 기록된 읽기 시간이 없습니다.</div>`}
          </div>

          <div class="rh-card">
            <div class="rh-card-head">
              <span class="rh-card-title">${icon('award', 15)} 읽기 시간 상위 논문</span>
            </div>
            <div class="rh-top-list">${topPapersHtml}</div>
          </div>

          <div class="rh-card">
            <div class="rh-card-head">
              <span class="rh-card-title">${icon('zap', 15)} 연속 읽기</span>
            </div>
            <div class="rh-streak-value">
              <span class="rh-streak-num">${streaks.current}</span>
              <span class="rh-streak-unit">일</span>
            </div>
            <div class="rh-streak-week">${streakWeekHtml}</div>
            <div class="rh-streak-msg">${streaks.current > 0 ? '계속 이어가세요!' : '오늘 논문을 읽고 연속 기록을 시작해보세요.'}</div>
          </div>

          <div class="rh-callout-row">
            <div class="rh-callout">
              <div class="rh-callout-icon" style="--rh-callout-color:var(--rh-c4)">${icon('award', 16)}</div>
              <div class="rh-callout-body">
                <div class="rh-callout-label">가장 활발했던 날</div>
                <div class="rh-callout-value">${bestDayScore ? `${bestDayScore}pt` : '&mdash;'}</div>
                <div class="rh-callout-sub">${bestDayKey ? `${formatShortDate(bestDayKey)}${bestDayDetail ? ' (' + escapeHtml(bestDayDetail) + ')' : ''}` : '아직 활동 없음'}</div>
              </div>
            </div>
            <div class="rh-callout">
              <div class="rh-callout-icon" style="--rh-callout-color:var(--success)">${icon('checkCircle', 16)}</div>
              <div class="rh-callout-body">
                <div class="rh-callout-label">최장 연속 기록</div>
                <div class="rh-callout-value">${streaks.longest}일</div>
                <div class="rh-callout-sub">${streaks.longestStart ? `${formatShortDate(streaks.longestStart)} &ndash; ${formatShortDate(streaks.longestEnd)}` : '아직 활동 없음'}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `

  // ── All Activities: 필터 + 더보기 상태 ──
  let currentPeriod = '30'
  let activeType = 'all'
  const INITIAL_GROUPS = 4
  let visibleGroups = INITIAL_GROUPS

  const timelineListEl = el.querySelector('#rh-timeline-list')
  const moreBtn = el.querySelector('#rh-more-btn')

  function renderStatGrid(period) {
    const gridEl = el.querySelector('#rh-stat-grid')
    if (!gridEl) return
    const cards = getStatCards(period)
    gridEl.innerHTML = cards.map(c => `
      <div class="rh-stat-card">
        <div class="rh-stat-icon" style="--rh-stat-color:${c.color}">${icon(c.icon, 17)}</div>
        <div class="rh-stat-body">
          <div class="rh-stat-label">${escapeHtml(c.label)}</div>
          <div class="rh-stat-value">${c.value}</div>
          <div>${c.sub}</div>
        </div>
      </div>
    `).join('')
  }

  const getTimelineEvents = () => {
    if (currentPeriod === '7') {
      return events.filter(e => {
        const k = eventKey(e)
        return k && k >= currStart7 && k < currEnd7
      })
    }
    if (currentPeriod === '30') {
      return events.filter(e => {
        const k = eventKey(e)
        return k && k >= currStart && k < currEnd
      })
    }
    return events
  }

  const groupByDay = (list) => {
    const groups = new Map()
    for (const e of list) {
      const k = eventKey(e)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(e)
    }
    return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }

  function getTimelineDayGroups() {
    const periodEvents = getTimelineEvents()
    const sortedEvents = periodEvents.slice().sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    const filtered = activeType === 'all' ? sortedEvents : sortedEvents.filter(e => e.type === activeType)
    return groupByDay(filtered)
  }

  function renderTimelineDay([dateKey, dayEvents]) {
    const { primary, secondary } = formatDayLabel(dateKey)
    return `
      <div class="rh-timeline-day">
        <div class="rh-timeline-day-header">
          <span class="rh-timeline-day-date">${escapeHtml(primary)}</span>
          <span class="rh-timeline-day-weekday">${escapeHtml(secondary)}</span>
        </div>
        <div class="rh-timeline-track">
          ${dayEvents.map(e => {
            const title = docTitle(e.doc_id, e.doc_title)
            const isDeleted = Boolean(e.is_deleted)
            let pageMeta = ''
            let timeLabel = formatTime(e.timestamp)
            let hoverTitle = isDeleted ? '삭제된 논문입니다' : '이 논문 열기'

            if (e.type === 'read' || e.type === 'browsed') {
              const startStr = formatTime(e.timestamp)
              const endStr = e.end_timestamp ? formatTime(e.end_timestamp) : null
              if (startStr && endStr && startStr !== endStr) {
                timeLabel = `${startStr} ~ ${endStr}`
                hoverTitle = isDeleted ? `삭제된 논문입니다 (읽기 시간: ${startStr} ~ ${endStr})` : `읽기 시간: ${startStr} 시작 ~ ${endStr} 종료 | 클릭하여 이 논문 열기`
              } else if (startStr) {
                timeLabel = startStr
                hoverTitle = isDeleted ? `삭제된 논문입니다 (읽기 시각: ${startStr})` : `읽기 시각: ${startStr} | 클릭하여 이 논문 열기`
              }

              if (e.start_page && e.end_page) {
                const range = e.start_page === e.end_page ? `${e.start_page}p` : `${e.start_page}p ~ ${e.end_page}p`
                const verified = e.verified_pages ?? 0
                pageMeta = `${range} (${verified}p 검증)`
              } else if (e.verified_pages !== null && e.verified_pages !== undefined) {
                pageMeta = `${e.verified_pages}p 검증`
              } else {
                const p = readPageCount(docsById.get(e.doc_id))
                if (p) pageMeta = `${p}페이지`
              }
            }
            return `
              <div class="rh-timeline-entry ${isDeleted ? 'is-deleted' : ''}" data-doc-id="${escapeHtml(e.doc_id || '')}" data-type="${escapeHtml(e.type)}" data-is-deleted="${isDeleted ? 'true' : 'false'}" title="${escapeHtml(hoverTitle)}">
                <div class="rh-timeline-dot">${icon(TYPE_ICON[e.type] || 'clock', 13)}</div>
                <div class="rh-timeline-row">
                  <span class="rh-timeline-time">${escapeHtml(timeLabel)}</span>
                  <span class="rh-timeline-type">${escapeHtml(TYPE_LABEL[e.type] || e.type)}</span>
                  <div class="rh-timeline-main">
                    <div class="rh-timeline-title">
                      ${escapeHtml(title)}
                      ${isDeleted ? '<span class="rh-deleted-badge">삭제됨</span>' : ''}
                    </div>
                    ${e.summary ? `<div class="rh-timeline-summary">${escapeHtml(e.summary)}</div>` : ''}
                  </div>
                  ${pageMeta ? `<span class="rh-timeline-meta">${escapeHtml(pageMeta)}</span>` : ''}
                </div>
              </div>`
          }).join('')}
        </div>
      </div>`
  }

  function updateMoreButton(dayGroups) {
    moreBtn.classList.toggle('hidden', visibleGroups >= dayGroups.length)
  }

  function renderTimeline() {
    const dayGroups = getTimelineDayGroups()
    if (dayGroups.length === 0) {
      timelineListEl.innerHTML = '<div class="rh-empty">이 기간의 활동이 아직 없습니다.</div>'
      moreBtn.classList.add('hidden')
      return
    }
    const shown = dayGroups.slice(0, visibleGroups)
    timelineListEl.innerHTML = `<div class="rh-timeline">${shown.map(renderTimelineDay).join('')}</div>`
    updateMoreButton(dayGroups)
  }

  function appendTimelineGroups() {
    const dayGroups = getTimelineDayGroups()
    const timelineEl = timelineListEl.querySelector('.rh-timeline')
    if (!timelineEl) {
      renderTimeline()
      return
    }
    const nextVisibleGroups = Math.min(visibleGroups + 6, dayGroups.length)
    const nextGroups = dayGroups.slice(visibleGroups, nextVisibleGroups)
    timelineEl.insertAdjacentHTML('beforeend', nextGroups.map(renderTimelineDay).join(''))
    visibleGroups = nextVisibleGroups
    updateMoreButton(dayGroups)
  }

  const periodChipsEl = el.querySelector('#rh-period-chips')
  periodChipsEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('.rh-chip')
    if (!btn || btn.classList.contains('active')) return
    periodChipsEl.querySelectorAll('.rh-chip').forEach(b => b.classList.toggle('active', b === btn))
    currentPeriod = btn.dataset.period
    renderStatGrid(currentPeriod)
    const titleEl = el.querySelector('#rh-timeline-title')
    if (titleEl) {
      titleEl.textContent = currentPeriod === '7' ? '최근 7일 활동' : currentPeriod === '30' ? '최근 30일 활동' : '전체 활동'
    }
    visibleGroups = INITIAL_GROUPS
    renderTimeline()
  })

  const tabsEl = el.querySelector('#rh-filter-tabs')
  tabsEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('.rh-tab-btn')
    if (!btn) return
    tabsEl.querySelectorAll('.rh-tab-btn').forEach(b => b.classList.toggle('active', b === btn))
    activeType = btn.dataset.type
    visibleGroups = INITIAL_GROUPS
    renderTimeline()
  })

  moreBtn?.addEventListener('click', () => {
    appendTimelineGroups()
  })

  const openDoc = (docId, type) => {
    if (!docId) return
    location.hash = 'viewer?id=' + encodeURIComponent(docId) + (type === 'question' ? '&chat=1' : '')
  }

  timelineListEl.addEventListener('click', (event) => {
    const entry = event.target.closest('.rh-timeline-entry')
    if (!entry) return
    if (entry.dataset.isDeleted === 'true') return
    openDoc(entry.dataset.docId, entry.dataset.type)
  })

  el.querySelector('.rh-top-list')?.addEventListener('click', (event) => {
    const row = event.target.closest('.rh-top-row')
    if (!row) return
    if (row.dataset.isDeleted === 'true') return
    openDoc(row.dataset.docId)
  })

  const calGridEl = el.querySelector('.rh-cal-grid')
  if (calGridEl) {
    calGridEl.addEventListener('mouseover', (event) => {
      const cell = event.target.closest('.rh-cal-cell[data-tooltip]')
      if (cell) showRhTooltip(cell)
    })
    calGridEl.addEventListener('mouseout', (event) => {
      if (event.target.closest('.rh-cal-cell[data-tooltip]')) hideRhTooltip()
    })
  }

  renderTimeline()
}

