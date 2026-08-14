// 문서 하나에서 실제로 "읽은" 것으로 볼 수 있는 페이지 수를 계산한다:
// 완독 표시(metadata.read)된 문서는 참고문헌을 제외한 본문 페이지 수
// 전체를, 읽던 중인 문서(metadata.last_page만 있음)는 그 진행률(참고문헌
// 페이지를 넘지 않게 상한)을, 둘 다 아니면 0을 반환한다. 대시보드/Reading
// History의 "읽은 페이지" 계열 통계가 전부 이 함수를 공유해야 같은 논문을
// 두 화면에서 다르게 세는 일이 없다(백엔드 services/library.py의
// read_page_count와 동일한 공식).
export function readPageCount(doc) {
  const meta = (doc && doc.metadata) || {}
  const total = doc?.total_pages || 0
  const refStart = meta.reference_start_page
  const contentPages = (Number.isInteger(refStart) && refStart > 1 && refStart <= total) ? refStart - 1 : total

  if (meta.read === true) return contentPages
  const lastPage = meta.last_page
  if (Number.isInteger(lastPage)) return Math.min(lastPage, contentPages)
  return 0
}

// 타임라인 세션이 내려준 실제 검증 페이지를 (논문, 페이지) 단위로 합친다.
// 같은 페이지를 여러 세션 또는 여러 날에 다시 읽어도 기간 통계에서는 한 번만 센다.
export function uniqueVerifiedPageKeys(events) {
  const keys = new Set()
  for (const event of events || []) {
    if (event?.type !== 'read' && event?.type !== 'browsed') continue
    if (!event.doc_id || !Array.isArray(event.verified_page_numbers)) continue
    for (const page of event.verified_page_numbers) {
      if (Number.isInteger(page) && page > 0) keys.add(`${event.doc_id}:${page}`)
    }
  }
  return keys
}

export function countUniqueVerifiedPages(events) {
  return uniqueVerifiedPageKeys(events).size
}

// last_read_at(뷰어를 열거나 페이지를 넘길 때마다 갱신되는 "마지막으로
// 읽은 시각") / read_at(완독 표시 시각) / createdAt(업로드 시각) 중 가장
// 최근 값을 고른다. read_at만 보면 완독 표시를 안 하고 읽던 중인 논문은
// 계속 createdAt으로 떨어져, 방금 읽었어도 날짜가 업로드 시점에 고정되어
// 보이는 문제가 있었다. 대시보드 "최근 읽은 논문"/"이번 주 활동"과 Reading
// History의 기간별 통계가 전부 이 함수를 공유한다.
export function lastActivityIso(meta, createdAt) {
  return [meta?.last_read_at, meta?.read_at, createdAt]
    .filter(Boolean)
    .reduce((latest, iso) => (new Date(iso) > new Date(latest) ? iso : latest), createdAt)
}

// 이 문서에 실제 "읽기 활동"(완독 표시 또는 읽던 중 진행)이 한 번이라도
// 있었는지. last_read_at/read_at이 둘 다 없으면 업로드만 됐을 뿐 읽은 적이
// 없는 문서이므로, "읽은 페이지" 계열 통계에서 lastActivityIso가 createdAt로
// 떨어지는 폴백값을 활동 시각으로 오인해 집계하면 안 된다.
export function hasReadActivity(meta) {
  return Boolean(meta?.last_read_at || meta?.read_at)
}

// Library의 "최근 읽은 순"은 업로드 시각을 읽기 활동으로 간주하지 않는다.
// last_read_at/read_at 중 유효한 최신 시각을 사용하고, 읽은 기록이 없는 문서는
// -Infinity로 두어 목록 뒤로 보낸다.
export function lastReadTimestamp(meta) {
  const timestamps = [meta?.last_read_at, meta?.read_at]
    .map(value => Date.parse(value))
    .filter(Number.isFinite)
  return timestamps.length > 0 ? Math.max(...timestamps) : -Infinity
}

export function compareDocsByLastRead(a, b) {
  const aReadAt = lastReadTimestamp(a?.metadata)
  const bReadAt = lastReadTimestamp(b?.metadata)
  if (aReadAt !== bReadAt) return bReadAt > aReadAt ? 1 : -1

  const createdTimestamp = doc => {
    const value = Date.parse(doc?.created_at)
    return Number.isFinite(value) ? value : -Infinity
  }
  return createdTimestamp(b) - createdTimestamp(a)
}

// ISO 타임스탬프 문자열을 사용자 로컬 시간대 자정 기준 "YYYY-MM-DD" 날짜 키로 변환한다.
// 단순 .slice(0, 10)을 하면 UTC 날짜가 잘려 나와 한국 시간(KST) 등에서 9시간 시차
// 어긋남이 발생하므로, local Date 객체의 연/월/일을 사용한다.
export function localDateToKey(d) {
  if (!d || isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayKey() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return localDateToKey(d)
}

export function keyToLocalDate(key) {
  return new Date(`${key}T00:00:00`)
}

export function addDaysKey(key, delta) {
  const d = keyToLocalDate(key)
  if (isNaN(d.getTime())) return key
  d.setDate(d.getDate() + delta)
  return localDateToKey(d)
}

export function isoToLocalDateKey(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return localDateToKey(d)
}

export function lastActivityDateKey(meta, createdAt) {
  const iso = lastActivityIso(meta, createdAt)
  return isoToLocalDateKey(iso)
}

// ISO 시각이 로컬 시간 자정 기준 최근 N일(days) 이내인지 판별한다.
export function isWithinDaysLocal(iso, days) {
  if (!iso) return false
  const key = isoToLocalDateKey(iso)
  if (!key) return false
  const tKey = todayKey()
  const startKey = addDaysKey(tKey, -(days - 1))
  const endKeyExclusive = addDaysKey(tKey, 1)
  return key >= startKey && key < endKeyExclusive
}

// 타임라인 이벤트의 날짜 키(로컬 자정 기준) 집합을 모아 오늘/어제 기준 연속 활동일을 계산한다.
export function computeStreakDays(events) {
  const dates = new Set()
  for (const e of events || []) {
    const k = isoToLocalDateKey(e.timestamp)
    if (k) dates.add(k)
  }
  if (dates.size === 0) return 0

  const tKey = todayKey()
  const yKey = addDaysKey(tKey, -1)
  let cursor = dates.has(tKey) ? tKey : (dates.has(yKey) ? yKey : null)
  if (!cursor) return 0

  let streak = 0
  while (dates.has(cursor)) {
    streak++
    cursor = addDaysKey(cursor, -1)
  }
  return streak
}


