import { icon } from '../icons.js'
import { t } from '../i18n.js'
import { fetchLibrary } from '../library.js'
import '../styles/general-document-home.css'


let renderGeneration = 0

const DOCUMENT_TYPES = {
  technical: { label: '기술 문서', icon: 'code' },
  academic_book: { label: () => t('common:documentTypes.academicBook', { fallback: '전공 서적·학술 문서' }), icon: 'award' },
  general_book: { label: () => t('common:documentTypes.generalBook', { fallback: '일반·교양서' }), icon: 'bookOpen' },
  literary_work: { label: () => t('common:documentTypes.literaryWork', { fallback: '문학·서사' }), icon: 'edit3' },
  article: { label: () => t('common:documentTypes.article', { fallback: '기사·칼럼' }), icon: 'fileText' },
  report: { label: () => t('common:documentTypes.report', { fallback: '분석 보고서' }), icon: 'activity' },
  manual: { label: () => t('common:documentTypes.manual', { fallback: '매뉴얼·가이드' }), icon: 'listChecks' },
  legal_policy: { label: () => t('common:documentTypes.legalPolicy', { fallback: '법률·정책 문서' }), icon: 'clipboard' },
  presentation: { label: () => t('common:documentTypes.presentation', { fallback: '발표·강의 자료' }), icon: 'layers' },
  other: { label: '기타', icon: 'folder' },
  book: { label: () => t('common:documentTypes.legacyBook', { fallback: '책(재분류 필요)' }), icon: 'bookOpen', deprecated: true },
}


function documentTypeName(definition) {
  return typeof definition.label === 'function' ? definition.label() : definition.label
}


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char])
}


function renderStatCard(type, count) {
  const definition = DOCUMENT_TYPES[type]
  return `
    <div class="document-home-stat-card">
      <span class="document-home-stat-icon" aria-hidden="true">${icon(definition.icon, 18)}</span>
      <span class="document-home-stat-copy">
        <span>${documentTypeName(definition)}</span>
        <strong>${count.toLocaleString('ko-KR')}</strong>
      </span>
    </div>`
}


function renderRecentDocument(doc) {
  const type = DOCUMENT_TYPES[doc.document_type] || DOCUMENT_TYPES.other
  const title = doc.metadata?.title || doc.filename || '제목 없는 문서'
  const pages = Number.isFinite(Number(doc.total_pages)) ? Number(doc.total_pages) : 0
  return `
    <button type="button" class="document-home-recent-row" data-doc-id="${escapeHtml(doc.id)}">
      <span class="document-home-recent-icon" aria-hidden="true">${icon(type.icon, 19)}</span>
      <span class="document-home-recent-copy">
        <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
        <small>${escapeHtml(doc.filename || documentTypeName(type))} · ${pages.toLocaleString('ko-KR')}페이지</small>
      </span>
      <span class="document-home-type-chip">${documentTypeName(type)}</span>
      <span class="document-home-row-arrow" aria-hidden="true">${icon('chevronDown', 16)}</span>
    </button>`
}


export async function renderGeneralDocumentHomePage() {
  const root = document.getElementById('page-dashboard')
  if (!root) return
  const generation = ++renderGeneration
  const isCurrent = () => generation === renderGeneration
    && root.classList.contains('active')
    && document.body.dataset.workspaceMode === 'general'

  root.innerHTML = `
    <div class="document-home-status" role="status">
      ${icon('refreshCw', 20)}<span>문서 홈을 불러오는 중...</span>
    </div>`

  let data
  try {
    data = await fetchLibrary({ documentMode: 'general' })
  } catch (error) {
    console.error('문서 홈 데이터 로드 실패:', error)
    if (isCurrent()) {
      root.innerHTML = `
        <div class="document-home-status is-error" role="alert">
          ${icon('alertTriangle', 20)}
          <strong>문서 홈을 불러오지 못했습니다.</strong>
          <span>잠시 후 다시 시도해 주세요.</span>
        </div>`
    }
    return
  }

  if (!isCurrent()) return
  const docs = Array.isArray(data?.documents) ? data.documents : []
  const counts = docs.reduce((acc, doc) => {
    const key = DOCUMENT_TYPES[doc.document_type] ? doc.document_type : 'other'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  const recent = docs.slice(0, 6)

  root.innerHTML = `
    <div class="document-home">
      <header class="document-home-hero">
        <span class="document-home-hero-icon" aria-hidden="true">${icon('bookOpen', 25)}</span>
        <div>
          <p class="document-home-eyebrow">GENERAL DOCUMENTS</p>
          <h2>내 문서 한눈에 보기</h2>
          <p>최근 문서를 이어 읽고, 문서 종류별 자료를 빠르게 찾아보세요.</p>
        </div>
        <div class="document-home-total" aria-label="전체 문서 ${docs.length}개">
          <span>전체 문서</span>
          <strong>${docs.length.toLocaleString('ko-KR')}</strong>
        </div>
      </header>

      <section class="document-home-section" aria-labelledby="document-home-types-title">
        <div class="document-home-section-heading">
          <div>
            <p>COLLECTION</p>
            <h3 id="document-home-types-title">문서 종류</h3>
          </div>
        </div>
        <div class="document-home-stat-grid">
          ${Object.keys(DOCUMENT_TYPES)
            .filter(type => !DOCUMENT_TYPES[type].deprecated || counts[type])
            .map(type => renderStatCard(type, counts[type] || 0)).join('')}
        </div>
      </section>

      <section class="document-home-section" aria-labelledby="document-home-recent-title">
        <div class="document-home-section-heading">
          <div>
            <p>CONTINUE READING</p>
            <h3 id="document-home-recent-title">최근 문서</h3>
          </div>
          <span>${recent.length ? t('library:document.count', { count: recent.length }) : t('dashboard:generalDocumentsEmpty')}</span>
        </div>
        <div class="document-home-recent-list">
          ${recent.length
            ? recent.map(renderRecentDocument).join('')
            : `<div class="document-home-empty">
                ${icon('folderPlus', 24)}
                <strong>${t('dashboard:generalDocumentsEmpty')}</strong>
                <span>PDF를 업로드하면 최근 문서가 여기에 표시됩니다.</span>
              </div>`}
        </div>
      </section>
    </div>`

  root.querySelectorAll('[data-doc-id]').forEach(button => {
    button.addEventListener('click', () => {
      const docId = button.dataset.docId
      history.pushState({ screen: 'viewer', docId }, '', `#viewer?id=${encodeURIComponent(docId)}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
  })
}


document.addEventListener('easypaper:locale-changed', () => {
  const root = document.getElementById('page-dashboard')
  if (root?.classList.contains('active') && document.body.dataset.workspaceMode === 'general') {
    renderGeneralDocumentHomePage()
  }
})
