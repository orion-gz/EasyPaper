import { fetchLibrary } from '../library.js'


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char])
}


export async function renderGeneralDocumentHomePage() {
  const root = document.getElementById('page-dashboard')
  if (!root) return
  const data = await fetchLibrary({ documentMode: 'general' })
  const docs = data.documents || []
  const counts = docs.reduce((acc, doc) => {
    const key = doc.document_type || 'other'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
  const labels = { technical: '기술 문서', book: '책', article: '아티클', report: '보고서', manual: '매뉴얼', other: '기타' }
  const recent = docs.slice(0, 6)
  root.innerHTML = `
    <div class="dashboard-page">
      <div class="dashboard-hero"><div><p class="dashboard-eyebrow">GENERAL DOCUMENTS</p><h2>문서 홈</h2><p>최근 문서를 이어 읽고, 문서 종류별 자료를 빠르게 찾아보세요.</p></div></div>
      <div class="dashboard-stat-grid">
        <div class="dashboard-stat-card"><span>전체 문서</span><strong>${docs.length}</strong></div>
        ${Object.entries(labels).map(([key, label]) => `<div class="dashboard-stat-card"><span>${label}</span><strong>${counts[key] || 0}</strong></div>`).join('')}
      </div>
      <section class="dashboard-section"><div class="dashboard-section-heading"><h3>최근 문서</h3></div>
        <div class="dashboard-paper-list">${recent.length ? recent.map(doc => `
          <button type="button" class="dashboard-paper-row" data-doc-id="${escapeHtml(doc.id)}">
            <span><strong>${escapeHtml(doc.metadata?.title || doc.filename)}</strong><small>${escapeHtml(labels[doc.document_type] || '문서')} · ${doc.total_pages || 0}p</small></span>
          </button>`).join('') : '<p class="lib-empty">일반 문서가 없습니다. PDF를 업로드해 시작하세요.</p>'}
        </div>
      </section>
    </div>`
  root.querySelectorAll('[data-doc-id]').forEach(button => {
    button.addEventListener('click', () => {
      history.pushState({ screen: 'viewer', docId: button.dataset.docId }, '', `#viewer?id=${button.dataset.docId}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
  })
}
