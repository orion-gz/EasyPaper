const API_BASE = '/api'
const SHARED_GET_TTL_MS = 5000
const sharedGetCache = new Map()

async function fetchJsonWithSharedTtl(url, errorMessage) {
  const now = Date.now()
  const cached = sharedGetCache.get(url)
  if (cached && now - cached.createdAt < SHARED_GET_TTL_MS) return cached.promise

  const promise = fetch(url).then(async res => {
    if (!res.ok) throw new Error(errorMessage)
    return res.json()
  })
  sharedGetCache.set(url, { createdAt: now, promise })
  promise.catch(() => {
    if (sharedGetCache.get(url)?.promise === promise) sharedGetCache.delete(url)
  })
  return promise
}

export function invalidateLibraryGetCache() {
  sharedGetCache.clear()
}

function buildQuery(options) {
  if (!options || !options.targetLang) return ''
  const { targetLang, style, ignoreMath, ignoreTable, ignoreRefs } = options
  return `?target_lang=${encodeURIComponent(targetLang)}&style=${style}&ignore_math=${ignoreMath}&ignore_table=${ignoreTable}&ignore_refs=${ignoreRefs}`
}

export async function fetchLibrary(options = {}) {
  return fetchJsonWithSharedTtl(`${API_BASE}/library${buildQuery(options)}`, '라이브러리 조회 실패')
}


export async function fetchLibraryFolders() {
  const res = await fetch(`${API_BASE}/library/folders`)
  if (!res.ok) throw new Error('폴더 조회 실패')
  return res.json()
}
export async function createLibraryFolder(payload) {
  const res = await fetch(`${API_BASE}/library/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (!res.ok) throw new Error((await res.json()).detail || '폴더 생성 실패')
  invalidateLibraryGetCache()
  return res.json()
}
export async function updateLibraryFolder(folderId, payload) {
  const res = await fetch(`${API_BASE}/library/folders/${encodeURIComponent(folderId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (!res.ok) throw new Error((await res.json()).detail || '폴더 수정 실패')
  invalidateLibraryGetCache()
  return res.json()
}
export async function deleteLibraryFolder(folderId, deletePapers = false) {
  const res = await fetch(`${API_BASE}/library/folders/${encodeURIComponent(folderId)}?delete_papers=${deletePapers}`, { method: 'DELETE' })
  if (!res.ok) throw new Error((await res.json()).detail || '폴더 삭제 실패')
  invalidateLibraryGetCache()
  return res.json()
}
export async function moveLibraryDocuments(docIds, folderId) {
  const res = await fetch(`${API_BASE}/library/documents/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_ids: docIds, folder_id: folderId }) })
  if (!res.ok) throw new Error((await res.json()).detail || '논문 이동 실패')
  invalidateLibraryGetCache()
  return res.json()
}

export async function fetchLibraryDoc(docId, options = {}) {
  const res = await fetch(`${API_BASE}/library/${docId}${buildQuery(options)}`)
  if (!res.ok) throw new Error('문서 조회 실패')
  return res.json()
}

export async function fetchLibraryTranslation(docId, pageNum, options = {}) {
  const res = await fetch(`${API_BASE}/library/${docId}/translation/${pageNum}${buildQuery(options)}`)
  if (!res.ok) throw new Error('번역 조회 실패')
  return res.json()
}

export async function deleteLibraryDoc(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('삭제 실패')
  invalidateLibraryGetCache()
  return res.json()
}

export async function fetchLibraryDocImages(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}/images`)
  if (!res.ok) throw new Error('이미지 정보 조회 실패')
  return res.json()
}

export async function updateLibraryDocMetadata(docId, payload) {
  const res = await fetch(`${API_BASE}/library/${docId}/metadata`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error('메타데이터 업데이트 실패')
  invalidateLibraryGetCache()
  return res.json()
}

export async function updateLibraryTranslation(docId, pageNum, payload, options = {}) {
  const res = await fetch(`${API_BASE}/library/${docId}/translation/${pageNum}${buildQuery(options)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error('번역 수정 저장 실패')
  invalidateLibraryGetCache()
  return res.json()
}
export async function exportAnnotatedPdf(docId, payload) {
  const res = await fetch(`${API_BASE}/library/${docId}/export-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) {
    let message = 'PDF 내보내기 실패'
    try {
      const err = await res.json()
      message = err.detail || message
    } catch {
      // JSON이 아닌 경우 기본 메시지 사용
    }
    throw new Error(message)
  }
  return res.blob()
}

// 하이라이트/주석·메모의 서버 미러. localStorage가 원본(source of truth)이며
// 이 함수들은 다중 기기 동기화를 위한 best-effort 백업 용도로만 쓰인다.
export async function fetchLibraryAnnotations(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}/annotations`)
  if (!res.ok) {
    let message = '주석 조회 실패'
    try {
      const err = await res.json()
      message = err.detail || message
    } catch {
      // JSON이 아닌 경우 기본 메시지 사용
    }
    throw new Error(message)
  }
  return res.json()
}

export async function putLibraryAnnotations(docId, data) {
  const res = await fetch(`${API_BASE}/library/${docId}/annotations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  })
  if (!res.ok) {
    let message = '주석 저장 실패'
    try {
      const err = await res.json()
      message = err.detail || message
    } catch {
      // JSON이 아닌 경우 기본 메시지 사용
    }
    throw new Error(message)
  }
  invalidateLibraryGetCache()
  return res.json()
}

export async function fetchLibraryMemos(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}/memos`)
  if (!res.ok) {
    let message = '메모 조회 실패'
    try {
      const err = await res.json()
      message = err.detail || message
    } catch {
      // JSON이 아닌 경우 기본 메시지 사용
    }
    throw new Error(message)
  }
  return res.json()
}

export async function putLibraryMemos(docId, data) {
  const res = await fetch(`${API_BASE}/library/${docId}/memos`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  })
  if (!res.ok) {
    let message = '메모 저장 실패'
    try {
      const err = await res.json()
      message = err.detail || message
    } catch {
      // JSON이 아닌 경우 기본 메시지 사용
    }
    throw new Error(message)
  }
  invalidateLibraryGetCache()
  return res.json()
}

export async function searchLibrary(query) {
  const res = await fetch(`${API_BASE}/library/search?q=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error('검색 실패')
  return res.json()
}

export async function fetchLibraryReferences(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}/references`)
  if (!res.ok) throw new Error('참고문헌 목록 조회 실패')
  return res.json()
}

export async function resolveLibraryReference(docId, refNum) {
  const res = await fetch(`${API_BASE}/library/${docId}/references/${encodeURIComponent(refNum)}`)
  if (!res.ok) {
    if (res.status === 404) return null
    throw new Error('참고문헌 링크 조회 실패')
  }
  return res.json()
}

export async function fetchLibraryGraph() {
  return fetchJsonWithSharedTtl(`${API_BASE}/library/graph`, '지식 그래프 조회 실패')
}

export async function fetchGraphNodeQuestions(nodeId) {
  const res = await fetch(`${API_BASE}/library/graph/questions?node_id=${encodeURIComponent(nodeId)}`)
  if (!res.ok) throw new Error('관련 질문 조회 실패')
  return res.json()
}

export async function searchGraphNodes(query) {
  const res = await fetch(`${API_BASE}/library/graph/search?q=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error('지식 그래프 검색 실패')
  return res.json()
}

export async function fetchLibraryTimeline() {
  return fetchJsonWithSharedTtl(`${API_BASE}/library/timeline`, '타임라인 조회 실패')
}

export async function fetchLibraryHeatmap() {
  const res = await fetch(`${API_BASE}/library/graph/heatmap`)
  if (!res.ok) throw new Error('개념 히트맵 조회 실패')
  return res.json()
}

// force: true면 서버 캐시(하루 단위)를 무시하고 LLM 채점을 새로 돌린다("다시 계산" 버튼용).
export async function fetchLibraryHeatmapMatrix({ force = false } = {}) {
  const res = await fetch(`${API_BASE}/library/graph/heatmap/matrix${force ? '?force=true' : ''}`)
  if (!res.ok) throw new Error('개념 히트맵 매트릭스 조회 실패')
  return res.json()
}

export async function fetchLibraryGaps() {
  const res = await fetch(`${API_BASE}/library/graph/gaps`)
  if (!res.ok) throw new Error('지식 격차 조회 실패')
  return res.json()
}

export async function fetchLibraryDashboard() {
  return fetchJsonWithSharedTtl(`${API_BASE}/library/dashboard`, '대시보드 조회 실패')
}

// 뷰어/비교 화면이 보이고 포커스된 동안 주기적으로 경과 초를 보고한다(main.js의
// 읽기 시간 하트비트 타이머가 호출). 실패해도 다음 하트비트에서 다시 시도되므로
// 조용히 무시한다 - 토스트 등으로 사용자에게 알릴 만한 오류가 아니다.
export async function sendReadingHeartbeat(docId, seconds, category = 'reading', { keepalive = false } = {}) {
  try {
    const res = await fetch(`${API_BASE}/library/${docId}/reading-heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds, category }),
      keepalive,
    })
    if (res.ok) invalidateLibraryGetCache()
    return res.ok
  } catch {
    return false
  }
}

// Reading History 페이지의 총 읽기 시간/카테고리별 시간 분포/논문별 읽기 시간
// 랭킹에 쓰이는 실측 집계. sinceDays를 주면 최근 N일로 제한한다.
export async function fetchReadingTimeStats(sinceDays) {
  const query = sinceDays ? `?since_days=${sinceDays}` : ''
  return fetchJsonWithSharedTtl(`${API_BASE}/library/reading-stats${query}`, '읽기 시간 통계 조회 실패')
}

export async function fetchReadingAnalyticsSummary(sinceDays) {
  const query = sinceDays ? `?since_days=${sinceDays}` : ''
  return fetchJsonWithSharedTtl(`${API_BASE}/library/reading-analytics-summary${query}`, 'Reading Analytics summary fetch failed')
}

export async function fetchPaperReadingAnalytics(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}/reading-analytics`)
  if (!res.ok) throw new Error('Paper Reading Analytics fetch failed')
  return res.json()
}

// force: true면 유효한 캐시가 있어도 무시하고 새로 생성한다("다시 받기" 버튼용).
export async function fetchReadingRecommendations({ force = false } = {}) {
  const res = await fetch(`${API_BASE}/library/graph/recommendations${force ? '?force=true' : ''}`)
  if (!res.ok) throw new Error('추천 논문 조회 실패')
  return res.json()
}

// 대시보드 진입 시 호출하는 가벼운 버전 - 유효한 캐시가 있으면 바로 보여주고,
// 없으면 무거운 재계산 없이 recommendations: null을 반환받아 "추천 받기" 버튼을 띄운다.
export async function fetchCachedReadingRecommendations() {
  const res = await fetch(`${API_BASE}/library/graph/recommendations/cached`)
  if (!res.ok) throw new Error('추천 논문 캐시 조회 실패')
  return res.json()
}

export async function fetchLibraryTrash(options = {}) {
  const res = await fetch(`${API_BASE}/library/trash${buildQuery(options)}`)
  if (!res.ok) throw new Error('휴지통 조회 실패')
  return res.json()
}

export async function restoreLibraryDoc(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}/restore`, { method: 'POST' })
  if (!res.ok) throw new Error('복원 실패')
  invalidateLibraryGetCache()
  return res.json()
}

export async function emptyLibraryTrash() {
  const res = await fetch(`${API_BASE}/library/trash/empty`, { method: 'DELETE' })
  if (!res.ok) throw new Error('휴지통 비우기 실패')
  invalidateLibraryGetCache()
  return res.json()
}

export async function deleteLibraryDocPermanently(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}/permanent`, { method: 'DELETE' })
  if (!res.ok) throw new Error('영구 삭제 실패')
  invalidateLibraryGetCache()
  return res.json()
}

// 캐시가 없는 문서는 백엔드가 생성을 백그라운드로 돌리고 매 요청마다
// {status: 'pending'}만 즉시 반환한다(계보/실험 흐름/용어집까지 만드는 지금의
// 프롬프트는 로컬 LLM 기준 수 분씩 걸릴 수 있어, 하나의 요청을 그만큼 열어두면
// 리버스 프록시의 기본 read timeout에 걸려 끊기기 때문). 완료될 때까지 짧은
// 간격으로 재조회한다.
const PRIMER_POLL_INTERVAL_MS = 3000
const PRIMER_POLL_MAX_ATTEMPTS = 150 // 최대 약 7.5분 대기

// Library 상세 패널 Quick Info의 Venue/DOI/ArXiv/Citations. 서버가 OpenAlex
// 제목 검색으로 첫 조회 시 채워서 문서 메타데이터에 캐시해두므로, 여기서는
// 폴링 없이 단발성 GET이면 된다(생성이 아니라 짧은 검색 1회이기 때문에
// fetchPrimer처럼 오래 걸리지 않음).
export async function fetchLibraryBibliography(docId, refresh = false) {
  const query = refresh ? '?refresh=true' : ''
  const res = await fetch(`${API_BASE}/library/${docId}/bibliography${query}`)
  if (!res.ok) throw new Error('서지 정보 조회 실패')
  return res.json()
}

export async function fetchPrimer(docId, targetLang = '한국어') {
  for (let attempt = 0; attempt < PRIMER_POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${API_BASE}/library/${docId}/primer?target_lang=${encodeURIComponent(targetLang)}`)
    if (!res.ok) throw new Error('읽기 전 브리핑 조회 실패')
    const data = await res.json()
    if (data.status !== 'pending') return data
    await new Promise(resolve => setTimeout(resolve, PRIMER_POLL_INTERVAL_MS))
  }
  throw new Error('읽기 전 브리핑 생성이 너무 오래 걸립니다.')
}

// 캐시된 브리핑을 지우고 처음부터 다시 생성을 시작시킨다("다시 생성하기").
// 이 호출 자체는 즉시 pending ack만 받고, 실제 완료 대기는 뒤이어 호출하는
// fetchPrimer()의 폴링 루프가 맡는다.
export async function regeneratePrimer(docId, targetLang = '한국어') {
  const res = await fetch(
    `${API_BASE}/library/${docId}/primer/regenerate?target_lang=${encodeURIComponent(targetLang)}`,
    { method: 'POST' }
  )
  if (!res.ok) throw new Error('브리핑 재생성 요청 실패')
  return res.json()
}
