import './style.css'
import { uploadPDF, checkHealth, streamTranslation, getJobStatus, getPageTranslation, loginAPI, logoutAPI, checkAuthAPI, changeCredentialsAPI, getSystemSettingsAPI, saveSystemSettingsAPI, restartJobAPI, streamPullModelAPI, streamChatAPI, clearTranslationCacheAPI, getChatHistoryAPI, getAgyUsageAPI, cancelJobAPI } from './api.js'
import { loadPDF, renderScrollView, scrollToPage, reRenderAll, getScale, getTotalPages } from './pdfViewer.js'
import { fetchLibrary, deleteLibraryDoc, fetchLibraryTranslation } from './library.js'


// ── 글로벌 API 인터셉터 (인증 만료/실패 대응) ─────────
const originalFetch = window.fetch
window.fetch = async function (...args) {
  const response = await originalFetch(...args)
  if (response.status === 401) {
    const url = args[0]
    // 로그인/상태확인 API가 아니며 인증 만료 401 응답인 경우 로그인 화면으로 전환
    if (typeof url === 'string' && !url.includes('/api/auth/check') && !url.includes('/api/auth/login')) {
      showLogin()
      showToast('세션이 만료되었습니다. 다시 로그인해 주세요.', 'error')
    }
  }
  return response
}

// ── 상태 ──────────────────────────────────────────
const state = {
  sessionId: null,
  filename: null,
  totalPages: 0,
  currentPage: 1,
  zoom: 1.5,
  syncScroll: true,
  translationCache: {},        // pageNum → 번역 텍스트
  translatingPages: new Set(), // 현재 번역 중인 페이지 (폴링 중복 방지용)
  translatedPages: new Set(),  // 번역 완료된 페이지
  pollingTimer: null,          // 잡 폴링 타이머
  username: 'admin',           // 현재 로그인한 사용자명 저장
  chatHistory: [],             // AI 채팅 히스토리
  chatActiveStream: null,      // 현재 활성화된 채팅 스트림 abort 함수
  chatCurrentText: '',         // 현재 스트리밍 답변 텍스트 임시 저장
  availableOllamaModels: [],   // Ollama에서 설치된 모델 목록
}

// ── DOM 참조 ──────────────────────────────────────
const $ = (id) => document.getElementById(id)
const loginScreen       = $('login-screen')
const loginForm         = $('login-form')
const loginUsername     = $('login-username')
const loginPassword     = $('login-password')
const globalLogoutBtn   = $('global-logout-btn')
const globalSettingsBtn = $('global-settings-btn')
const settingsModal     = $('settings-modal')
const closeSettingsBtn  = $('close-settings-btn')
const cancelSettingsBtn = $('cancel-settings-btn')
const changeCredentialsForm = $('change-credentials-form')
const changeCurrentPassword = $('change-current-password')
const changeNewUsername     = $('change-new-username')
const changeNewPassword     = $('change-new-password')
const changeNewPasswordConfirm = $('change-new-password-confirm')

// 탭 버튼 및 컨텐츠 영역
const tabBtns           = document.querySelectorAll('.tab-btn')
const tabPanes          = document.querySelectorAll('.tab-pane')

// 설정 폼 및 엘리먼트
const generalSettingsForm = $('general-settings-form')
const settingTargetLang   = $('setting-target-lang')
const settingTransStyle   = $('setting-trans-style')
const settingIgnoreMath   = $('setting-ignore-math')
const settingIgnoreTable  = $('setting-ignore-table')
const settingIgnoreRefs   = $('setting-ignore-refs')
const settingDefaultZoom  = $('setting-default-zoom')
const clearCacheBtn       = $('clear-cache-btn')

const systemSettingsForm  = $('system-settings-form')
const settingOllamaHost    = $('setting-ollama-host')
const settingOpenAIKey     = $('setting-openai-key')
const settingGeminiKey     = $('setting-gemini-key')
const settingClaudeKey     = $('setting-claude-key')

// (provider/model selects are now custom ProviderModelPicker instances – see below)

const settingPullModelName = $('setting-pull-model-name')
const settingPullModelBtn  = $('setting-pull-model-btn')
const pullModelProgressArea = $('pull-model-progress-area')
const pullStatusText       = $('pull-status-text')
const pullPctText          = $('pull-pct-text')
const pullProgressBar      = $('pull-progress-bar')
const pullModelSection     = $('pull-model-section')

const libraryScreen     = $('library-screen')
const viewerScreen      = $('viewer-screen')
const fileInput         = $('file-input')
const libUploadBtn      = $('lib-upload-btn')
const libraryGrid       = $('library-grid')
const libraryCategoryFilters = $('library-category-filters')
const libraryCountBadge = $('library-count-badge')

// Google Drive Style Upload Popup references
const uploadPopup        = $('upload-popup')
const uploadPopupTitle   = $('upload-popup-title')
const uploadPopupMinimize = $('upload-popup-minimize')
const uploadPopupClose   = $('upload-popup-close')
const uploadItemName     = $('upload-item-name')
const uploadItemStatus   = $('upload-item-status')
const uploadItemProgressBar = $('upload-item-progress-bar')
const uploadItemSpinner  = $('upload-item-spinner')
const uploadItemSuccessIcon = $('upload-item-success-icon')
const docTitle          = $('doc-title')
const pageInput         = $('page-input')
const pageTotal         = $('page-total')
const zoomInBtn         = $('zoom-in-btn')
const zoomOutBtn        = $('zoom-out-btn')
const zoomLabel         = $('zoom-level')
const syncScrollBtn     = $('sync-scroll-btn')
const exportBtn         = $('export-btn')
const retranslateBtn    = $('retranslate-btn')
const cancelTransBtn    = $('cancel-trans-btn')
const resumeTransBtn    = $('resume-trans-btn')
// (viewer/chat pickers are now ProviderModelPicker instances – see below)
const backBtn           = $('back-btn')
const viewerScrollContainer = $('viewer-scroll-container')
const translateSpinner      = $('translate-spinner')
const translateStatusText   = $('translate-status-text')
const progressMini          = $('translation-progress-mini')
const progressMiniBar       = $('progress-mini-bar')
const progressMiniText      = $('progress-mini-text')
const toast                 = $('toast')

// AI Chat Sidebar DOM references
const chatToggleBtn      = $('chat-toggle-btn')
const chatSidebar        = $('chat-sidebar')
const chatResizer        = $('chat-resizer')
const chatCloseBtn       = $('chat-close-btn')
const chatMessages       = $('chat-messages')
const chatInput          = $('chat-input')
const chatSendBtn        = $('chat-send-btn')


// ── 설정 기본값 및 옵션 헬퍼 ──────────────────────────
function getTranslationOptions() {
  return {
    targetLang: localStorage.getItem('easypaper_target_lang') || '한국어',
    style: localStorage.getItem('easypaper_style') || 'academic',
    ignoreMath: localStorage.getItem('easypaper_ignore_math') === 'true',
    ignoreTable: localStorage.getItem('easypaper_ignore_table') !== 'false', // 기본값 true
    ignoreRefs: localStorage.getItem('easypaper_ignore_refs') === 'true'
  }
}

// ── 토스트 ────────────────────────────────────────
let toastTimer = null
function showToast(msg, type = '') {
  toast.textContent = msg
  toast.className = `toast ${type} show`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.className = 'toast' }, 3000)
}

// ── AI 상태 확인 ──────────────────────────────────
async function checkAIStatus() {
  // 메인 업로드 화면이 제거되어 상태 표시를 생략합니다.
  return
}

// ── 화면 전환 ─────────────────────────────────────
function showLogin() {
  viewerScreen.classList.remove('active')
  libraryScreen.classList.remove('active')
  loginScreen.classList.add('active')
  // 글로벌 테마 토글 표시, 로그아웃 및 설정 버튼 숨김
  const globalToggle = $('global-theme-toggle')
  if (globalToggle) globalToggle.classList.remove('hidden')
  globalLogoutBtn.classList.add('hidden')
  globalSettingsBtn.classList.add('hidden')
}
function showViewer() {
  loginScreen.classList.remove('active')
  libraryScreen.classList.remove('active')
  viewerScreen.classList.add('active')
  // 글로벌 테마 토글 숨김 (뷰어 상단바 테마 버튼 사용)
  const globalToggle = $('global-theme-toggle')
  if (globalToggle) globalToggle.classList.add('hidden')
}

function resetState() {
  // 폴링 중단
  if (state.pollingTimer) { clearInterval(state.pollingTimer); state.pollingTimer = null }
  if (state.chatActiveStream) { state.chatActiveStream(); state.chatActiveStream = null }
  
  Object.assign(state, {
    sessionId: null, filename: null, totalPages: 0, currentPage: 1,
    zoom: 1.5, translationCache: {}, translatingPages: new Set(), translatedPages: new Set(), pollingTimer: null,
    chatHistory: [], chatActiveStream: null
  })
  viewerScrollContainer.innerHTML = ''
  if (uploadPopup) uploadPopup.classList.add('hidden')
  progressMini.classList.add('hidden')
  
  if (chatSidebar) chatSidebar.classList.add('hidden')
  if (chatResizer) chatResizer.classList.add('hidden')
  if (chatToggleBtn) chatToggleBtn.classList.remove('active')
  resetChatUI()
}

// ── 드래그 앤 드롭 ────────────────────────────────
// libraryScreen에 직접 드래그 앤 드롭 이벤트 바인딩
if (libraryScreen) {
  libraryScreen.addEventListener('dragover', (e) => { e.preventDefault(); libraryScreen.classList.add('drag-over') })
  libraryScreen.addEventListener('dragleave', () => libraryScreen.classList.remove('drag-over'))
  libraryScreen.addEventListener('drop', (e) => {
    e.preventDefault(); libraryScreen.classList.remove('drag-over')
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  })
}
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    handleFiles(e.target.files)
  }
})

// ── 파일 처리 ─────────────────────────────────────
async function handleFiles(files) {
  const pdfFiles = Array.from(files).filter(file => file.name.toLowerCase().endsWith('.pdf'))
  
  if (pdfFiles.length === 0) {
    showToast('PDF 파일만 업로드 가능합니다', 'error')
    return
  }

  const isLibraryActive = libraryScreen.classList.contains('active')
  
  // Show upload popup
  uploadPopup.classList.remove('hidden')
  uploadPopup.classList.remove('minimized')
  if (uploadPopupMinimize) uploadPopupMinimize.textContent = '−'
  
  let successCount = 0
  let lastSessionId = null
  let lastFilename = ""
  let lastTotalPages = 0

  for (let i = 0; i < pdfFiles.length; i++) {
    const file = pdfFiles[i]
    uploadPopupTitle.textContent = `파일 업로드 중 (${i + 1}/${pdfFiles.length})`
    uploadItemName.textContent = file.name
    uploadItemStatus.textContent = '준비 중...'
    uploadItemProgressBar.style.width = '0%'
    uploadItemSpinner.classList.remove('hidden')
    uploadItemSuccessIcon.classList.add('hidden')

    try {
      const result = await uploadPDF(file, getTranslationOptions(), (pct) => {
        uploadItemProgressBar.style.width = `${pct}%`
        uploadItemStatus.textContent = `업로드 중... ${pct}%`
      })
      
      uploadItemProgressBar.style.width = '100%'
      uploadItemStatus.textContent = '분석 및 저장 중...'
      
      lastSessionId = result.session_id
      lastFilename = result.filename
      lastTotalPages = result.total_pages
      successCount++

      if (isLibraryActive) {
        await renderLibrary()
      }
      
      // Mark file upload as success in popup
      uploadItemStatus.textContent = '업로드 완료'
      uploadItemSpinner.classList.add('hidden')
      uploadItemSuccessIcon.classList.remove('hidden')
    } catch (err) {
      showToast(`"${file.name}" 업로드 실패: ${err.message}`, 'error')
      uploadItemStatus.textContent = '업로드 실패'
      uploadItemSpinner.classList.add('hidden')
    }
  }

  fileInput.value = '' // reset input value

  if (successCount > 0) {
    uploadPopupTitle.textContent = `업로드 완료 (${successCount}/${pdfFiles.length})`
    showToast(`${successCount}개의 논문이 라이브러리에 추가되었습니다 ✓`, 'success')
    
    // 업로드 성공 시 1.5초 후 팝업 자동 닫기
    setTimeout(() => {
      uploadPopup.classList.add('hidden')
    }, 1500)

    if (!isLibraryActive && pdfFiles.length === 1 && successCount === 1) {
      state.sessionId  = lastSessionId
      state.filename   = lastFilename
      state.totalPages = lastTotalPages

      await loadPDF(`/api/pdf-file/${state.sessionId}`)
      docTitle.textContent = lastFilename
      pageTotal.textContent = `/ ${state.totalPages}`
      pageInput.max   = state.totalPages
      pageInput.value = 1

      showViewer()
      await initScrollViewer()
    } else if (!isLibraryActive) {
      showLibraryScreen()
    }
  } else {
    uploadPopupTitle.textContent = '업로드 실패'
  }
}

// ── 스크롤 뷰어 초기화 ────────────────────────────
// ── 페이지 쌍 생성 ────────────────────────────────
function createPagePair(pageNum) {
  const pair = document.createElement('div')
  pair.className = 'page-pair'
  pair.dataset.page = pageNum

  // 좌측: PDF wrapper
  const pdfWrapper = document.createElement('div')
  pdfWrapper.className = 'pdf-page-wrapper'
  pdfWrapper.dataset.page = pageNum
  const initialHeight = Math.round(841 * state.zoom)
  pdfWrapper.style.minHeight = `${initialHeight}px`

  const pdfInner = document.createElement('div')
  pdfInner.className = 'pdf-page-inner'
  pdfWrapper.appendChild(pdfInner)

  // 우측: 번역 블록
  const transBlock = createTransBlock(pageNum)
  transBlock.style.height = `${initialHeight}px`

  pair.appendChild(pdfWrapper)
  pair.appendChild(transBlock)
  return pair
}

// ── 스크롤 뷰어 초기화 ────────────────────────────
async function initScrollViewer() {
  viewerScrollContainer.innerHTML = ''

  for (let i = 1; i <= state.totalPages; i++) {
    viewerScrollContainer.appendChild(createPagePair(i))
  }

  // 이미 완료된 번역 즉시 로드 (라이브러리 내노드)
  for (const [pageNum, text] of Object.entries(state.translationCache)) {
    renderTransContent(parseInt(pageNum), text, true)
  }

  await renderScrollView(viewerScrollContainer, state.zoom, {
    onPageVisible: (pageNum) => updatePageDisplay(pageNum)
  })

  // 백그라운드 잡 폴링 시작
  startJobPolling(state.sessionId)
}

// ── 번역 블록 생성 ────────────────────────────────
function createTransBlock(pageNum) {
  const block = document.createElement('div')
  block.className = 'trans-page-block'
  block.id = `trans-block-${pageNum}`
  block.dataset.page = pageNum
  block.innerHTML = `
    <div class="trans-page-label">
      <span>📄 ${pageNum}페이지</span>
      <span class="trans-page-status" id="trans-status-${pageNum}">대기 중</span>
    </div>
    <div class="trans-page-content" id="trans-content-${pageNum}">
      <div class="trans-page-placeholder">스크롤하면 자동으로 번역됩니다</div>
    </div>`
  return block
}

// ── 페이지 번역 ───────────────────────────────────
// 폰링 중인 페이지를 플레이스홀더로 표시
function translatePage(pageNum) {
  if (state.translatingPages.has(pageNum) || state.translatedPages.has(pageNum)) return
  state.translatingPages.add(pageNum)

  const statusEl  = $(`trans-status-${pageNum}`)
  const contentEl = $(`trans-content-${pageNum}`)
  if (!contentEl) return

  // 스피너 + 대기 상태 표시
  contentEl.innerHTML = `
    <div class="trans-waiting">
      <div class="trans-wait-spinner"></div>
      <span>백그라운드에서 번역 중...</span>
    </div>`
  if (statusEl) statusEl.textContent = '번역 중...'
}

// ── 번역 텍스트 포맷팅 (LaTeX & HTML 처리) ─────────
function formatTranslationHtml(text) {
  if (!text) return ''

  const mathBlocks = []
  let t = text

  // 1. 블록 수식: $$...$$
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: true })
    return `___MB_${id}___`
  })
  // 2. 블록 수식: \[...\]
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: true })
    return `___MB_${id}___`
  })
  // 3. 인라인: $...$
  t = t.replace(/(?<!\$)\$([^\$\n]+?)\$(?!\$)/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: false })
    return `___MB_${id}___`
  })
  // 4. 인라인: \(...\)
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: false })
    return `___MB_${id}___`
  })

  // 5. 마크다운 헤더 & 이스케이프 처리
  const lines = t.split('\n')
  const htmlParts = lines.map(line => {
    const tr = line.trim()
    if (tr.startsWith('### ')) return `<h4 class="md-h4">${escapeHtml(tr.slice(4))}</h4>`
    if (tr.startsWith('## '))  return `<h3 class="md-h3">${escapeHtml(tr.slice(3))}</h3>`
    if (tr.startsWith('# '))   return `<h2 class="md-h2">${escapeHtml(tr.slice(2))}</h2>`
    return escapeHtml(line)
  })
  let html = htmlParts.join('\n')
    .replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>')

  // 6. 볼드: **...**
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')

  // 7. 수식 플레이스홀더 복원
  html = html.replace(/___MB_(\d+)___/g, (_, idStr) => {
    const item = mathBlocks[parseInt(idStr)]
    if (!item) return _
    if (window.katex) {
      try {
        const r = window.katex.renderToString(item.formula, { displayMode: item.display, throwOnError: false, output: 'html' })
        return item.display ? `<div class="katex-display-wrap">${r}</div>` : r
      } catch (e) {
        return `<code class="math-error">${escapeHtml(item.formula)}</code>`
      }
    }
    // KaTeX 미로드 시 pending 마킹 → 나중에 applyKatexToElement()로 재처리
    const delim = item.display ? '$$' : '$'
    return `<code class="math-pending" data-formula="${encodeURIComponent(item.formula)}" data-display="${item.display}">${escapeHtml(delim + item.formula + delim)}</code>`
  })

  return html
}

/** KaTeX 로드 후 .math-pending 코드를 실제 수식으로 교체 */
function applyKatexToElement(el) {
  if (!el || !window.katex) return
  el.querySelectorAll('code.math-pending').forEach(code => {
    try {
      const formula = decodeURIComponent(code.dataset.formula || '')
      const display = code.dataset.display === 'true'
      const r = window.katex.renderToString(formula, { displayMode: display, throwOnError: false, output: 'html' })
      const wrapper = display ? Object.assign(document.createElement('div'), { className: 'katex-display-wrap', innerHTML: r }) : Object.assign(document.createElement('span'), { innerHTML: r })
      code.replaceWith(wrapper)
    } catch (e) { code.classList.remove('math-pending') }
  })
}

function renderTransContent(pageNum, text, cached = false) {
  const contentEl = $(`trans-content-${pageNum}`)
  const statusEl  = $(`trans-status-${pageNum}`)
  if (!contentEl) return
  contentEl.innerHTML = ''
  if (cached) {
    const badge = document.createElement('div')
    badge.className = 'cached-badge'
    badge.textContent = '✓ 캐시'
    contentEl.appendChild(badge)
  }
  const el = document.createElement('div')
  el.className = 'trans-text'
  el.innerHTML = formatTranslationHtml(text)
  contentEl.appendChild(el)
  // KaTeX 로드된 경우 즉시 pending 수식 처리
  applyKatexToElement(el)
  if (statusEl) { statusEl.textContent = '✓ 완료'; statusEl.classList.add('done') }
}

// ── 페이지 표시 업데이트 ──────────────────────────
function updatePageDisplay(pageNum) {
  if (pageNum === state.currentPage) return
  state.currentPage = pageNum
  pageInput.value = pageNum
}

function updateProgressMini() {
  if (!state.totalPages) return
  updateProgressMiniRaw(state.translatedPages.size, state.totalPages)
}

function updateProgressMiniRaw(done, total) {
  if (!total) return
  const pct = Math.round((done / total) * 100)
  progressMini.classList.remove('hidden')
  progressMiniBar.style.setProperty('--progress', `${pct}%`)
  progressMiniText.textContent = `${pct}%`
}

// ── 잡 폰링 ───────────────────────────────────────
function startJobPolling(sessionId) {
  if (state.pollingTimer) clearInterval(state.pollingTimer)

  async function poll() {
    if (!state.sessionId || state.sessionId !== sessionId) return
    const job = await getJobStatus(sessionId)
    if (!job) return

    for (const pageNum of (job.completed_pages || [])) {
      if (state.translatedPages.has(pageNum)) continue
      const data = await getPageTranslation(sessionId, pageNum, getTranslationOptions())
      if (data?.translation) {
        state.translationCache[pageNum] = data.translation
        state.translatedPages.add(pageNum)
        state.translatingPages.delete(pageNum)
        renderTransContent(pageNum, data.translation, false)
      }
    }

    const done  = state.translatedPages.size
    const total = job.total_pages || state.totalPages
    updateProgressMiniRaw(done, total)

    if (job.status === 'running') {
      translateSpinner.classList.remove('hidden')
      translateStatusText.textContent = `백그라운드 번역 중 (${done}/${total}p)`
      cancelTransBtn.classList.remove('hidden')
      resumeTransBtn.classList.add('hidden')
    } else {
      translateSpinner.classList.add('hidden')
      translateStatusText.textContent =
        job.status === 'completed' ? `번역 완료 ✓ (${done}/${total}p)` : `상태: ${job.status}`
      cancelTransBtn.classList.add('hidden')
      if (job.status !== 'completed') {
        resumeTransBtn.classList.remove('hidden')
      } else {
        resumeTransBtn.classList.add('hidden')
      }
      clearInterval(state.pollingTimer)
      state.pollingTimer = null
    }
  }

  poll()
  state.pollingTimer = setInterval(poll, 5000)
}

// ── 스크롤 동기화 ─────────────────────────────────
function setupScrollSync() {
  // 단일 스크롤 영역으로 변경되어 스크롤 동기화가 불필요합니다.
}

syncScrollBtn.addEventListener('click', () => {
  state.syncScroll = !state.syncScroll
  syncScrollBtn.classList.toggle('active', state.syncScroll)
  showToast(state.syncScroll ? '스크롤 동기화 ON' : '스크롤 동기화 OFF')
})

// ── 페이지 점프 (숫자 입력 후 Enter) ─────────────
pageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const num = Math.max(1, Math.min(parseInt(e.target.value) || 1, state.totalPages))
  pageInput.value = num
  scrollToPage(viewerScrollContainer, num)
})
pageInput.addEventListener('blur', (e) => {
  const num = Math.max(1, Math.min(parseInt(e.target.value) || 1, state.totalPages))
  pageInput.value = num
})

// ── 줌 ────────────────────────────────────────────
async function setZoom(newZoom) {
  newZoom = Math.max(0.5, Math.min(3.0, newZoom))
  state.zoom = newZoom
  zoomLabel.textContent = `${Math.round(newZoom / 1.5 * 100)}%`
  if (!state.sessionId) return
  await reRenderAll(viewerScrollContainer, newZoom, {
    onPageVisible: (pageNum) => updatePageDisplay(pageNum)
  })
}

zoomInBtn.addEventListener('click',  () => setZoom(state.zoom + 0.2))
zoomOutBtn.addEventListener('click', () => setZoom(state.zoom - 0.2))

// ── 내보내기 ──────────────────────────────────────
exportBtn.addEventListener('click', () => {
  const pages = Object.entries(state.translationCache)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([num, text]) => `## ${num}페이지\n\n${text}`)
    .join('\n\n---\n\n')

  if (!pages) { showToast('번역된 페이지가 없습니다', 'error'); return }

  const blob = new Blob([`# ${state.filename}\n\n${pages}`], { type: 'text/markdown' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `${state.filename}_번역.md`; a.click()
  URL.revokeObjectURL(url)
  showToast('번역 파일을 다운로드했습니다 ✓', 'success')
})

// ── 다시 번역하기 ──────────────────────────────────
retranslateBtn.addEventListener('click', async () => {
  if (!state.sessionId) return
  
  if (confirm('기존 번역 캐시를 삭제하고 처음부터 다시 번역을 시작하시겠습니까?\n(확인을 누르면 기존 번역이 완전히 초기화되고 새로 번역을 진행합니다.)')) {
    // 1. 로컬 번역 정보 전체 비우기
    state.translationCache = {}
    state.translatingPages.clear()
    state.translatedPages.clear()
    
    // 2. UI 상의 모든 번역창 초기화
    for (let i = 1; i <= state.totalPages; i++) {
      const contentEl = $(`trans-content-${i}`)
      const statusEl = $(`trans-status-${i}`)
      if (contentEl) {
        contentEl.innerHTML = '<div class="trans-page-placeholder">스크롤하면 자동으로 번역됩니다</div>'
      }
      if (statusEl) {
        statusEl.textContent = '대기 중'
        statusEl.classList.remove('done')
      }
    }
    
    try {
      showToast('번역 캐시를 삭제하는 중...', 'info')
      await clearTranslationCacheAPI(state.sessionId)
      
      showToast('번역 작업을 재시작하는 중...', 'info')
      await restartJobAPI(state.sessionId, getTranslationOptions())
      
      startJobPolling(state.sessionId)
      showToast('번역 작업이 처음부터 재시작되었습니다.', 'success')
    } catch (err) {
      showToast(err.message, 'error')
    }
  }
})

// ── 번역 중지하기 ──────────────────────────────────
cancelTransBtn.addEventListener('click', async () => {
  if (!state.sessionId) return
  
  if (confirm('현재 진행 중인 백그라운드 번역 작업을 중지하시겠습니까?')) {
    try {
      showToast('번역 중지 요청 중...', 'info')
      await cancelJobAPI(state.sessionId)
      
      if (state.pollingTimer) {
        clearInterval(state.pollingTimer)
        state.pollingTimer = null
      }
      translateSpinner.classList.add('hidden')
      translateStatusText.textContent = '번역 중지됨'
      cancelTransBtn.classList.add('hidden')
      
      for (let i = 1; i <= state.totalPages; i++) {
        const statusEl = $(`trans-status-${i}`)
        if (statusEl && statusEl.textContent === '번역 중...') {
          statusEl.textContent = '대기 중 (중단됨)'
        }
      }
      
      showToast('번역 작업이 성공적으로 중지되었습니다.', 'success')
    } catch (err) {
      showToast(err.message, 'error')
    }
  }
})

// ── 번역 이어서 시작/재개하기 ──────────────────────────
resumeTransBtn.addEventListener('click', async () => {
  if (!state.sessionId) return
  
  try {
    showToast('중단된 지점부터 번역을 재개하는 중...', 'info')
    await restartJobAPI(state.sessionId, getTranslationOptions())
    startJobPolling(state.sessionId)
    showToast('번역이 이어서 재개되었습니다.', 'success')
  } catch (err) {
    showToast(err.message, 'error')
  }
})


// ── 뒤로 가기 ─────────────────────────────────────
backBtn.addEventListener('click', () => {
  showLibraryScreen()
})

// ── 구분선 드래그 ─────────────────────────────────
const divider          = $('divider')
if (divider) {
  const pdfPanel         = $('pdf-panel')
  const translationPanel = $('translation-panel')
  const panels           = document.querySelector('.panels')
  let isDragging = false, startX = 0, startLeft = 0

  divider.addEventListener('mousedown', (e) => {
    isDragging = true; startX = e.clientX
    startLeft = pdfPanel.getBoundingClientRect().width
    divider.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  })
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return
    const total = panels.getBoundingClientRect().width
    const newLeft = Math.max(300, Math.min(startLeft + e.clientX - startX, total - 300))
    const pct = (newLeft / total) * 100
    pdfPanel.style.flex = `0 0 ${pct}%`
    translationPanel.style.flex = `0 0 ${100 - pct}%`
  })
  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false
      divider.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  })
}

// ── 로그인 & 세션 검증 로직 ──────────────────────────
async function checkAuthentication() {
  const auth = await checkAuthAPI()
  if (auth && auth.status === 'authenticated') {
    state.username = auth.username
    loginScreen.classList.remove('active')
    globalLogoutBtn.classList.remove('hidden')
    globalSettingsBtn.classList.remove('hidden')
    showLibraryScreen()
    await loadLibraryCount()
    await refreshSystemSettings()
  } else {
    showLogin()
  }
}

// 로그인 폼 제출 이벤트
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const username = loginUsername.value.trim()
  const password = loginPassword.value
  try {
    await loginAPI(username, password)
    showToast('로그인 성공!', 'success')
    loginPassword.value = ''
    await checkAuthentication()
  } catch (err) {
    showToast(err.message, 'error')
  }
})

// 로그아웃 버튼 클릭 이벤트
globalLogoutBtn.addEventListener('click', async () => {
  if (!confirm('로그아웃 하시겠습니까?')) return
  try {
    await logoutAPI()
    showToast('로그아웃되었습니다.', 'success')
    showLogin()
  } catch (err) {
    showToast(err.message, 'error')
  }
})

// ── 비밀번호 변경 모달 이벤트 ──────────────────────────
// ── Ollama 설정 새로고침 헬퍼 ──────────────────────────
// ── 시스템 설정 새로고침 헬퍼 ──────────────────────────
// ── Provider + Model 통합 선택 드롭다운 ─────────────────
const PROVIDER_CONFIG = [
  {
    id: 'antigravity', label: 'Antigravity', icon: '⚡',
    models: [
      { value: 'Gemini 3.5 Flash (Medium)',    label: 'Gemini 3.5 Flash (Medium)' },
      { value: 'Gemini 3.5 Flash (High)',      label: 'Gemini 3.5 Flash (High)' },
      { value: 'Gemini 3.5 Flash (Low)',       label: 'Gemini 3.5 Flash (Low)' },
      { value: 'Gemini 3.1 Pro (Low)',         label: 'Gemini 3.1 Pro (Low)' },
      { value: 'Gemini 3.1 Pro (High)',        label: 'Gemini 3.1 Pro (High)' },
      { value: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' },
      { value: 'Claude Opus 4.6 (Thinking)',   label: 'Claude Opus 4.6 (Thinking)' },
      { value: 'GPT-OSS 120B (Medium)',        label: 'GPT-OSS 120B (Medium)' },
    ]
  }
]

class ProviderModelPicker {
  constructor(containerEl, { compact = false, onChange } = {}) {
    if (!containerEl) {
      console.error('[ProviderModelPicker] containerEl is null, skipping init')
      return
    }
    this.container = containerEl
    this.compact = compact
    this.onChange = onChange || (() => {})
    this._provider = 'antigravity'
    this._model = 'Gemini 3.5 Flash (Medium)'
    this._build()
    this._updateBtn()
    this._bindClose()
  }

  _build() {
    const c = this.container
    c.className = 'provider-picker' + (this.compact ? '' : ' picker-left picker-full-wrap')

    this._btn = document.createElement('button')
    this._btn.type = 'button'
    this._btn.className = 'provider-picker-btn' + (this.compact ? '' : ' picker-full')
    this._btn.innerHTML = `<span class="picker-icon"></span><span class="picker-label"></span><span class="picker-arrow">▾</span>`

    this._panel = document.createElement('div')
    this._panel.className = 'provider-picker-panel'

    c.appendChild(this._btn)
    c.appendChild(this._panel)

    this._btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const isOpen = c.classList.contains('open')
      document.querySelectorAll('.provider-picker.open').forEach(p => p.classList.remove('open'))
      if (!isOpen) {
        this._rebuildPanel()
        c.classList.add('open')
      }
    })
  }

  _rebuildPanel() {
    this._panel.innerHTML = ''
    const config = PROVIDER_CONFIG.map(p => {
      if (p.id === 'ollama') {
        return { ...p, models: (state.availableOllamaModels || []).map(m => ({ value: m, label: m })) }
      }
      return p
    })

    config.forEach((prov, i) => {
      if (i > 0) {
        const div = document.createElement('div')
        div.className = 'picker-divider'
        this._panel.appendChild(div)
      }
      const group = document.createElement('div')
      group.className = 'picker-group'

      const header = document.createElement('div')
      header.className = 'picker-group-header'

      if (prov.id === 'antigravity') {
        // 사용량 배지 포함 헤더
        header.innerHTML = `
          <span class="g-icon">${prov.icon}</span>
          <span>${prov.label}</span>
          <span class="agy-usage-badge" style="margin-left:auto;font-size:9px;background:rgba(139,92,246,0.2);color:#a78bfa;padding:2px 6px;border-radius:8px;font-weight:600;">로딩중...</span>
        `
        group.appendChild(header)
        // 사용량 비동기 로드
        const badge = header.querySelector('.agy-usage-badge')
        getAgyUsageAPI().then(data => {
          if (data && data.ok !== false) {
            const pct = data.daily_used_pct || 0
            const remaining = data.daily_remaining ?? '?'
            const color = pct > 80 ? '#f87171' : pct > 50 ? '#fbbf24' : '#a78bfa'
            badge.style.background = pct > 80 ? 'rgba(248,113,113,0.2)' : pct > 50 ? 'rgba(251,191,36,0.2)' : 'rgba(139,92,246,0.2)'
            badge.style.color = color
            badge.textContent = `오늘 ${data.today}회 · 잔여 ${remaining}`
          } else {
            badge.textContent = '사용량 미확인'
          }
        }).catch(() => { badge.textContent = '사용량 미확인' })
      } else {
        header.innerHTML = `<span class="g-icon">${prov.icon}</span><span>${prov.label}</span>`
        group.appendChild(header)
      }

      const models = prov.models.length > 0 ? prov.models : [{ value: '', label: '모델 없음 (Ollama 연결 필요)' }]
      models.forEach(m => {
        const item = document.createElement('div')
        item.className = 'picker-model-item' + (this._provider === prov.id && this._model === m.value ? ' selected' : '')
        item.style.position = 'relative'
        item.textContent = m.label
        if (m.value) {
          item.addEventListener('click', (e) => {
            e.stopPropagation()
            this._provider = prov.id
            this._model = m.value
            this._updateBtn()
            this.container.classList.remove('open')
            this.onChange(prov.id, m.value)
          })
        }
        group.appendChild(item)
      })
      this._panel.appendChild(group)
    })
  }

  _updateBtn() {
    const prov = PROVIDER_CONFIG.find(p => p.id === this._provider)
    const icon = prov ? prov.icon : '?'
    // 첫 단어만 (예: "Google Gemini" → "Gemini", "Anthropic Claude" → "Anthropic")
    const provShort = prov ? (prov.label === 'Google Gemini' ? 'Gemini' : prov.label === 'Anthropic Claude' ? 'Claude' : prov.label.split(' ')[0]) : this._provider
    let modelLabel = this._model || '(선택 안 됨)'
    if (prov) {
      const found = prov.models.find(m => m.value === this._model)
      if (found) modelLabel = found.label.replace(' (추천)', '')
      // else: 목록에 없으면 _model 값을 그대로 사용
    }
    this._btn.querySelector('.picker-icon').textContent = icon
    this._btn.querySelector('.picker-label').textContent = `${provShort} · ${modelLabel}`
    this._btn.title = `${prov ? prov.label : this._provider} / ${modelLabel}`
  }

  _bindClose() {
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target)) {
        this.container.classList.remove('open')
      }
    })
  }

  getValue() {
    return { provider: this._provider, model: this._model }
  }

  setValue(provider, model) {
    this._provider = provider || 'antigravity'
    const prov = PROVIDER_CONFIG.find(p => p.id === this._provider)
    if (model) {
      // 모델 값이 있으면 무조건 그대로 사용 (목록에 없어도 허용)
      this._model = model
    } else if (prov && prov.models.length > 0) {
      // 모델 미지정 시 첫 번째 모델로 기본값
      this._model = prov.models[0].value
    } else {
      this._model = ''
    }
    this._updateBtn()
  }
}

// Instantiate the 4 provider pickers
const viewerTransPicker = new ProviderModelPicker($('viewer-trans-provider'), {
  compact: true,
  onChange: (provider, model) => changeProviderAndModel('trans', provider, model)
})

const chatSidebarPicker = new ProviderModelPicker($('chat-sidebar-provider'), {
  compact: true,
  onChange: (provider, model) => changeProviderAndModel('chat', provider, model)
})

const settingTransPicker = new ProviderModelPicker($('setting-trans-provider'), {
  compact: false,
  onChange: () => {}
})

const settingChatPicker = new ProviderModelPicker($('setting-chat-provider'), {
  compact: false,
  onChange: () => {}
})

const POPULAR_MODELS = {} // kept for backward compat

function updateModelDropdown(provider, selectEl, customGroupEl, customInputEl, currentModel, availableOllamaModels = []) {
  selectEl.innerHTML = ''
  
  let models = []
  if (provider === 'ollama') {
    models = availableOllamaModels.map(m => ({ value: m, text: m }))
  } else if (POPULAR_MODELS[provider]) {
    models = [...POPULAR_MODELS[provider]]
  }
  
  models.forEach(m => {
    const opt = document.createElement('option')
    opt.value = m.value
    opt.textContent = m.text
    selectEl.appendChild(opt)
  })
  
  const customOpt = document.createElement('option')
  customOpt.value = 'custom'
  customOpt.textContent = '직접 입력...'
  selectEl.appendChild(customOpt)
  
  if (currentModel) {
    const found = models.some(m => m.value === currentModel)
    if (found) {
      selectEl.value = currentModel
      customGroupEl.classList.add('hidden')
      customInputEl.value = ''
    } else {
      selectEl.value = 'custom'
      customGroupEl.classList.remove('hidden')
      customInputEl.value = currentModel
    }
  } else {
    if (models.length > 0) {
      selectEl.value = models[0].value
      customGroupEl.classList.add('hidden')
      customInputEl.value = ''
    } else {
      selectEl.value = 'custom'
      customGroupEl.classList.remove('hidden')
      customInputEl.value = ''
    }
  }
}

function updatePullModelSectionVisibility() {
  if (settingTransPicker.getValue().provider === 'ollama' || settingChatPicker.getValue().provider === 'ollama') {
    pullModelSection.classList.remove('hidden')
  } else {
    pullModelSection.classList.add('hidden')
  }
}

async function refreshSystemSettings() {
  try {
    const sys = await getSystemSettingsAPI()
    
    state.availableOllamaModels = sys.available_models || []
    
    settingOllamaHost.value = sys.ollama_host || ''
    settingOpenAIKey.value = sys.openai_api_key || ''
    settingGeminiKey.value = sys.gemini_api_key || ''
    settingClaudeKey.value = sys.claude_api_key || ''
    
    viewerTransPicker.setValue(sys.trans_provider || 'antigravity', sys.trans_model)
    settingTransPicker.setValue(sys.trans_provider || 'antigravity', sys.trans_model)
    chatSidebarPicker.setValue(sys.chat_provider || 'antigravity', sys.chat_model)
    settingChatPicker.setValue(sys.chat_provider || 'antigravity', sys.chat_model)
    
    const promptTemplate = $('setting-prompt-template')
    if (promptTemplate) {
      promptTemplate.value = sys.translation_prompt_template || ''
    }
    
    updatePullModelSectionVisibility()
    
  } catch (err) {
    console.warn('System settings load error:', err)
  }
}

// ── Provider + Model 통합 변경 헬퍼 ──────────────────
async function changeProviderAndModel(type, newProvider, newModel) {
  try {
    const sys = await getSystemSettingsAPI()
    const payload = {
      ollama_host: sys.ollama_host || '',
      trans_provider: type === 'trans' ? newProvider : (sys.trans_provider || 'antigravity'),
      trans_model: type === 'trans' ? newModel : (sys.trans_model || ''),
      chat_provider: type === 'chat' ? newProvider : (sys.chat_provider || 'antigravity'),
      chat_model: type === 'chat' ? newModel : (sys.chat_model || ''),
      openai_api_key: sys.openai_api_key || '',
      gemini_api_key: sys.gemini_api_key || '',
      claude_api_key: sys.claude_api_key || '',
      translation_prompt_template: sys.translation_prompt_template || ''
    }
    await saveSystemSettingsAPI(payload)
    // sync settings pickers
    if (type === 'trans') {
      settingTransPicker.setValue(newProvider, newModel)
    } else {
      settingChatPicker.setValue(newProvider, newModel)
    }
    updatePullModelSectionVisibility()
    await checkAIStatus()
    showToast(`${type === 'trans' ? '번역' : '어시스턴트'} AI가 변경되었습니다.`, 'success')
    if (type === 'trans' && state.sessionId) {
      if (confirm('번역 AI가 변경되었습니다. 기존 캐시를 삭제하고 처음부터 다시 번역하시겠습니까?')) {
        retranslateBtn.click()
      }
    }
  } catch (err) {
    showToast(err.message, 'error')
    await refreshSystemSettings()
  }
}

// ── EasyPaper 설정 모달 이벤트 ──────────────────────────
globalSettingsBtn.addEventListener('click', async () => {
  settingsModal.classList.remove('hidden')
  
  // 1. 기본적으로 첫 번째 탭(일반 설정)을 활성화
  tabBtns.forEach(b => b.classList.remove('active'))
  tabPanes.forEach(p => p.classList.remove('active'))
  tabBtns[0].classList.add('active')
  tabPanes[0].classList.add('active')

  // 2. 일반 설정값 로드
  settingTargetLang.value = localStorage.getItem('easypaper_target_lang') || '한국어'
  settingTransStyle.value = localStorage.getItem('easypaper_style') || 'academic'
  settingIgnoreMath.checked = localStorage.getItem('easypaper_ignore_math') === 'true'
  settingIgnoreTable.checked = localStorage.getItem('easypaper_ignore_table') !== 'false'
  settingIgnoreRefs.checked = localStorage.getItem('easypaper_ignore_refs') === 'true'
  settingDefaultZoom.value = localStorage.getItem('easypaper_default_zoom') || '1.5'

  // 3. 시스템 설정값 로드 (백엔드 통신)
  await refreshSystemSettings()

  // 4. 계정 변경값 초기화
  changeCurrentPassword.value = ''
  changeNewUsername.value = state.username || 'admin'
  changeNewPassword.value = ''
  changeNewPasswordConfirm.value = ''
})

closeSettingsBtn.addEventListener('click', () => {
  settingsModal.classList.add('hidden')
})

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.add('hidden')
  }
})

// 탭 버튼 클릭 이벤트 바인딩
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'))
    tabPanes.forEach(p => p.classList.remove('active'))
    
    btn.classList.add('active')
    const paneId = btn.dataset.tab
    const pane = $(paneId)
    if (pane) pane.classList.add('active')
  })
})

// (provider+model event listeners are now handled inside ProviderModelPicker instances)

// Ollama 모델 다운로드 (Pull)
settingPullModelBtn.addEventListener('click', () => {
  const modelName = settingPullModelName.value.trim()
  if (!modelName) {
    showToast('다운로드할 Ollama 모델명을 입력해주세요.', 'error')
    return
  }
  
  settingPullModelName.disabled = true
  settingPullModelBtn.disabled = true
  settingPullModelBtn.textContent = '다운로드 중...'
  pullModelProgressArea.classList.remove('hidden')
  pullStatusText.textContent = '다운로드 준비 중...'
  pullPctText.textContent = '0%'
  pullProgressBar.style.width = '0%'
  
  showToast(`${modelName} 모델 다운로드를 시작합니다. 시간이 걸릴 수 있습니다.`, 'info')
  
  const abortStream = streamPullModelAPI(
    modelName,
    (data) => {
      if (data.status) {
        pullStatusText.textContent = data.status
      }
      if (data.total && data.completed) {
        const pct = Math.round((data.completed / data.total) * 100) || 0
        pullProgressBar.style.width = `${pct}%`
        pullPctText.textContent = `${pct}%`
      }
    },
    async () => {
      showToast(`${modelName} 모델 다운로드가 완료되었습니다!`, 'success')
      settingPullModelName.disabled = false
      settingPullModelBtn.disabled = false
      settingPullModelBtn.textContent = '다운로드'
      pullModelProgressArea.classList.add('hidden')
      settingPullModelName.value = ''
      
      // 드롭다운 새로고침
      await refreshSystemSettings()
    },
    (err) => {
      showToast(`다운로드 실패: ${err.message}`, 'error')
      settingPullModelName.disabled = false
      settingPullModelBtn.disabled = false
      settingPullModelBtn.textContent = '다운로드'
      pullModelProgressArea.classList.add('hidden')
    }
  )
})

// 추천 모델 버튼 클릭 시 자동 입력 및 다운로드 시작
document.querySelectorAll('.recommend-model-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const model = btn.dataset.model
    if (model) {
      settingPullModelName.value = model
      settingPullModelBtn.click()
    }
  })
})

// 일반 설정 폼 제출
generalSettingsForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  
  localStorage.setItem('easypaper_target_lang', settingTargetLang.value)
  localStorage.setItem('easypaper_style', settingTransStyle.value)
  localStorage.setItem('easypaper_ignore_math', settingIgnoreMath.checked)
  localStorage.setItem('easypaper_ignore_table', settingIgnoreTable.checked)
  localStorage.setItem('easypaper_ignore_refs', settingIgnoreRefs.checked)
  localStorage.setItem('easypaper_default_zoom', settingDefaultZoom.value)
  
  showToast('일반 설정이 저장되었습니다.', 'success')
  
  // 기본 줌 비율 즉시 업데이트 적용
  const newZoom = parseFloat(settingDefaultZoom.value) || 1.5
  if (state.sessionId) {
    setZoom(newZoom)
  }
  
  settingsModal.classList.add('hidden')
  
  // 현재 논문을 작업 중인 경우 번역 잡 재시작 제안
  if (state.sessionId) {
    if (confirm('번역 설정을 즉시 변경하고 다시 번역하시겠습니까?\n(확인을 누르면 기존 번역이 초기화되고 새로 번역을 시작합니다.)')) {
      // 로컬 번역 정보 전체 비우기
      state.translationCache = {}
      state.translatingPages.clear()
      state.translatedPages.clear()
      
      // UI 상의 모든 번역창 초기화
      for (let i = 1; i <= state.totalPages; i++) {
        const contentEl = $(`trans-content-${i}`)
        const statusEl = $(`trans-status-${i}`)
        if (contentEl) {
          contentEl.innerHTML = '<div class="trans-page-placeholder">스크롤하면 자동으로 번역됩니다</div>'
        }
        if (statusEl) {
          statusEl.textContent = '대기 중'
          statusEl.classList.remove('done')
        }
      }
      
      try {
        showToast('번역 작업을 재시작하는 중...', 'info')
        await restartJobAPI(state.sessionId, getTranslationOptions())
        startJobPolling(state.sessionId)
        showToast('번역 작업이 재시작되었습니다.', 'success')
      } catch (err) {
        showToast(err.message, 'error')
      }
    }
  }
})

// 시스템 설정 폼 제출
systemSettingsForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  
  const { provider: transProvider, model: transModel } = settingTransPicker.getValue()
  const { provider: chatProvider, model: chatModel } = settingChatPicker.getValue()
  
  if (!transModel) {
    showToast('번역 모델을 선택해주세요.', 'error')
    return
  }
  if (!chatModel) {
    showToast('어시스턴트 모델을 선택해주세요.', 'error')
    return
  }
  
  const settings = {
    ollama_host: settingOllamaHost.value.trim(),
    trans_provider: transProvider,
    trans_model: transModel,
    chat_provider: chatProvider,
    chat_model: chatModel,
    openai_api_key: settingOpenAIKey.value.trim(),
    gemini_api_key: settingGeminiKey.value.trim(),
    claude_api_key: settingClaudeKey.value.trim(),
    translation_prompt_template: $('setting-prompt-template').value
  }
  
  try {
    await saveSystemSettingsAPI(settings)
    // sync compact pickers
    viewerTransPicker.setValue(transProvider, transModel)
    chatSidebarPicker.setValue(chatProvider, chatModel)
    showToast('시스템 설정이 저장되었습니다.', 'success')
    settingsModal.classList.add('hidden')
    checkAIStatus()
  } catch (err) {
    showToast(err.message, 'error')
  }
})

// 고급 설정 폼 제출
const advancedSettingsForm = $('advanced-settings-form')
if (advancedSettingsForm) {
  advancedSettingsForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    
    const { provider: transProvider, model: transModel } = settingTransPicker.getValue()
    const { provider: chatProvider, model: chatModel } = settingChatPicker.getValue()
    
    if (!transModel) {
      showToast('번역 모델을 선택해주세요.', 'error')
      return
    }
    if (!chatModel) {
      showToast('어시스턴트 모델을 선택해주세요.', 'error')
      return
    }
    
    const settings = {
      ollama_host: settingOllamaHost.value.trim(),
      trans_provider: transProvider,
      trans_model: transModel,
      chat_provider: chatProvider,
      chat_model: chatModel,
      openai_api_key: settingOpenAIKey.value.trim(),
      gemini_api_key: settingGeminiKey.value.trim(),
      claude_api_key: settingClaudeKey.value.trim(),
      translation_prompt_template: $('setting-prompt-template').value
    }
    
    try {
      await saveSystemSettingsAPI(settings)
      // sync compact pickers
      viewerTransPicker.setValue(transProvider, transModel)
      chatSidebarPicker.setValue(chatProvider, chatModel)
      showToast('고급 설정(번역 프롬프트)이 저장되었습니다.', 'success')
      settingsModal.classList.add('hidden')
      checkAIStatus()
    } catch (err) {
      showToast(err.message, 'error')
    }
  })
}

// 로컬 캐시 비우기
clearCacheBtn.addEventListener('click', () => {
  if (confirm('브라우저에 저장된 PDF 어노테이션(밑줄, 하이라이트) 정보 및 설정을 모두 초기화하시겠습니까?')) {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('easypaper_')) {
        localStorage.removeItem(key)
      }
    })
    showToast('캐시가 초기화되었습니다.', 'success')
    settingsModal.classList.add('hidden')
    location.reload()
  }
})

// 계정 및 비밀번호 변경 제출
changeCredentialsForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const currentPassword = changeCurrentPassword.value
  const newUsername = changeNewUsername.value.trim()
  const newPassword = changeNewPassword.value
  const newPasswordConfirm = changeNewPasswordConfirm.value
  
  if (newPassword !== newPasswordConfirm) {
    showToast('새 비밀번호와 비밀번호 확인이 일치하지 않습니다.', 'error')
    return
  }
  
  if (currentPassword === newPassword) {
    showToast('새 비밀번호는 현재 비밀번호와 다르게 설정해야 합니다.', 'error')
    return
  }
  
  try {
    const result = await changeCredentialsAPI(currentPassword, newUsername, newPassword)
    showToast(result.message || '아이디 및 비밀번호가 변경되었습니다.', 'success')
    state.username = newUsername
    settingsModal.classList.add('hidden')
  } catch (err) {
    showToast(err.message, 'error')
  }
})


// ── 초기화 ────────────────────────────────────────
checkAuthentication()
checkAIStatus()
setInterval(checkAIStatus, 30000)

// ── 라이브러리 화면 ────────────────────────────────
async function loadLibraryCount() {
  try {
    const data = await fetchLibrary(getTranslationOptions())
    const count = data.total || 0
    if (count > 0 && libraryCountBadge) {
      libraryCountBadge.textContent = count
      libraryCountBadge.classList.remove('hidden')
    }
  } catch {}
}

async function showLibraryScreen() {
  loginScreen.classList.remove('active')
  viewerScreen.classList.remove('active')
  libraryScreen.classList.add('active')
  // 글로벌 테마 토글, 로그아웃, 설정 버튼 표시
  const globalToggle = $('global-theme-toggle')
  if (globalToggle) globalToggle.classList.remove('hidden')
  globalLogoutBtn.classList.remove('hidden')
  globalSettingsBtn.classList.remove('hidden')
  resetState()
  await renderLibrary()
}


let activeCategoryFilter = 'ALL'

async function renderLibrary() {
  libraryGrid.innerHTML = ''
  libraryCategoryFilters.innerHTML = ''
  try {
    const data = await fetchLibrary(getTranslationOptions())
    const docs = data.documents || []
    if (docs.length > 0) {
      if (libraryCountBadge) {
        libraryCountBadge.textContent = docs.length
        libraryCountBadge.classList.remove('hidden')
      }
    } else {
      if (libraryCountBadge) {
        libraryCountBadge.classList.add('hidden')
      }
    }
    if (docs.length === 0) {
      libraryGrid.appendChild(createEmptyState()); return
    }

    // Extract unique categories
    const categoriesSet = new Set()
    docs.forEach(doc => {
      const cats = doc.metadata?.categories || []
      cats.forEach(c => categoriesSet.add(c.trim()))
    })
    const uniqueCategories = Array.from(categoriesSet).sort()

    // Render Filter Chips if there are categories
    if (uniqueCategories.length > 0) {
      // "전체" (ALL) filter button
      const allBtn = document.createElement('button')
      allBtn.className = `category-filter-btn ${activeCategoryFilter === 'ALL' ? 'active' : ''}`
      allBtn.dataset.category = 'ALL'
      allBtn.innerHTML = `📚 전체 (${docs.length})`
      allBtn.addEventListener('click', () => {
        activeCategoryFilter = 'ALL'
        filterLibraryCards(docs)
      })
      libraryCategoryFilters.appendChild(allBtn)

      uniqueCategories.forEach(cat => {
        const count = docs.filter(doc => (doc.metadata?.categories || []).includes(cat)).length
        const btn = document.createElement('button')
        btn.className = `category-filter-btn ${activeCategoryFilter === cat ? 'active' : ''}`
        btn.dataset.category = cat
        btn.innerHTML = `🏷️ ${escapeHtml(cat)} (${count})`
        btn.addEventListener('click', () => {
          activeCategoryFilter = cat
          filterLibraryCards(docs)
        })
        libraryCategoryFilters.appendChild(btn)
      })
    }

    // Initial card rendering
    filterLibraryCards(docs)
  } catch (err) {
    console.error(err)
    libraryGrid.innerHTML = `<div class="lib-empty"><p style="color:var(--error)">라이브러리 불러오기 실패</p></div>`
  }
}

function filterLibraryCards(docs) {
  libraryGrid.innerHTML = ''

  // Update filter buttons active class
  document.querySelectorAll('.category-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.category === activeCategoryFilter)
  })

  // Filter docs
  const filteredDocs = activeCategoryFilter === 'ALL'
    ? docs
    : docs.filter(doc => (doc.metadata?.categories || []).includes(activeCategoryFilter))

  if (filteredDocs.length === 0) {
    libraryGrid.appendChild(createEmptyState()); return
  }

  filteredDocs.forEach(doc => libraryGrid.appendChild(createDocCard(doc)))
}

function createEmptyState() {
  const el = document.createElement('div')
  el.className = 'lib-empty'
  el.innerHTML = `<div style="font-size:48px;margin-bottom:16px">📚</div>
    <p>저장된 논문이 없습니다</p>
    <p style="font-size:13px;color:var(--text-muted);margin-top:8px">PDF를 업로드하면 자동으로 저장됩니다</p>`
  return el
}

function createDocCard(doc) {
  const translated = doc.translated_pages?.length || 0
  const total = doc.total_pages || 1
  const pct = Math.round((translated / total) * 100)
  const isDone = translated >= total
  const date = new Date(doc.created_at).toLocaleDateString('ko-KR', { year:'numeric', month:'short', day:'numeric' })

  const categories = doc.metadata?.categories || []
  let tagsHtml = ''
  if (categories.length > 0) {
    tagsHtml = `<div class="doc-card-tags">` +
      categories.map(cat => `<span class="doc-card-tag">${escapeHtml(cat)}</span>`).join('') +
      `</div>`
  }

  const card = document.createElement('div')
  card.className = 'doc-card'
  card.innerHTML = `
    <div class="doc-card-icon">📄</div>
    <div class="doc-card-title">${escapeHtml(doc.filename)}</div>
    ${tagsHtml}
    <div class="doc-card-meta">
      <span>📅 ${date}</span><span>📑 ${total}페이지</span>
    </div>
    <div class="doc-card-progress">
      <div class="doc-progress-bar-wrap"><div class="doc-progress-bar" style="width:${pct}%"></div></div>
      <div class="doc-progress-label ${isDone ? 'done' : ''}">
        <span>${isDone ? '✓ 번역 완료' : `번역 ${translated}/${total}페이지`}</span>
        <span>${pct}%</span>
      </div>
    </div>
    <div class="doc-card-actions">
      <button class="doc-open-btn" data-id="${doc.id}">열기</button>
      <button class="doc-delete-btn" data-id="${doc.id}" title="삭제">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>`

  card.querySelector('.doc-open-btn').addEventListener('click', (e) => { e.stopPropagation(); openFromLibrary(doc) })
  card.querySelector('.doc-delete-btn').addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!confirm(`"${doc.filename}"을 삭제할까요?`)) return
    try { await deleteLibraryDoc(doc.id); showToast('삭제되었습니다', 'success'); await renderLibrary() }
    catch { showToast('삭제 실패', 'error') }
  })
  card.addEventListener('click', () => openFromLibrary(doc))
  return card
}

async function openFromLibrary(doc) {
  state.sessionId  = doc.id
  state.filename   = doc.filename
  state.totalPages = doc.total_pages
  state.translationCache = {}
  state.translatingPages = new Set()
  state.translatedPages  = new Set()

  // 저장된 번역 미리 로드
  const opts = getTranslationOptions()
  for (const pageNum of (doc.translated_pages || [])) {
    try {
      const res = await fetchLibraryTranslation(doc.id, pageNum, opts)
      state.translationCache[pageNum] = res.translation
      state.translatedPages.add(pageNum)
    } catch {}
  }

  // 채팅 내역 초기화 및 복원
  state.chatHistory = []
  chatMessages.innerHTML = '<div class="chat-message assistant"><div class="message-bubble">안녕하세요! 이 논문의 내용에 대해 궁금한 점을 질문하시면 해당 분야의 전문가로서 답변해 드립니다.<br><br><strong>💡 질문 예시:</strong><ul><li>이 논문의 핵심 연구 내용과 기여도를 요약해줘.</li><li>본문에서 제안하는 알고리즘/방법론의 상세 과정을 설명해줘.</li><li>실험 결과에서 제시된 주요 수치와 의의는 무엇이야?</li></ul></div></div>'
  
  try {
    const res = await getChatHistoryAPI(doc.id)
    const history = res.history || []
    if (history && history.length > 0) {
      for (const msg of history) {
        state.chatHistory.push({ role: msg.role, content: msg.content })
        appendChatMessage(
          msg.role,
          msg.role === 'assistant' ? formatChatHtml(msg.content) : msg.content,
          msg.role === 'assistant'
        )
      }
    }
  } catch (err) {
    console.error('채팅 기록 로드 실패:', err)
  }

  await loadPDF(`/api/library/${doc.id}/pdf`)
  docTitle.textContent  = doc.filename
  pageTotal.textContent = `/ ${doc.total_pages}`
  pageInput.max   = doc.total_pages
  pageInput.value = 1

  showViewer()
  await initScrollViewer()
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

libUploadBtn.addEventListener('click', () => { fileInput.click() })

// ── 테마 토글 기능 ──────────────────────────────
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'dark'
  const isLight = savedTheme === 'light'
  document.body.classList.toggle('light-theme', isLight)
  updateThemeIcons(isLight)
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-theme')
  localStorage.setItem('theme', isLight ? 'light' : 'dark')
  updateThemeIcons(isLight)
  showToast(isLight ? '라이트 모드로 전환 ✓' : '다크 모드로 전환 ✓', 'success')
}

function updateThemeIcons(isLight) {
  const sunIcons = document.querySelectorAll('.sun-icon')
  const moonIcons = document.querySelectorAll('.moon-icon')
  sunIcons.forEach(icon => icon.classList.toggle('hidden', !isLight))
  moonIcons.forEach(icon => icon.classList.toggle('hidden', isLight))
}

const themeToggleBtn = $('theme-toggle-btn')
const globalThemeToggleBtn = $('global-theme-toggle-btn')

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', toggleTheme)
}
if (globalThemeToggleBtn) {
  globalThemeToggleBtn.addEventListener('click', toggleTheme)
}

// 초기 테마 적용
initTheme()

// ── PDF 텍스트 하이라이트 & 밑줄 (Annotation) 기능 ──────────────────

// 로컬 스토리지에서 어노테이션 정보 불러오기
function loadAnnotations(sessionId) {
  try {
    const data = localStorage.getItem(`easypaper_annotations_${sessionId}`)
    return data ? JSON.parse(data) : {}
  } catch {
    return {}
  }
}

// 로컬 스토리지에 어노테이션 정보 저장하기
function saveAnnotations(sessionId, annotations) {
  localStorage.setItem(`easypaper_annotations_${sessionId}`, JSON.stringify(annotations))
}

// textLayer 내 텍스트 전체에 대한 선택 위치(Character Offset) 구하기
function getPageTextOffset(range, textLayerDiv) {
  let startOffset = null
  let endOffset = null
  let currentPos = 0

  const walker = document.createTreeWalker(textLayerDiv, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node === range.startContainer) {
      startOffset = currentPos + range.startOffset
    }
    if (node === range.endContainer) {
      endOffset = currentPos + range.endOffset
    }
    currentPos += node.length
  }
  return { startOffset, endOffset }
}

// Range 객체를 받아와 화면에 어노테이션(하이라이트/밑줄)을 실제로 렌더링하고 로컬에 저장
function applyAnnotationToRange(range, type, textLayerDiv, pageNum) {
  const offsets = getPageTextOffset(range, textLayerDiv)
  if (offsets.startOffset === null || offsets.endOffset === null) return
  
  const text = range.toString()

  // 1. DOM에 스타일 적용 (텍스트 노드 분할)
  applyAnnotationToRangeWithoutSave(range, type)

  // 2. LocalStorage에 저장
  const annotations = loadAnnotations(state.sessionId)
  if (!annotations[`page_${pageNum}`]) {
    annotations[`page_${pageNum}`] = []
  }
  annotations[`page_${pageNum}`].push({
    type,
    text,
    startOffset: offsets.startOffset,
    endOffset: offsets.endOffset
  })
  saveAnnotations(state.sessionId, annotations)
  showToast(type === 'highlight' ? '하이라이트가 추가되었습니다 ✓' : '밑줄이 추가되었습니다 ✓', 'success')
}

// 저장 없이 DOM 상에 직접 span을 감싸서 스타일 입히는 헬퍼
function applyAnnotationToRangeWithoutSave(range, type) {
  const textNodes = []
  const commonAncestor = range.commonAncestorContainer
  
  if (commonAncestor.nodeType === 3) { // 3 is Text Node
    if (range.intersectsNode(commonAncestor)) {
      textNodes.push(commonAncestor)
    }
  } else {
    const treeWalker = document.createTreeWalker(
      commonAncestor,
      4 // 4 is NodeFilter.SHOW_TEXT
    )
    while (treeWalker.nextNode()) {
      const node = treeWalker.currentNode
      if (range.intersectsNode(node)) {
        textNodes.push(node)
      }
    }
  }

  textNodes.forEach((node) => {
    let startOffset = 0
    let endOffset = node.length

    if (node === range.startContainer) {
      startOffset = range.startOffset
    }
    if (node === range.endContainer) {
      endOffset = range.endOffset
    }

    if (startOffset >= endOffset) return

    const span = document.createElement('span')
    span.className = type === 'highlight' ? 'pdf-annotation-highlight' : 'pdf-annotation-underline'
    
    const subRange = document.createRange()
    subRange.setStart(node, startOffset)
    subRange.setEnd(node, endOffset)
    
    try {
      subRange.surroundContents(span)
    } catch (e) {
      console.warn("Failed to surround subrange:", e)
    }
  })
}

// 로컬 스토리지에 저장된 캐릭터 오프셋들로부터 어노테이션들을 복원하는 함수
function applyAnnotationsFromOffsets(textLayerDiv, annotations) {
  if (!annotations || annotations.length === 0) return

  annotations.forEach(ann => {
    let currentPos = 0
    const range = document.createRange()
    let startNode = null, startNodeOffset = 0
    let endNode = null, endNodeOffset = 0

    const walker = document.createTreeWalker(textLayerDiv, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const nextPos = currentPos + node.length

      if (!startNode && ann.startOffset >= currentPos && ann.startOffset <= nextPos) {
        startNode = node
        startNodeOffset = ann.startOffset - currentPos
      }
      if (!endNode && ann.endOffset >= currentPos && ann.endOffset <= nextPos) {
        endNode = node
        endNodeOffset = ann.endOffset - currentPos
      }

      currentPos = nextPos
    }

    if (startNode && endNode) {
      try {
        range.setStart(startNode, startNodeOffset)
        range.setEnd(endNode, endNodeOffset)
        applyAnnotationToRangeWithoutSave(range, ann.type)
      } catch (e) {
        console.warn("Failed to restore annotation:", ann, e)
      }
    }
  })
}

// ── 팝업 툴팁 선택 메뉴 관리 ──
let selectionMenu = null

function createSelectionMenu() {
  if (selectionMenu) return selectionMenu
  
  const menu = document.createElement('div')
  menu.id = 'selection-menu'
  menu.className = 'selection-menu hidden'
  menu.innerHTML = `
    <div class="menu-annotate-group" style="display: flex; gap: 6px; align-items: center;">
      <button class="menu-btn highlight-btn" title="하이라이트">🟡</button>
      <button class="menu-btn underline-btn" title="밑줄">🔴</button>
      <button class="menu-btn clear-btn" title="지우기">❌</button>
      <div class="menu-divider" style="width: 1px; background: var(--border-strong); margin: 0 4px; align-self: stretch;"></div>
    </div>
    <button class="menu-btn ask-ai-btn" title="AI 어시스턴트에게 물어보기" style="display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--text-primary); padding: 0 6px;">
      <span>🤖 AI 어시스턴트에게 물어보기</span>
    </button>
  `
  document.body.appendChild(menu)
  selectionMenu = menu
  
  menu.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  
  menu.querySelector('.highlight-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); handleAnnotate('highlight')
  })

  menu.querySelector('.underline-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); handleAnnotate('underline')
  })

  menu.querySelector('.clear-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); handleAnnotate('clear')
  })

  menu.querySelector('.ask-ai-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const selection = window.getSelection()
    const text = selection.toString().trim()
    if (text) {
      askAIAssistant(text)
    }
    selection.removeAllRanges()
    hideSelectionMenu()
  })

  return menu
}

function handleAnnotate(type) {
  const selection = window.getSelection()
  if (!selection.rangeCount) return
  const range = selection.getRangeAt(0)

  let textLayer = range.commonAncestorContainer
  if (textLayer && textLayer.nodeType === 3) {
    textLayer = textLayer.parentElement || textLayer.parentNode
  }
  const textLayerDiv = (textLayer && textLayer.nodeType === 1) ? textLayer.closest('.textLayer') : null
  if (!textLayerDiv) return

  const pageWrapper = textLayerDiv.closest('.pdf-page-wrapper')
  if (!pageWrapper) return
  const pageNum = parseInt(pageWrapper.dataset.page)

  if (type === 'clear') {
    clearAnnotationsInRange(range, textLayerDiv, pageNum)
  } else {
    applyAnnotationToRange(range, type, textLayerDiv, pageNum)
  }

  hideSelectionMenu()
}

function clearAnnotationsInRange(range, textLayerDiv, pageNum) {
  const offsets = getPageTextOffset(range, textLayerDiv)
  if (offsets.startOffset === null || offsets.endOffset === null) return

  const annotations = loadAnnotations(state.sessionId)
  if (!annotations[`page_${pageNum}`]) return

  const originalCount = annotations[`page_${pageNum}`].length
  annotations[`page_${pageNum}`] = annotations[`page_${pageNum}`].filter(ann => {
    const hasOverlap = !(ann.endOffset <= offsets.startOffset || ann.startOffset >= offsets.endOffset)
    return !hasOverlap
  })

  if (annotations[`page_${pageNum}`].length !== originalCount) {
    saveAnnotations(state.sessionId, annotations)
    showToast('선택 영역의 하이라이트/밑줄이 삭제되었습니다 ✓', 'success')
    reRenderPageAnnotations(textLayerDiv, pageNum)
  }
  window.getSelection().removeAllRanges()
}

function reRenderPageAnnotations(textLayerDiv, pageNum) {
  const spans = textLayerDiv.querySelectorAll('.pdf-annotation-highlight, .pdf-annotation-underline')
  spans.forEach(span => {
    const parent = span.parentNode
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span)
    }
    parent.removeChild(span)
  })
  
  textLayerDiv.normalize()

  const annotations = loadAnnotations(state.sessionId)
  applyAnnotationsFromOffsets(textLayerDiv, annotations[`page_${pageNum}`] || [])
}

function showSelectionMenu(rect, showAnnotateGroup) {
  const menu = createSelectionMenu()
  menu.classList.remove('hidden')
  
  const annotateGroup = menu.querySelector('.menu-annotate-group')
  if (annotateGroup) {
    if (showAnnotateGroup) {
      annotateGroup.style.display = 'flex'
    } else {
      annotateGroup.style.display = 'none'
    }
  }
  
  const menuWidth = menu.offsetWidth || 120
  const menuHeight = menu.offsetHeight || 36
  
  const left = rect.left + rect.width / 2 - menuWidth / 2 + window.scrollX
  const top = rect.top - menuHeight - 8 + window.scrollY
  
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`
}

function hideSelectionMenu() {
  if (selectionMenu) {
    selectionMenu.classList.add('hidden')
  }
}

// 통합 텍스트 선택 종료 감지 리스너
document.addEventListener('mouseup', () => {
  setTimeout(() => {
    try {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        hideSelectionMenu()
        return
      }

      const range = selection.getRangeAt(0)
      if (!range) {
        hideSelectionMenu()
        return
      }

      const selectedText = selection.toString().trim()
      if (!selectedText) {
        hideSelectionMenu()
        return
      }

      let container = range.commonAncestorContainer
      if (!container) {
        hideSelectionMenu()
        return
      }

      if (container.nodeType === 3) {
        container = container.parentElement || container.parentNode
      }
      
      const isTextLayer = container && container.nodeType === 1 && container.closest('.textLayer')
      const isTransContent = container && container.nodeType === 1 && container.closest('.trans-page-content')

      if (!isTextLayer && !isTransContent) {
        hideSelectionMenu()
        return
      }

      const rect = range.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        showSelectionMenu(rect, !!isTextLayer)
      }
    } catch (err) {
      console.warn("Selection handler error:", err)
      hideSelectionMenu()
    }
  }, 20)
})

// PDF.js 텍스트 레이어 렌더 완료 콜백 등록
window.onTextLayerRendered = (textLayerDiv, pageNum) => {
  if (!state.sessionId) return
  const annotations = loadAnnotations(state.sessionId)
  if (annotations[`page_${pageNum}`]) {
    applyAnnotationsFromOffsets(textLayerDiv, annotations[`page_${pageNum}`])
  }
}


// ── AI Chat Sidebar ──────────────────────────────
function toggleChatSidebar() {
  if (!state.sessionId) {
    showToast('논문을 먼저 업로드하거나 선택해주세요.', 'error')
    return
  }
  const isHidden = chatSidebar.classList.toggle('hidden')
  if (chatResizer) chatResizer.classList.toggle('hidden', isHidden)
  chatToggleBtn.classList.toggle('active', !isHidden)
  if (!isHidden) {
    chatInput.focus()
    setTimeout(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight
    }, 100)
  }
}

function resetChatUI() {
  chatMessages.innerHTML = '<div class="chat-message assistant"><div class="message-bubble">안녕하세요! 이 논문의 내용에 대해 궁금한 점을 질문하시면 해당 분야의 전문가로서 답변해 드립니다.<br><br><strong>💡 질문 예시:</strong><ul><li>이 논문의 핵심 연구 내용과 기여도를 요약해줘.</li><li>본문에서 제안하는 알고리즘/방법론의 상세 과정을 설명해줘.</li><li>실험 결과에서 제시된 주요 수치와 의의는 무엇이야?</li></ul></div></div>'
  chatInput.value = ''
  chatInput.style.height = 'auto'
}

function formatChatHtml(text) {
  if (!text) return ''

  let html = formatTranslationHtml(text)

  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  
  html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
    const cleanCode = code.replace(/<br>/g, '\n')
    return `<pre style="background: var(--bg-hover); padding: 10px; border-radius: var(--radius-sm); overflow-x: auto; font-family: var(--font-mono); font-size: 12px; margin: 8px 0; border: 1px solid var(--border-strong); white-space: pre-wrap; word-break: break-all;">${cleanCode}</pre>`
  })

  html = html.replace(/`(.*?)`/g, '<code style="background: var(--bg-hover); padding: 2px 5px; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 12px; border: 1px solid var(--border-strong);">$1</code>')

  const lines = html.split('<br>')
  let inList = false
  const processedLines = []

  for (let line of lines) {
    let trimmed = line.trim()
    
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      if (!inList) {
        processedLines.push('<ul>')
        inList = true
      }
      processedLines.push(`<li>${trimmed.substring(2)}</li>`)
    } else {
      if (inList) {
        processedLines.push('</ul>')
        inList = false
      }
      processedLines.push(line)
    }
  }
  if (inList) {
    processedLines.push('</ul>')
  }

  return processedLines.join('<br>')
    .replace(/<\/ul><br>/g, '</ul>')
    .replace(/<br><ul>/g, '<ul>')
    .replace(/<br><li>/g, '<li>')
    .replace(/<\/li><br>/g, '</li>')
}

function updateChatSendBtnIcon(isGenerating) {
  if (isGenerating) {
    chatSendBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
      </svg>
    `;
    chatSendBtn.title = '답변 생성 중단';
  } else {
    chatSendBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="22" y1="2" x2="11" y2="13"/>
        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
      </svg>
    `;
    chatSendBtn.title = '전송';
  }
}

function regenerateResponse(assistantMsgEl) {
  if (state.chatActiveStream) return;
  
  let prevEl = assistantMsgEl.previousElementSibling;
  while (prevEl && !prevEl.classList.contains('user')) {
    prevEl = prevEl.previousElementSibling;
  }
  
  if (!prevEl) {
    showToast('이전 질문을 찾을 수 없습니다.', 'error');
    return;
  }
  
  let nextEl = assistantMsgEl;
  while (nextEl) {
    const toRemove = nextEl;
    nextEl = nextEl.nextElementSibling;
    toRemove.remove();
  }
  
  const remainingUserCount = chatMessages.querySelectorAll('.chat-message.user').length;
  const remainingAssistantCount = chatMessages.querySelectorAll('.chat-message.assistant').length - 1;
  const expectedHistoryLength = remainingUserCount + Math.max(0, remainingAssistantCount);
  state.chatHistory = state.chatHistory.slice(0, expectedHistoryLength);
  
  if (state.chatHistory.length === 0 || state.chatHistory[state.chatHistory.length - 1].role !== 'user') {
    showToast('대화 기록 싱크 오류', 'error');
    return;
  }
  
  appendTypingIndicator();
  
  chatInput.disabled = true;
  updateChatSendBtnIcon(true);
  
  let accumulatedText = '';
  let replyBubble = null;
  let firstToken = true;
  
  state.chatActiveStream = streamChatAPI(
    state.sessionId,
    state.chatHistory,
    (token) => {
      if (firstToken) {
        removeTypingIndicator();
        replyBubble = appendChatMessage('assistant', '', true).querySelector('.message-bubble');
        firstToken = false;
      }
      accumulatedText += token;
      state.chatCurrentText = accumulatedText;
      replyBubble.innerHTML = formatChatHtml(accumulatedText);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    },
    () => {
      state.chatHistory.push({ role: 'assistant', content: accumulatedText });
      state.chatActiveStream = null;
      
      if (replyBubble) {
        applyKatexToElement(replyBubble)
        if (replyBubble.parentElement) {
          appendActionButtons(replyBubble.parentElement, 'assistant', accumulatedText);
        }
      }
      
      chatInput.disabled = false;
      updateChatSendBtnIcon(false);
      chatInput.focus();
    },
    (err) => {
      removeTypingIndicator();
      state.chatActiveStream = null;
      if (firstToken) {
        appendChatMessage('assistant', `⚠️ 답변 중 오류가 발생했습니다: ${err.message}`, false);
      } else if (replyBubble) {
        replyBubble.innerHTML += `<br><br><span style="color: var(--error);">[오류: ${err.message}]</span>`;
      }
      chatInput.disabled = false;
      updateChatSendBtnIcon(false);
      chatInput.focus();
    }
  );
}

function appendActionButtons(msgEl, role, content) {
  if (!content || content.startsWith('⚠️')) return
  
  const existingActions = msgEl.querySelector('.message-actions')
  if (existingActions) existingActions.remove()
  
  const actionsEl = document.createElement('div')
  actionsEl.className = 'message-actions'
  actionsEl.style.display = 'flex'
  actionsEl.style.gap = '8px'
  actionsEl.style.marginTop = '4px'
  actionsEl.style.alignSelf = role === 'user' ? 'flex-end' : 'flex-start'
  
  const copyBtn = document.createElement('button')
  copyBtn.className = 'msg-action-btn'
  copyBtn.innerHTML = '📋 복사'
  copyBtn.style.background = 'none'
  copyBtn.style.border = 'none'
  copyBtn.style.color = 'var(--text-muted)'
  copyBtn.style.fontSize = '11px'
  copyBtn.style.cursor = 'pointer'
  copyBtn.title = '텍스트 복사'
  copyBtn.addEventListener('click', () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(content).then(() => {
        showToast('텍스트가 복사되었습니다.', 'success')
      }).catch(err => {
        showToast('복사 실패', 'error')
      })
    } else {
      // Fallback for non-secure HTTP contexts
      const textarea = document.createElement('textarea')
      textarea.value = content
      textarea.style.position = 'fixed'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand('copy')
        showToast('텍스트가 복사되었습니다.', 'success')
      } catch (err) {
        showToast('복사 실패', 'error')
      }
      document.body.removeChild(textarea)
    }
  })
  actionsEl.appendChild(copyBtn)
  
  if (role === 'assistant') {
    const regenBtn = document.createElement('button')
    regenBtn.className = 'msg-action-btn'
    regenBtn.innerHTML = '🔄 다시 받기'
    regenBtn.style.background = 'none'
    regenBtn.style.border = 'none'
    regenBtn.style.color = 'var(--text-muted)'
    regenBtn.style.fontSize = '11px'
    regenBtn.style.cursor = 'pointer'
    regenBtn.title = '답변 다시 생성'
    regenBtn.addEventListener('click', () => {
      regenerateResponse(msgEl)
    })
    actionsEl.appendChild(regenBtn)
  }
  
  msgEl.appendChild(actionsEl)
}

function appendChatMessage(role, content, isHtml = false) {
  const msgEl = document.createElement('div')
  msgEl.className = `chat-message ${role}`
  
  const bubbleEl = document.createElement('div')
  bubbleEl.className = 'message-bubble'
  
  if (isHtml) {
    bubbleEl.innerHTML = content
  } else {
    bubbleEl.textContent = content
  }
  
  msgEl.appendChild(bubbleEl)
  
  if (content) {
    appendActionButtons(msgEl, role, content)
  }
  
  chatMessages.appendChild(msgEl)
  chatMessages.scrollTop = chatMessages.scrollHeight
  return msgEl
}

function appendTypingIndicator() {
  const msgEl = document.createElement('div')
  msgEl.className = 'chat-message assistant temp-typing'
  
  const bubbleEl = document.createElement('div')
  bubbleEl.className = 'message-bubble'
  bubbleEl.innerHTML = `
    <div class="typing-indicator">
      <span></span>
      <span></span>
      <span></span>
    </div>`
  
  msgEl.appendChild(bubbleEl)
  chatMessages.appendChild(msgEl)
  chatMessages.scrollTop = chatMessages.scrollHeight
  return msgEl
}

function removeTypingIndicator() {
  const indicators = chatMessages.querySelectorAll('.temp-typing')
  indicators.forEach(el => el.remove())
}

async function sendChatMessage() {
  if (!state.sessionId) return
  if (state.chatActiveStream) return
  
  const text = chatInput.value.trim()
  if (!text) return
  
  chatInput.value = ''
  chatInput.style.height = 'auto'
  
  appendChatMessage('user', text)
  state.chatHistory.push({ role: 'user', content: text })
  
  appendTypingIndicator()
  
  chatInput.disabled = true
  updateChatSendBtnIcon(true)
  
  let accumulatedText = ''
  let replyBubble = null
  let firstToken = true
  state.chatCurrentText = ''
  
  state.chatActiveStream = streamChatAPI(
    state.sessionId,
    state.chatHistory,
    // onToken
    (token) => {
      if (firstToken) {
        removeTypingIndicator()
        replyBubble = appendChatMessage('assistant', '', true).querySelector('.message-bubble')
        firstToken = false
      }
      
      accumulatedText += token
      state.chatCurrentText = accumulatedText
      replyBubble.innerHTML = formatChatHtml(accumulatedText)
      chatMessages.scrollTop = chatMessages.scrollHeight
    },
    // onDone
    () => {
      state.chatActiveStream = null
      state.chatHistory.push({ role: 'assistant', content: accumulatedText })
      
      if (replyBubble && replyBubble.parentElement) {
        appendActionButtons(replyBubble.parentElement, 'assistant', accumulatedText)
      }
      
      chatInput.disabled = false
      updateChatSendBtnIcon(false)
      chatInput.focus()
    },
    // onError
    (err) => {
      removeTypingIndicator()
      state.chatActiveStream = null
      
      if (firstToken) {
        appendChatMessage('assistant', `⚠️ 답변 중 오류가 발생했습니다: ${err.message}`, false)
      } else if (replyBubble) {
        replyBubble.innerHTML += `<br><br><span style="color: var(--error);">[오류: ${err.message}]</span>`
      }
      
      chatInput.disabled = false
      updateChatSendBtnIcon(false)
      chatInput.focus()
    }
  )
}

function initChatListeners() {
  if (chatToggleBtn) {
    chatToggleBtn.addEventListener('click', toggleChatSidebar)
  }
  
  if (chatCloseBtn) {
    chatCloseBtn.addEventListener('click', toggleChatSidebar)
  }
  
  if (chatSendBtn) {
    chatSendBtn.addEventListener('click', () => {
      if (state.chatActiveStream) {
        state.chatActiveStream()
        state.chatActiveStream = null
        removeTypingIndicator()
        
        if (state.chatCurrentText) {
          state.chatHistory.push({ role: 'assistant', content: state.chatCurrentText })
        } else {
          state.chatHistory.pop()
        }
        
        showToast('답변 생성이 중단되었습니다.', 'info')
        
        chatInput.disabled = false
        updateChatSendBtnIcon(false)
        chatInput.focus()
      } else {
        sendChatMessage()
      }
    })
  }
  
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendChatMessage()
      }
    })
    
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto'
      chatInput.style.height = `${chatInput.scrollHeight}px`
    })
  }

  // Load saved sidebar width
  const savedWidth = localStorage.getItem('easypaper_chat_sidebar_width')
  if (savedWidth && chatSidebar) {
    chatSidebar.style.width = `${savedWidth}px`
  }

  // Sidebar drag resizer logic
  let isDragging = false
  if (chatResizer && chatSidebar) {
    chatResizer.addEventListener('mousedown', (e) => {
      e.preventDefault()
      isDragging = true
      chatResizer.classList.add('dragging')
      chatSidebar.classList.add('resizing')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    })

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return
      const newWidth = window.innerWidth - e.clientX
      const minWidth = 280
      const maxWidth = Math.min(800, window.innerWidth * 0.8)
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        chatSidebar.style.width = `${newWidth}px`
      }
    })

    document.addEventListener('mouseup', () => {
      if (!isDragging) return
      isDragging = false
      chatResizer.classList.remove('dragging')
      chatSidebar.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (chatSidebar.style.width) {
        localStorage.setItem('easypaper_chat_sidebar_width', parseInt(chatSidebar.style.width))
      }
    })
  }
}

// AI Chat Sidebar 리스너 초기화 실행
initChatListeners()

// ── 드래그 텍스트 AI 어시스턴트 연동 ────────────────────
function askAIAssistant(text) {
  if (!state.sessionId) {
    showToast('논문을 먼저 업로드하거나 선택해주세요.', 'error');
    return;
  }
  
  if (chatSidebar.classList.contains('hidden')) {
    toggleChatSidebar();
  }
  
  chatInput.value = `다음 본문 내용에 대해 설명해줘:\n\n"${text}"`;
  
  chatInput.style.height = 'auto';
  chatInput.style.height = `${chatInput.scrollHeight}px`;
  
  sendChatMessage();
}

if (viewerScrollContainer) {
  viewerScrollContainer.addEventListener('scroll', hideSelectionMenu);
}

window.addEventListener('resize', hideSelectionMenu);

document.addEventListener('mousedown', (e) => {
  if (selectionMenu && !selectionMenu.contains(e.target)) {
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        hideSelectionMenu();
      }
    }, 20);
  }
});

// KaTeX 로드 완료 후 페이지 내 pending 수식 전부 재처리
document.addEventListener('katex-ready', () => {
  // 번역 패널의 모든 .math-pending 요소 처리
  document.querySelectorAll('.trans-text, .message-bubble').forEach(el => {
    applyKatexToElement(el)
  })
})

// ── Google Drive 스타일 업로드 팝업 제어 ──────────────────
if (uploadPopupMinimize) {
  uploadPopupMinimize.addEventListener('click', () => {
    const isMinimized = uploadPopup.classList.toggle('minimized')
    uploadPopupMinimize.textContent = isMinimized ? '+' : '−'
  })
}

if (uploadPopupClose) {
  uploadPopupClose.addEventListener('click', () => {
    uploadPopup.classList.add('hidden')
  })
}

