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
