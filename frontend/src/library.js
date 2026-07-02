const API_BASE = '/api'

function buildQuery(options) {
  if (!options || !options.targetLang) return ''
  const { targetLang, style, ignoreMath, ignoreTable, ignoreRefs } = options
  return `?target_lang=${encodeURIComponent(targetLang)}&style=${style}&ignore_math=${ignoreMath}&ignore_table=${ignoreTable}&ignore_refs=${ignoreRefs}`
}

export async function fetchLibrary(options = {}) {
  const res = await fetch(`${API_BASE}/library${buildQuery(options)}`)
  if (!res.ok) throw new Error('라이브러리 조회 실패')
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
  return res.json()
}

