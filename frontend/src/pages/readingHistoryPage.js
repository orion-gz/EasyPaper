// Reading History 페이지
//
// "읽은 시간"은 main.js의 읽기 시간 하트비트(뷰어/비교 화면이 보이고 포커스된
// 동안 5초 tick으로 현재 문서+카테고리에 적립 → 20초마다 서버로 flush,
// POST /library/{doc_id}/reading-heartbeat)가 쌓은 실측치를
// fetchReadingTimeStats()로 집계해서 쓴다. 카테고리는 실제로 구분 가능한 화면
// 상태 3가지뿐이다: reading(뷰어 기본) / chat(채팅 사이드바 열림) /
// compare(논문 비교 채팅). 이 기능을 도입하기 전에 만든 페이지라 이 시점
// 이전의 활동에는 시간 데이터가 없을 수 있다 - 그런 경우 위젯은 "아직 기록된
// 읽기 시간이 없습니다"로 정직하게 표시한다.

import { fetchLibraryTimeline, fetchLibraryDashboard, fetchLibrary, fetchReadingTimeStats } from '../library.js'
import { icon } from '../icons.js'
import { readPageCount, lastActivityIso, hasReadActivity, lastActivityDateKey, isoToLocalDateKey } from '../readPages.js'
import '../styles/reading-history.css'

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const TYPE_LABEL = { uploaded: '업로드', read: '읽음', question: '질문', note: '메모' }
const TYPE_ICON = { uploaded: 'archive', read: 'bookOpen', question: 'messageCircle', note: 'edit3' }
// 활동 구성 막대(part-to-whole)의 분류 색 - dataviz 팔레트의 앞 4개 슬롯을
// 고정 순서(blue→orange→aqua→yellow)로만 사용해 색맹 인접성 검증을 그대로 유지한다.
const TYPE_COLOR_VAR = { read: '--rh-c1', question: '--rh-c2', note: '--rh-c3', uploaded: '--rh-c4' }
const TYPE_ORDER = ['read', 'question', 'note', 'uploaded']

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

// ── 개인 맞춤형 읽기 페이스(EMA: Exponential Moving Average) 및 활동 데이터 집계 ──
// 사용자의 실측 읽기 시간(하트비트)과 이동/완독 이력을 지수이동평균(EMA)으로 학습하여
// 개인 맞춤형 초/페이지 페이스(Pace)를 산출합니다.
// - 기본 초기 기준 페이스: 240초 (4분/페이지)
// - 10초 미만의 스크롤 이동 및 10분(600초) 이상의 자리비움 이상치는 EMA 학습에서 제외
// - 유효 학습 구간: 60초 ~ 480초 (1분 ~ 8분/페이지)
const DEFAULT_PACE_SEC = 240 // 초기 기준 4분/페이지
const ALPHA = 0.2 // EMA 감쇠 비율

function computeUserReadingPace(byDayMap) {
  let currentEma = DEFAULT_PACE_SEC
  const sortedEntries = Array.from(byDayMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))

  for (const [_, item] of sortedEntries) {
    if (item.readingSeconds <= 0) continue

    let pages = item.readEvents
    if (pages === 0 && item.readingSeconds >= 60) {
      pages = Math.max(1, Math.round(item.readingSeconds / currentEma))
    }

    if (pages > 0) {
      const dailyPace = item.readingSeconds / pages
      // 유효 페이스 구간(60초 ~ 600초) 내 데이터만 EMA 업데이트에 포함해 이상치(스크롤/부재) 제거
      if (dailyPace >= 60 && dailyPace <= 600) {
        currentEma = ALPHA * dailyPace + (1 - ALPHA) * currentEma
      }
    }
  }

  return Math.max(60, Math.min(480, Math.round(currentEma)))
}

function buildDailyActivityStats(events, readingStats) {
  const byDay = new Map()

  function getOrCreate(key) {
    if (!byDay.has(key)) {
      byDay.set(key, {
        readingSeconds: 0,
        estPagesRead: 0,
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
    else if (e.type === 'read') {
      item.readEvents += 1
      item.verifiedPages = (item.verifiedPages || 0) + (e.verified_pages || 1)
    }
  }

  // 3. EMA 기반 개인 맞춤형 읽기 페이스(초/페이지) 학습
  const userPaceSec = computeUserReadingPace(byDay)

  // 4. 일별 활동 점수 및 검증된 실제 읽은 페이지 계산
  for (const [_, item] of byDay.entries()) {
    if (item.readingSeconds > 0) {
      item.estPagesRead = Math.floor(item.readingSeconds / userPaceSec)
    }
    const displayPages = item.verifiedPages || item.estPagesRead || 0

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

  byDay.userPaceSec = userPaceSec
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
  const pages = item.verifiedPages || item.estPagesRead || 0
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

function periodStats(events, docsById, startKey, endKeyExclusive) {
  const inPeriod = events.filter(e => {
    const k = eventKey(e)
    return k && k >= startKey && k < endKeyExclusive
  })
  const activeDays = new Set(inPeriod.map(eventKey)).size

  // 단순히 뷰어를 1초 열어보기만 해서 last_read_at만 갱신된 문서는 제외하고,
  // 해당 기간 내 실측 read 세션 이벤트가 있거나 완독(read_at) 표시된 문서만 계산
  const readDocIds = new Set(inPeriod.filter(e => e.type === 'read').map(e => e.doc_id))
  const activePageDocIds = new Set()
  for (const id of readDocIds) {
    const doc = docsById.get(id)
    if (doc) activePageDocIds.add(id)
  }
  for (const doc of docsById.values()) {
    const meta = doc?.metadata || {}
    if (meta.read && meta.read_at) {
      const k = isoToLocalDateKey(meta.read_at)
      if (k && k >= startKey && k < endKeyExclusive) {
        activePageDocIds.add(doc.id)
      }
    }
  }

  const pagesRead = Array.from(activePageDocIds).reduce((sum, id) => sum + readPageCount(docsById.get(id)), 0)
  const questions = inPeriod.filter(e => e.type === 'question').length
  const notes = inPeriod.filter(e => e.type === 'note').length
  return { activeDays, papersRead: activePageDocIds.size, pagesRead, questions, notes }
}

function deltaHtml(curr, prev, unit = '') {
  const diff = curr - prev
  if (diff === 0) return `<span class="rh-stat-delta">±0${unit ? ' ' + unit : ''} 이전 30일 대비</span>`
  const cls = diff > 0 ? 'up' : 'down'
  const arrow = diff > 0 ? '↑' : '↓'
  return `<span class="rh-stat-delta ${cls}">${arrow} ${Math.abs(diff).toLocaleString()}${unit ? ' ' + unit : ''} 이전 30일 대비</span>`
}

// ── 읽기 시간 포맷/집계 헬퍼 ──────────────────────────────────
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return s > 0 ? `${s}s` : '0m'
}
function deltaDurationHtml(currSeconds, prevSeconds) {
  const diff = Math.round(currSeconds - prevSeconds)
  if (diff === 0) return `<span class="rh-stat-delta">±0m 이전 30일 대비</span>`
  const cls = diff > 0 ? 'up' : 'down'
  const arrow = diff > 0 ? '↑' : '↓'
  return `<span class="rh-stat-delta ${cls}">${arrow} ${formatDuration(Math.abs(diff))} 이전 30일 대비</span>`
}
function sumSecondsByDayRange(byDay, startKey, endKeyExclusive) {
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
export async function renderReadingHistoryPage() {
  const el = document.getElementById('page-history')
  if (!el) return

  hideRhTooltip() // 다른 페이지로 이동한 뒤에도 뜬 채로 남아있지 않도록
  el.innerHTML = '<div class="rh-page"><div class="rh-empty">읽기 기록을 불러오는 중...</div></div>'

  let events = []
  let dashboard = null
  let libraryDocs = []
  let readingStats = null
  try {
    const [timelineRes, dashboardRes, libraryRes, readingStatsRes] = await Promise.all([
      fetchLibraryTimeline(),
      fetchLibraryDashboard().catch(() => null),
      fetchLibrary().catch(() => ({ documents: [] })),
      fetchReadingTimeStats().catch(() => null),
    ])
    events = timelineRes?.events || []
    dashboard = dashboardRes
    libraryDocs = libraryRes?.documents || []
    readingStats = readingStatsRes
  } catch (err) {
    console.error('Reading History 로드 실패:', err)
    el.innerHTML = '<div class="rh-page"><div class="rh-empty" style="color:var(--error)">읽기 기록을 불러오지 못했습니다.</div></div>'
    return
  }

  if (document.getElementById('page-history') !== el) return // 페이지 전환됨

  const docsById = new Map(libraryDocs.map(d => [d.id, d]))
  const docTitle = (docId, fallback) => {
    const d = docsById.get(docId)
    return (d?.metadata?.title) || d?.filename || fallback || '제목 없음'
  }

  if (events.length === 0) {
    el.innerHTML = `
      <div class="rh-page">
        <div class="rh-header">
          <div>
            <p class="rh-header-subtitle">읽기 활동과 연구 여정을 확인하세요.</p>
          </div>
        </div>
        <div class="rh-card"><div class="rh-empty">아직 활동 기록이 없습니다. 논문을 업로드하고 읽으면 기록이 쌓입니다.</div></div>
      </div>`
    return
  }

  // ── 스탯 카드: 최근 30일 vs 그 이전 30일 ──
  const tKey = todayKey()
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
  const currReadingSeconds = sumSecondsByDayRange(byDay, currStart, currEnd)
  const prevReadingSeconds = sumSecondsByDayRange(byDay, prevStart, prevEnd)

  // 일별 종합 활동 스탯 집계 (질문 편향 보정 + EMA 개인 읽기 페이스 학습)
  const dailyStatsMap = buildDailyActivityStats(events, readingStats)
  const userPaceSec = dailyStatsMap.userPaceSec

  // EMA 정독 시간 기반 환산 페이지 수 합산
  const sumEstPagesByDayRange = (startKey, endKeyExclusive) => {
    let sum = 0
    for (const [day, item] of dailyStatsMap.entries()) {
      if (day >= startKey && day < endKeyExclusive) {
        sum += item.estPagesRead
      }
    }
    return sum
  }

  const currEstPages = sumEstPagesByDayRange(currStart, currEnd)
  const prevEstPages = sumEstPagesByDayRange(prevStart, prevEnd)

  // 완독 표시(read === true)된 문서의 참고문헌 제외 본문 전체 페이지 수(readPageCount) 및 세션/하트비트 실측치 중 강건(Robust)하게 최대치 집계
  const currPagesReadDisplay = Math.max(curr.pagesRead, currEstPages)
  const prevPagesReadDisplay = Math.max(prev.pagesRead, prevEstPages)

  let totalEstPages = 0
  for (const item of dailyStatsMap.values()) {
    totalEstPages += item.estPagesRead
  }
  const fallbackTotalReadPages = dashboard?.stats?.read_pages ?? Array.from(docsById.values()).reduce((sum, d) => sum + readPageCount(d), 0)
  const totalReadPagesDisplay = Math.max(fallbackTotalReadPages, totalEstPages)

  const allActiveKeys = new Set(
    Array.from(dailyStatsMap.entries())
      .filter(([_, item]) => item.score > 0)
      .map(([k, _]) => k)
  )

  const CATEGORY_LABEL = { reading: '논문 읽기', chat: 'AI 채팅', compare: '논문 비교' }
  const CATEGORY_COLOR_VAR = { reading: '--rh-c1', chat: '--rh-c2', compare: '--rh-c5' }
  const CATEGORY_ORDER = ['reading', 'chat', 'compare']
  const byCategory = readingStats?.total_seconds_by_category || {}
  const mixTotalSeconds = CATEGORY_ORDER.reduce((s, c) => s + (byCategory[c] || 0), 0)

  const allReadingSeconds = mixTotalSeconds > 0
    ? mixTotalSeconds
    : Object.values(byDay).reduce((sum, sec) => sum + (Number(sec) || 0), 0)

  const getStatCards = (period) => {
    if (period === 'all') {
      return [
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
        icon: 'calendar', color: 'var(--rh-c1)', label: '활동일',
        value: `${curr.activeDays} / 30`,
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
        value: curr.questions.toLocaleString(),
        sub: deltaHtml(curr.questions, prev.questions),
      },
      {
        icon: 'edit3', color: 'var(--rh-c2)', label: '작성한 메모',
        value: curr.notes.toLocaleString(),
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
  // reading(뷰어에서 읽는 중) / chat(채팅 사이드바 사용 중) / compare(논문 비교).
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

  const topPapersHtml = topPapers.length ? topPapers.map((p, i) => {
    const title = docTitle(p.doc_id)
    const widthPct = Math.max(6, Math.round((p.seconds / topMaxSeconds) * 100))
    return `
      <div class="rh-top-row" data-doc-id="${escapeHtml(p.doc_id || '')}">
        <span class="rh-top-rank">${i + 1}</span>
        <div class="rh-top-body">
          <div class="rh-top-title">${escapeHtml(title)}</div>
          <div class="rh-top-track"><div class="rh-top-fill" style="width:${widthPct}%"></div></div>
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

      <div class="rh-columns">
        <div class="rh-col">
          <div class="rh-card">
            <div class="rh-card-head">
              <span class="rh-card-title">${icon('calendar', 15)} 읽기 활동</span>
              <div class="rh-cal-legend" title="개인 읽기 페이스(EMA 학습)와 실측 시간, 메모, 질문, 업로드를 종합 반영한 활동 포인트">
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

  function renderTimeline() {
    const periodEvents = getTimelineEvents()
    const sortedEvents = periodEvents.slice().sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    const filtered = activeType === 'all' ? sortedEvents : sortedEvents.filter(e => e.type === activeType)
    if (filtered.length === 0) {
      timelineListEl.innerHTML = '<div class="rh-empty">이 기간의 활동이 아직 없습니다.</div>'
      moreBtn.classList.add('hidden')
      return
    }
    const dayGroups = groupByDay(filtered)
    const shown = dayGroups.slice(0, visibleGroups)
    timelineListEl.innerHTML = `<div class="rh-timeline">${shown.map(([dateKey, dayEvents]) => {
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
              let pageMeta = ''
              let timeLabel = formatTime(e.timestamp)
              let hoverTitle = '이 논문 열기'

              if (e.type === 'read') {
                const startStr = formatTime(e.timestamp)
                const endStr = e.end_timestamp ? formatTime(e.end_timestamp) : null
                if (startStr && endStr) {
                  timeLabel = `${startStr} ~ ${endStr}`
                  hoverTitle = `읽기 시간: ${startStr} 시작 ~ ${endStr} 종료 | 클릭하여 이 논문 열기`
                } else if (startStr) {
                  hoverTitle = `읽기 시작: ${startStr} | 클릭하여 이 논문 열기`
                }

                if (e.start_page && e.end_page) {
                  const range = e.start_page === e.end_page ? `${e.start_page}p` : `${e.start_page}p ~ ${e.end_page}p`
                  const verified = e.verified_pages || 1
                  pageMeta = `${range} (${verified}p 정독)`
                } else {
                  const p = readPageCount(docsById.get(e.doc_id))
                  if (p) pageMeta = `${p}페이지`
                }
              }
              return `
                <div class="rh-timeline-entry" data-doc-id="${escapeHtml(e.doc_id || '')}" data-type="${escapeHtml(e.type)}" title="${escapeHtml(hoverTitle)}">
                  <div class="rh-timeline-dot">${icon(TYPE_ICON[e.type] || 'clock', 13)}</div>
                  <div class="rh-timeline-row">
                    <span class="rh-timeline-time">${escapeHtml(timeLabel)}</span>
                    <span class="rh-timeline-type">${escapeHtml(TYPE_LABEL[e.type] || e.type)}</span>
                    <div class="rh-timeline-main">
                      <div class="rh-timeline-title">${escapeHtml(title)}</div>
                      ${e.summary ? `<div class="rh-timeline-summary">${escapeHtml(e.summary)}</div>` : ''}
                    </div>
                    ${pageMeta ? `<span class="rh-timeline-meta">${escapeHtml(pageMeta)}</span>` : ''}
                  </div>
                </div>`
            }).join('')}
          </div>
        </div>`
    }).join('')}</div>`

    moreBtn.classList.toggle('hidden', shown.length >= dayGroups.length)
  }

  const periodChipsEl = el.querySelector('#rh-period-chips')
  periodChipsEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('.rh-chip')
    if (!btn || btn.classList.contains('active')) return
    periodChipsEl.querySelectorAll('.rh-chip').forEach(b => b.classList.toggle('active', b === btn))
    currentPeriod = btn.dataset.period
    renderStatGrid(currentPeriod)
    const titleEl = el.querySelector('#rh-timeline-title')
    if (titleEl) titleEl.textContent = currentPeriod === '30' ? '최근 30일 활동' : '전체 활동'
    visibleGroups = INITIAL_GROUPS
    renderTimeline()
  })

  const tabsEl = el.querySelector('#rh-filter-tabs')
  tabsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.rh-tab-btn')
    if (!btn) return
    tabsEl.querySelectorAll('.rh-tab-btn').forEach(b => b.classList.toggle('active', b === btn))
    activeType = btn.dataset.type
    visibleGroups = INITIAL_GROUPS
    renderTimeline()
  })

  moreBtn.addEventListener('click', () => {
    visibleGroups += 6
    renderTimeline()
  })

  const openDoc = (docId, type) => {
    if (!docId) return
    location.hash = 'viewer?id=' + encodeURIComponent(docId) + (type === 'question' ? '&chat=1' : '')
  }

  timelineListEl.addEventListener('click', (event) => {
    const entry = event.target.closest('.rh-timeline-entry')
    if (!entry) return
    openDoc(entry.dataset.docId, entry.dataset.type)
  })

  el.querySelector('.rh-top-list')?.addEventListener('click', (event) => {
    const row = event.target.closest('.rh-top-row')
    if (!row) return
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

