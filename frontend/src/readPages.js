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
