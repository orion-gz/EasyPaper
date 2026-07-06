import './style.css'
import { marked } from 'marked'
import { uploadPDF, checkHealth, streamTranslation, getJobStatus, getPageTranslation, loginAPI, logoutAPI, checkAuthAPI, changeCredentialsAPI, getSystemSettingsAPI, saveSystemSettingsAPI, restartJobAPI, streamPullModelAPI, streamChatAPI, clearTranslationCacheAPI, getChatHistoryAPI, getAgyUsageAPI, cancelJobAPI } from './api.js'
import { loadPDF, renderScrollView, scrollToPage, reRenderAll, getScale, getTotalPages, getPDFOutline } from './pdfViewer.js'
import { fetchLibrary, fetchLibraryDoc, deleteLibraryDoc, fetchLibraryTranslation, fetchLibraryDocImages, updateLibraryDocMetadata, updateLibraryTranslation } from './library.js'


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
  currentLibraryTab: 'archive', // 'archive' (보관함) 또는 'history' (히스토리)
  currentDocId: null,
  currentDocMetadata: {},
  sessionId: null,
  filename: null,
  title: null,
  totalPages: 0,
  currentPage: 1,
  zoom: 1.5,
  syncScroll: true,
  translationCache: {},        // pageNum → 번역 텍스트
  translationSentences: {},    // pageNum → 문장 매핑 데이터
  translatingPages: new Set(), // 현재 번역 중인 페이지 (폴링 중복 방지용)
  translatedPages: new Set(),  // 번역 완료된 페이지
  pollingTimer: null,          // 잡 폴링 타이머
  username: 'admin',           // 현재 로그인한 사용자명 저장
  chatHistory: [],             // AI 채팅 히스토리
  chatActiveStream: null,      // 현재 활성화된 채팅 스트림 abort 함수
  chatCurrentText: '',         // 현재 스트리밍 답변 텍스트 임시 저장
  availableOllamaModels: [],   // Ollama에서 설치된 모델 목록
  quotedText: null,            // AI 질문 시 인용구 보관용
  documentImages: [],          // 문서 내 이미지 좌표 목록
  quotedImage: null,           // AI 질문 시 인용 이미지 보관용 (Base64)
  quotedImagePage: null,       // AI 질문 시 인용 이미지의 페이지 번호
  pendingFigureQuote: null,    // 클릭 후 AI 질문 전 대기중인 인용 이미지 정보
  activeHighlightColor: '#eab308', // 기본 하이라이트 노란색
  activeUnderlineColor: '#ef4444',  // 기본 밑줄 빨간색
  isCropMode: false,           // 영역 캡처 모드 여부
  pdfPageSentences: {},        // pageNum → sentenceRanges 보관용
  pdfPageElements: {},         // pageNum → elRanges 보관용
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
const libTabArchive     = $('lib-tab-archive')
const libTabHistory     = $('lib-tab-history')
const libraryStatsContainer = $('library-stats-container')

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
const docTitleEditBtn   = $('doc-title-edit-btn')
const pageInput         = $('page-input')
const pageTotal         = $('page-total')
const zoomInBtn         = $('zoom-in-btn')
const zoomOutBtn        = $('zoom-out-btn')
const zoomLabel         = $('zoom-level')
const syncScrollBtn     = $('sync-scroll-btn')
const exportBtn         = $('export-btn')
const retranslateBtn    = $('retranslate-btn')
const captureAreaBtn    = $('capture-area-btn')
const cancelTransBtn    = $('cancel-trans-btn')
const resumeTransBtn    = $('resume-trans-btn')
// (viewer/chat pickers are now ProviderModelPicker instances – see below)
const backBtn           = $('back-btn')
const logoBtn           = $('logo-btn')
const viewerReadToggleBtn = $('viewer-read-toggle-btn')
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
const outlineToggleBtn   = $('outline-toggle-btn')
const outlineSidebar     = $('outline-sidebar')
const outlineCloseBtn    = $('outline-close-btn')
const outlineContent     = $('outline-content')
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
    sessionId: null, filename: null, title: null, totalPages: 0, currentPage: 1,
    zoom: 1.5, translationCache: {}, translationSentences: {}, translatingPages: new Set(), translatedPages: new Set(), pollingTimer: null,
    chatHistory: [], chatActiveStream: null, quotedText: null, quotedImage: null, quotedImagePage: null, pendingFigureQuote: null,
    activeHighlightColor: '#eab308', activeUnderlineColor: '#ef4444', isCropMode: false, documentImages: []
  })
  if (typeof toggleCropMode === 'function') toggleCropMode(false)
  viewerScrollContainer.innerHTML = ''
  if (uploadPopup) uploadPopup.classList.add('hidden')
  progressMini.classList.add('hidden')
  
  if (chatSidebar) chatSidebar.classList.add('hidden')
  if (chatResizer) chatResizer.classList.add('hidden')
  if (chatToggleBtn) chatToggleBtn.classList.remove('active')
  hideOutlineSidebar()
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
  let lastTitle = ""

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
      lastTitle = (result.metadata && result.metadata.title) ? result.metadata.title : result.filename
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
      loadDocumentImages(lastSessionId)
      state.filename   = lastFilename
      state.totalPages = lastTotalPages
      state.title      = lastTitle
      history.pushState({ screen: 'viewer', docId: lastSessionId }, '', `#viewer?id=${lastSessionId}`)

      await loadPDF(`/api/pdf-file/${state.sessionId}`)
      docTitle.textContent = lastTitle
      docTitle.title = lastFilename
      pageTotal.textContent = `/ ${state.totalPages}`
      pageInput.max   = state.totalPages
      pageInput.value = 1

      showViewer()
      await initScrollViewer()
      hideOutlineSidebar()
      await loadPDFOutline()
    } else if (!isLibraryActive) {
      await showLibraryScreen()
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

  await renderScrollView(viewerScrollContainer, state.zoom, {
    onPageVisible: async (pageNum) => {
      updatePageDisplay(pageNum)
      
      // 페이지가 가시화되었을 때 번역 완료된 페이지인데 캐시가 없는 경우 레이지 로딩 적용
      if (state.translationCache[pageNum]) {
        if (state.translationCache[pageNum] !== '__fetching__') {
          renderTransContent(pageNum, state.translationCache[pageNum], true)
        }
      } else if (state.translatedPages.has(pageNum)) {
        state.translationCache[pageNum] = '__fetching__'
        const currentSessionId = state.sessionId
        try {
          const opts = getTranslationOptions()
          const res = await fetchLibraryTranslation(currentSessionId, pageNum, opts)
          state.translationCache[pageNum] = res.translation
          state.translationSentences[pageNum] = res.sentences || []
          // 패치하는 중에 사용자가 다른 세션으로 이동하지 않았는지 확인
          if (state.sessionId === currentSessionId) {
            renderTransContent(pageNum, res.translation, true)
          }
        } catch (err) {
          console.warn(`Failed to lazy load translation for page ${pageNum}:`, err)
          delete state.translationCache[pageNum]
        }
      }

      // 비동기 다음 페이지 번역 프리페칭 및 미리 렌더링
      const nextPage = pageNum + 1
      if (nextPage <= state.totalPages && !state.translationCache[nextPage] && state.translatedPages.has(nextPage)) {
        state.translationCache[nextPage] = '__fetching__'
        const currentSessionId = state.sessionId
        const opts = getTranslationOptions()
        fetchLibraryTranslation(currentSessionId, nextPage, opts).then(res => {
          if (state.sessionId === currentSessionId) {
            state.translationCache[nextPage] = res.translation
            state.translationSentences[nextPage] = res.sentences || []
            renderTransContent(nextPage, res.translation, true)
          }
        }).catch(err => {
          if (state.sessionId === currentSessionId) {
            delete state.translationCache[nextPage]
          }
        })
      }
    }
  })

  // 백그라운드 잡 폴링 시작
  startJobPolling(state.sessionId)
}

let isTransPaneCollapsed = false
let currentTransPaneWidth = 620
let hasLibraryStateInHistory = false

// ── 번역 블록 생성 ────────────────────────────────
function createTransBlock(pageNum) {
  const block = document.createElement('div')
  block.className = 'trans-page-block'
  block.id = `trans-block-${pageNum}`
  block.dataset.page = pageNum
  
  const leftChevron = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`
  const rightChevron = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`
  const chevron = isTransPaneCollapsed ? rightChevron : leftChevron
  const btnTitle = isTransPaneCollapsed ? '번역 창 펴기' : '번역 창 접기'
  
  block.innerHTML = `
    <div class="trans-page-label">
      <span>📄 ${pageNum}페이지</span>
      <span class="trans-page-status" id="trans-status-${pageNum}">대기 중</span>
    </div>
    <div class="trans-page-content" id="trans-content-${pageNum}">
      <div class="trans-page-placeholder">스크롤하면 자동으로 번역됩니다</div>
    </div>
    <div class="trans-resizer-handle"></div>
    <button class="trans-collapse-btn" title="${btnTitle}">${chevron}</button>`
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

// ── 코드 블록 외부의 볼드체를 <strong> 태그로 미리 변환 ──
function replaceBoldOutsideCode(text) {
  const blocks = text.split(/(```[\s\S]*?```)/g)
  const processedBlocks = blocks.map(block => {
    if (block.startsWith('```') && block.endsWith('```')) {
      return block
    }
    const subBlocks = block.split(/(`[^`\n]+?`)/g)
    const processedSubBlocks = subBlocks.map(subBlock => {
      if (subBlock.startsWith('`') && subBlock.endsWith('`')) {
        return subBlock
      }
      let res = subBlock
      res = res.replace(/\*\*((?:(?!\*\*)[\s\S])+?)\*\*/g, '<strong>$1</strong>')
      res = res.replace(/__((?:(?!__)[\s\S])+?)__/g, '<strong>$1</strong>')
      return res
    })
    return processedSubBlocks.join('')
  })
  return processedBlocks.join('')
}

// ── 번역 텍스트 포맷팅 (LaTeX & HTML 처리) ─────────
function formatTranslationHtml(text) {
  if (!text) return ''

  // 문장 정렬용 태그([S0], [S1] 등)가 번역창에 출력되지 않도록 제거
  let t = text.replace(/\[[sS]\d+\]/g, '')

  const mathBlocks = []

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

  // 4.5. 이스케이프된 볼드체 복원 및 공백 트리밍
  t = t.replace(/\\+\*\*/g, '**')
  t = t.replace(/\*\*\s*([^*]+?)\s*\*\*/g, '**$1**')
  t = replaceBoldOutsideCode(t)

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
        if (item.display) {
          return `<div class="katex-display-wrap" data-formula="${encodeURIComponent(item.formula)}" data-display="true">${r}</div>`
        } else {
          return `<span class="katex-inline-wrap" data-formula="${encodeURIComponent(item.formula)}" data-display="false">${r}</span>`
        }
      } catch (e) {
        return `<code class="math-error" data-formula="${encodeURIComponent(item.formula)}" data-display="${item.display}">${escapeHtml(item.formula)}</code>`
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
      const wrapper = display
        ? Object.assign(document.createElement('div'), { className: 'katex-display-wrap', innerHTML: r })
        : Object.assign(document.createElement('span'), { className: 'katex-inline-wrap', innerHTML: r })
      wrapper.dataset.formula = encodeURIComponent(formula)
      wrapper.dataset.display = display.toString()
      
      // 세그멘테이션 데이터 및 마킹 속성 보존
      if (code.classList.contains('trans-sentence')) {
        wrapper.classList.add('trans-sentence');
      }
      if (code.dataset.page) {
        wrapper.dataset.page = code.dataset.page;
      }
      if (code.dataset.sentenceIdx) {
        wrapper.dataset.sentenceIdx = code.dataset.sentenceIdx;
      }
      if (code.style.cursor) {
        wrapper.style.cursor = code.style.cursor;
      }

      code.replaceWith(wrapper)
    } catch (e) {
      code.classList.remove('math-pending')
    }
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
  
  // 문장 1대1 매칭을 위한 세그멘테이션 추가
  segmentElementIntoSentences(el, pageNum, 'trans-sentence')

  // PDF 텍스트 레이어가 이미 로드되어 있는 경우, 최신 문장 정렬 매핑을 바탕으로 재세그멘테이션 실행
  const textLayerDiv = document.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"] .textLayer`)
  if (textLayerDiv) {
    segmentElementIntoSentences(textLayerDiv, pageNum, 'pdf-sentence')
    
    // 주석(Annotation) 하이라이트 복원
    if (state.sessionId) {
      const annotations = loadAnnotations(state.sessionId)
      if (annotations[`page_${pageNum}`]) {
        reRenderPageAnnotations(textLayerDiv, pageNum)
      }
    }
  }
  
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
        state.translationSentences[pageNum] = data.sentences || []
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
exportBtn.addEventListener('click', async () => {
  // 캐시에 로드되지 않은 번역 완료 페이지가 있다면 다운로드 전 비동기로 로드
  const missingPages = Array.from(state.translatedPages).filter(pageNum => {
    return !state.translationCache[pageNum] || state.translationCache[pageNum] === '__fetching__'
  })
  
  if (missingPages.length > 0) {
    showToast('전체 번역 데이터를 가져오는 중입니다...', 'info')
    const opts = getTranslationOptions()
    await Promise.all(missingPages.map(async (pageNum) => {
      try {
        const res = await fetchLibraryTranslation(state.sessionId, pageNum, opts)
        state.translationCache[pageNum] = res.translation
        state.translationSentences[pageNum] = res.sentences || []
      } catch (err) {
        console.warn(`Failed to fetch translation for page ${pageNum} during export:`, err)
      }
    }))
  }

  const pages = Object.entries(state.translationCache)
    .filter(([_, text]) => text && text !== '__fetching__')
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
    state.translationSentences = {}
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

if (logoBtn) {
  logoBtn.addEventListener('click', () => {
    showLibraryScreen()
  })
}

// ── 뷰어 내 독서 완료 토글 버튼 바인딩 ──
if (viewerReadToggleBtn) {
  viewerReadToggleBtn.addEventListener('click', async () => {
    if (!state.currentDocId) return
    const currentReadState = state.currentDocMetadata.read === true
    const nextReadState = !currentReadState
    const payload = { read: nextReadState }
    if (nextReadState) {
      payload.read_at = new Date().toISOString()
    } else {
      payload.read_at = null
    }
    
    try {
      await updateLibraryDocMetadata(state.currentDocId, payload)
      state.currentDocMetadata.read = nextReadState
      state.currentDocMetadata.read_at = payload.read_at
      viewerReadToggleBtn.classList.toggle('active', nextReadState)
      showToast(nextReadState ? '읽은 논문으로 표시되었습니다.' : '보관함으로 이동되었습니다.', 'success')
      await loadLibraryCount()
    } catch (err) {
      showToast('상태 변경 실패: ' + err.message, 'error')
    }
  })
}

// ── 논문 제목 수정 (Viewer 화면) ──────────────────
if (docTitleEditBtn) {
  docTitleEditBtn.addEventListener('click', () => {
    const oldTitle = state.title || state.filename || ''
    const input = document.createElement('input')
    input.type = 'text'
    input.value = oldTitle
    input.style.background = 'var(--bg-elevated)'
    input.style.border = '1px solid var(--accent-mid)'
    input.style.borderRadius = 'var(--radius-sm)'
    input.style.color = 'var(--text-primary)'
    input.style.fontSize = '14px'
    input.style.fontWeight = '600'
    input.style.padding = '2px 6px'
    input.style.outline = 'none'
    input.style.minWidth = '200px'
    input.style.maxWidth = '400px'

    docTitle.innerHTML = ''
    docTitle.appendChild(input)
    docTitleEditBtn.style.display = 'none'
    input.focus()
    input.select()

    let isSaving = false
    async function save() {
      if (isSaving) return
      isSaving = true
      const newTitle = input.value.trim()
      if (newTitle && newTitle !== oldTitle) {
        try {
          await updateLibraryDocMetadata(state.sessionId, { title: newTitle })
          state.title = newTitle
          docTitle.textContent = newTitle
          showToast('제목이 변경되었습니다.', 'success')
        } catch (err) {
          showToast('제목 변경 실패: ' + err.message, 'error')
          docTitle.textContent = oldTitle
        }
      } else {
        docTitle.textContent = oldTitle
      }
      docTitleEditBtn.style.display = 'inline-flex'
    }

    input.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        await save()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        isSaving = true
        docTitle.textContent = oldTitle
        docTitleEditBtn.style.display = 'inline-flex'
      }
    })

    input.addEventListener('blur', async () => {
      setTimeout(async () => {
        if (!isSaving) {
          await save()
        }
      }, 100)
    })
  })
}

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
    if (location.hash && location.hash.startsWith('#viewer?id=')) {
      await handleRouting()
    } else {
      await showLibraryScreen()
    }
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
  },
  {
    id: 'ollama', label: 'Ollama (로컬)', icon: '🦙',
    models: [
      { value: 'gemma4:e4b', label: 'gemma4 e4b' },
      { value: 'qwen3.5:9b', label: 'qwen3.5 9b' },
      { value: 'llama3.1:8b', label: 'llamma 3.1' },
      { value: 'custom_input', label: '직접 입력' }
    ]
  },
  {
    id: 'openai', label: 'OpenAI', icon: '✦',
    models: [
      { value: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
      { value: 'o3', label: 'o3' },
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini' }
    ]
  },
  {
    id: 'claude', label: 'Anthropic Claude', icon: '🧠',
    models: [
      { value: 'claude-opus-4.8', label: 'Claude Opus 4.8' },
      { value: 'claude-opus-4.7', label: 'Claude Opus 4.7' },
      { value: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { value: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' }
    ]
  },
  {
    id: 'gemini', label: 'Google Gemini', icon: '💎',
    models: [
      { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' }
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
    
    // API Key가 입력되었는지 확인 (비어있지 않은지 여부)
    const hasOpenAIKey = !!settingOpenAIKey.value.trim()
    const hasGeminiKey = !!settingGeminiKey.value.trim()
    const hasClaudeKey = !!settingClaudeKey.value.trim()
    const downloaded = state.availableOllamaModels || []

    // Ollama 다운로드 모델 매칭을 유연하게 처리하기 위한 헬퍼 함수
    const isMatch = (installed, baseValue) => {
      if (installed === baseValue) return true
      if (baseValue === 'custom_input') return false
      const instClean = installed.split(':')[0].toLowerCase()
      const baseClean = baseValue.split(':')[0].toLowerCase()
      return instClean === baseClean
    }
    
    let config = PROVIDER_CONFIG.map(p => {
      if (p.id === 'ollama') {
        const baseModels = p.models
        if (this.compact) {
          // 뷰어 및 사이드바: 실제 다운로드된 모델만 띄움
          const activeModels = []
          const activeLabels = new Set()
          downloaded.forEach(m => {
            if (m === 'custom_input') return
            const base = baseModels.find(bm => isMatch(m, bm.value))
            const label = base ? base.label : m
            if (!activeLabels.has(label)) {
              activeLabels.add(label)
              activeModels.push({ value: m, label: label })
            }
          })
          return {
            ...p,
            models: activeModels
          }
        } else {
          // 설정창: 기본 제공 모델(설치 여부 표시) + 기타 다운로드된 모델 + 직접입력 옵션
          const modelsToShow = baseModels.map(bm => {
            if (bm.value === 'custom_input') {
              return bm
            }
            const isInstalled = downloaded.some(m => isMatch(m, bm.value))
            return {
              value: bm.value,
              label: `${bm.label} ${isInstalled ? '(설치됨)' : '(미설치 - 클릭 시 다운로드)'}`,
              installed: isInstalled
            }
          })
          downloaded.forEach(m => {
            if (!baseModels.some(bm => isMatch(m, bm.value))) {
              if (!modelsToShow.some(ts => isMatch(m, ts.value))) {
                modelsToShow.push({
                  value: m,
                  label: `${m} (설치됨)`,
                  installed: true
                })
              }
            }
          })
          return { ...p, models: modelsToShow }
        }
      }
      return p
    })

    if (this.compact) {
      // 뷰어에서는 API 키가 들어있는 공급업체만 띄우도록 필터링
      config = config.map(p => {
        if (p.id === 'openai' && !hasOpenAIKey) return { ...p, models: [] }
        if (p.id === 'gemini' && !hasGeminiKey) return { ...p, models: [] }
        if (p.id === 'claude' && !hasClaudeKey) return { ...p, models: [] }
        return p
      }).filter(p => p.models.length > 0)
    }

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
        header.innerHTML = `
          <span class="g-icon">${prov.icon}</span>
          <span>${prov.label}</span>
          <span class="agy-usage-badge" style="margin-left:auto;font-size:9px;background:rgba(139,92,246,0.2);color:#a78bfa;padding:2px 6px;border-radius:8px;font-weight:600;">로딩중...</span>
        `
        group.appendChild(header)
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

      const models = prov.models.length > 0 ? prov.models : [{ value: '', label: '모델 없음' }]
      models.forEach(m => {
        const item = document.createElement('div')
        item.className = 'picker-model-item' + (this._provider === prov.id && this._model === m.value ? ' selected' : '')
        item.style.position = 'relative'
        item.textContent = m.label
        if (m.value) {
          item.addEventListener('click', (e) => {
            e.stopPropagation()
            
            // 직접 모델명 입력 추가 옵션 처리
            if (m.value === 'custom_input') {
              this.container.classList.remove('open')
              
              // 1. 설정 모달 열기
              if (settingsModal) {
                settingsModal.classList.remove('hidden')
              }
              
              // 2. '모델 설정' 탭 활성화 처리
              const modelTabBtn = document.querySelector('.tab-btn[data-tab="tab-model"]')
              const modelTabPane = $('tab-model')
              if (modelTabBtn && modelTabPane) {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
                document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))
                modelTabBtn.classList.add('active')
                modelTabPane.classList.add('active')
              }

              // 3. Ollama 다운로드 섹션 보이기 및 스크롤
              if (pullModelSection) {
                pullModelSection.classList.remove('hidden')
                setTimeout(() => {
                  pullModelSection.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }, 100)
              }
              
              // 4. 입력 텍스트 상자 포커싱
              if (settingPullModelName) {
                settingPullModelName.focus()
                settingPullModelName.style.outline = '2px solid var(--accent-mid)'
                setTimeout(() => {
                  settingPullModelName.style.outline = 'none'
                }, 1500)
              }
              showToast('아래 "Ollama 모델명 직접 입력"란에 모델명을 적고 다운로드 버튼을 눌러주세요.', 'info')
              return
            }

            // Ollama 미설치 모델 다운로드 처리
            if (prov.id === 'ollama' && !this.compact) {
              const isInstalled = downloaded.some(dm => isMatch(dm, m.value))
              if (!isInstalled) {
                if (confirm(`'${m.label.split(' ')[0]}' (${m.value}) 모델이 설치되어 있지 않습니다. 다운로드하시겠습니까?\n(설정 창 하단에서 다운로드 진행 상태를 보실 수 있습니다)`)) {
                  this.container.classList.remove('open')
                  settingPullModelName.value = m.value
                  settingPullModelBtn.click()
                }
                return
              }
            }
            
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
    const provShort = prov ? (prov.label === 'Google Gemini' ? 'Gemini' : prov.label === 'Anthropic Claude' ? 'Claude' : prov.label.split(' ')[0]) : this._provider
    let modelLabel = this._model || '(선택 안 됨)'
    if (prov) {
      const found = prov.models.find(m => m.value === this._model)
      if (found) {
        modelLabel = found.label.replace(' (설치됨)', '').replace(' (미설치 - 클릭 시 다운로드)', '')
      }
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
      this._model = model
    } else if (prov && prov.models.length > 0) {
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
  onChange: () => updateSettingsUIVisibility()
})

const settingChatPicker = new ProviderModelPicker($('setting-chat-provider'), {
  compact: false,
  onChange: () => updateSettingsUIVisibility()
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

function updateSettingsUIVisibility() {
  const transVal = settingTransPicker ? settingTransPicker.getValue() : { provider: 'antigravity' }
  const chatVal = settingChatPicker ? settingChatPicker.getValue() : { provider: 'antigravity' }
  
  const providers = new Set([transVal.provider, chatVal.provider])
  
  // 1. Ollama 주소 (로컬 AI 사용 시) 표시 여부
  const hostGroup = $('setting-ollama-host-group')
  if (hostGroup) {
    hostGroup.style.display = providers.has('ollama') ? 'block' : 'none'
  }
  
  // 2. Ollama 모델 다운로드 섹션 표시 여부
  if (providers.has('ollama')) {
    pullModelSection.classList.remove('hidden')
  } else {
    pullModelSection.classList.add('hidden')
  }
  
  // 3. API Keys 섹션 표시 여부
  const keysSection = $('setting-apikeys-section')
  const openaiGroup = $('setting-openai-key-group')
  const geminiGroup = $('setting-gemini-key-group')
  const claudeGroup = $('setting-claude-key-group')
  
  let showSection = false
  
  if (openaiGroup) {
    if (providers.has('openai')) {
      openaiGroup.style.display = 'block'
      showSection = true
    } else {
      openaiGroup.style.display = 'none'
    }
  }
  
  if (geminiGroup) {
    if (providers.has('gemini')) {
      geminiGroup.style.display = 'block'
      showSection = true
    } else {
      geminiGroup.style.display = 'none'
    }
  }
  
  if (claudeGroup) {
    if (providers.has('claude')) {
      claudeGroup.style.display = 'block'
      showSection = true
    } else {
      claudeGroup.style.display = 'none'
    }
  }
  
  if (keysSection) {
    keysSection.style.display = showSection ? 'block' : 'none'
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
      promptTemplate.value = sys.translation_prompt_template || promptTemplate.value
    }
    
    updateSettingsUIVisibility()
    
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
    updateSettingsUIVisibility()
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
      state.translationSentences = {}
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
    const docs = data.documents || []
    const unreadCount = docs.filter(doc => doc.metadata?.read !== true).length
    if (unreadCount > 0 && libraryCountBadge) {
      libraryCountBadge.textContent = unreadCount
      libraryCountBadge.classList.remove('hidden')
    } else if (libraryCountBadge) {
      libraryCountBadge.classList.add('hidden')
    }
  } catch {}
}

// 탭 클릭 이벤트 리스너 등록
if (libTabArchive && libTabHistory) {
  libTabArchive.addEventListener('click', () => {
    if (state.currentLibraryTab === 'archive') return
    state.currentLibraryTab = 'archive'
    libTabArchive.classList.add('active')
    libTabHistory.classList.remove('active')
    activeCategoryFilter = 'ALL'
    renderLibrary()
  })
  libTabHistory.addEventListener('click', () => {
    if (state.currentLibraryTab === 'history') return
    state.currentLibraryTab = 'history'
    libTabHistory.classList.add('active')
    libTabArchive.classList.remove('active')
    activeCategoryFilter = 'ALL'
    renderLibrary()
  })
}

async function showLibraryScreen(shouldPushState = true) {
  hasLibraryStateInHistory = true
  if (shouldPushState) {
    history.pushState({ screen: 'library' }, '', '#library')
  }
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
    const allDocs = data.documents || []

    // 보관함 뱃지에는 안읽은 논문 개수 표시
    const unreadCount = allDocs.filter(doc => doc.metadata?.read !== true).length
    if (unreadCount > 0 && libraryCountBadge) {
      libraryCountBadge.textContent = unreadCount
      libraryCountBadge.classList.remove('hidden')
    } else if (libraryCountBadge) {
      libraryCountBadge.classList.add('hidden')
    }

    // 현재 선택된 탭에 따라 논문 목록 필터링
    const docs = allDocs.filter(doc => {
      const isRead = doc.metadata?.read === true
      return state.currentLibraryTab === 'history' ? isRead : !isRead
    })

    // 히스토리 탭인 경우 상단에 독서 현황 통계 요약 카드 렌더링
    if (state.currentLibraryTab === 'history') {
      const now = new Date()
      const thisYear = now.getFullYear()
      const thisMonth = now.getMonth()
      
      const readDocs = allDocs.filter(d => d.metadata?.read === true)
      const thisMonthCount = readDocs.filter(d => {
        if (!d.metadata?.read_at) return false
        const rDate = new Date(d.metadata.read_at)
        return rDate.getFullYear() === thisYear && rDate.getMonth() === thisMonth
      }).length
      
      libraryStatsContainer.innerHTML = `
        <div class="library-stats-widget">
          <div class="library-stats-item">
            <span class="library-stats-label">📅 이번 달 읽은 논문</span>
            <span class="library-stats-value">${thisMonthCount}<span>편</span></span>
          </div>
          <div style="width: 1px; height: 28px; background: var(--border-strong);"></div>
          <div class="library-stats-item">
            <span class="library-stats-label">🏆 누적 완독 논문</span>
            <span class="library-stats-value">${readDocs.length}<span>편</span></span>
          </div>
        </div>
      `
      libraryStatsContainer.classList.remove('hidden')
    } else {
      libraryStatsContainer.classList.add('hidden')
      libraryStatsContainer.innerHTML = ''
    }

    if (docs.length === 0) {
      libraryGrid.appendChild(createEmptyState(state.currentLibraryTab === 'history')); return
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
    libraryGrid.appendChild(createEmptyState(state.currentLibraryTab === 'history')); return
  }

  filteredDocs.forEach(doc => libraryGrid.appendChild(createDocCard(doc)))
}

function createEmptyState(isHistory = false) {
  const el = document.createElement('div')
  el.className = 'lib-empty'
  if (isHistory) {
    el.innerHTML = `<div style="font-size:48px;margin-bottom:16px">📖</div>
      <p>읽은 논문이 없습니다</p>
      <p style="font-size:13px;color:var(--text-muted);margin-top:8px">보관함에서 논문의 체크 아이콘을 눌러 읽음 처리해 보세요</p>`
  } else {
    el.innerHTML = `<div style="font-size:48px;margin-bottom:16px">📚</div>
      <p>보관함에 저장된 논문이 없습니다</p>
      <p style="font-size:13px;color:var(--text-muted);margin-top:8px">새 논문을 추가하거나 PDF를 업로드해 보세요</p>`
  }
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

  const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
  const isRead = doc.metadata?.read === true

  let dateHtml = `<span>📅 등록: ${date}</span>`
  if (isRead && doc.metadata?.read_at) {
    const readDateStr = new Date(doc.metadata.read_at).toLocaleDateString('ko-KR', { year:'numeric', month:'short', day:'numeric' })
    dateHtml = `<span>✅ 완독: ${readDateStr}</span>`
  }

  const checkBtnHtml = `
    <button class="doc-card-check-btn ${isRead ? 'checked' : ''}" data-id="${doc.id}" title="${isRead ? '읽지 않음으로 표시' : '읽음으로 표시'}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </button>
  `

  const card = document.createElement('div')
  card.className = 'doc-card'
  card.innerHTML = `
    ${checkBtnHtml}
    <div class="doc-card-icon">📄</div>
    <div class="doc-card-title" title="${escapeHtml(doc.filename)}">${escapeHtml(displayTitle)}</div>
    ${tagsHtml}
    <div class="doc-card-meta">
      ${dateHtml}<span>📑 ${total}페이지</span>
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
      <button class="doc-edit-btn" data-id="${doc.id}" title="제목 수정">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"></path></svg>
      </button>
      <button class="doc-delete-btn" data-id="${doc.id}" title="삭제">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>`

  card.querySelector('.doc-card-check-btn').addEventListener('click', async (e) => {
    e.stopPropagation()
    const currentReadState = doc.metadata?.read === true
    const nextReadState = !currentReadState
    const payload = { read: nextReadState }
    if (nextReadState) {
      payload.read_at = new Date().toISOString()
    } else {
      payload.read_at = null
    }
    
    try {
      await updateLibraryDocMetadata(doc.id, payload)
      showToast(nextReadState ? '읽은 논문으로 표시되었습니다.' : '보관함으로 이동되었습니다.', 'success')
      await renderLibrary()
      await loadLibraryCount()
    } catch (err) {
      showToast('상태 변경 실패: ' + err.message, 'error')
    }
  })

  card.querySelector('.doc-open-btn').addEventListener('click', (e) => { e.stopPropagation(); openFromLibrary(doc) })
  card.querySelector('.doc-delete-btn').addEventListener('click', async (e) => {
    e.stopPropagation()
    const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
    if (!confirm(`"${displayTitle}"을 삭제할까요?`)) return
    try { await deleteLibraryDoc(doc.id); showToast('삭제되었습니다', 'success'); await renderLibrary() }
    catch { showToast('삭제 실패', 'error') }
  })
  
  card.querySelector('.doc-edit-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    const titleEl = card.querySelector('.doc-card-title')
    const oldTitle = displayTitle
    
    const input = document.createElement('input')
    input.type = 'text'
    input.value = oldTitle
    input.style.width = '100%'
    input.style.padding = '4px 8px'
    input.style.background = 'var(--bg-elevated)'
    input.style.border = '1px solid var(--accent-mid)'
    input.style.borderRadius = 'var(--radius-sm)'
    input.style.color = 'var(--text-primary)'
    input.style.fontSize = '13px'
    input.style.fontWeight = '600'
    input.style.outline = 'none'
    
    titleEl.innerHTML = ''
    titleEl.appendChild(input)
    input.focus()
    input.select()
    
    let isSaving = false
    async function save() {
      if (isSaving) return
      isSaving = true
      const newTitle = input.value.trim()
      if (newTitle && newTitle !== oldTitle) {
        try {
          await updateLibraryDocMetadata(doc.id, { title: newTitle })
          showToast('제목이 변경되었습니다.', 'success')
          await renderLibrary()
        } catch (err) {
          showToast('제목 변경 실패: ' + err.message, 'error')
          titleEl.textContent = oldTitle
        }
      } else {
        titleEl.textContent = oldTitle
      }
    }
    
    input.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        await save()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        isSaving = true
        titleEl.textContent = oldTitle
      }
    })
    
    input.addEventListener('blur', async () => {
      setTimeout(async () => {
        if (!isSaving) {
          await save()
        }
      }, 100)
    })
  })
  card.addEventListener('click', () => openFromLibrary(doc))
  return card
}

async function loadDocumentImages(docId) {
  try {
    const imgRes = await fetchLibraryDocImages(docId)
    state.documentImages = imgRes.images || []
    
    // 이미 렌더링되어 있는 페이지들의 오버레이 레이어 갱신
    document.querySelectorAll('.textLayer').forEach(textLayerDiv => {
      const pageWrapper = textLayerDiv.closest('.pdf-page-wrapper')
      if (pageWrapper) {
        const pageNum = parseInt(pageWrapper.dataset.page)
        renderImageOverlayLayer(textLayerDiv, pageNum)
      }
    })
  } catch (e) {
    console.warn("이미지 좌표 로드 실패:", e)
    state.documentImages = []
  }
}

async function openFromLibrary(doc, shouldPushState = true) {
  if (shouldPushState) {
    history.pushState({ screen: 'viewer', docId: doc.id }, '', `#viewer?id=${doc.id}`)
  }
  state.sessionId  = doc.id
  loadDocumentImages(doc.id)
  state.filename   = doc.filename
  state.currentDocId = doc.id
  state.currentDocMetadata = doc.metadata || {}
  
  if (viewerReadToggleBtn) {
    const isRead = state.currentDocMetadata.read === true
    viewerReadToggleBtn.classList.toggle('active', isRead)
  }
  const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
  state.title      = displayTitle
  state.totalPages = doc.total_pages
  state.translationCache = {}
  state.translationSentences = {}
  state.translatingPages = new Set()
  // 번역이 완료된 페이지 번호만 기록하고 번역본 로드는 lazy-load에 위임
  state.translatedPages  = new Set(doc.translated_pages || [])

  // 채팅 내역 초기화 및 복원
  state.chatHistory = []
  chatMessages.innerHTML = '<div class="chat-message assistant"><div class="message-bubble">안녕하세요! 이 논문의 내용에 대해 궁금한 점을 질문하시면 해당 분야의 전문가로서 답변해 드립니다.<br><br><strong>💡 질문 예시:</strong><ul><li>이 논문의 핵심 연구 내용과 기여도를 요약해줘.</li><li>본문에서 제안하는 알고리즘/방법론의 상세 과정을 설명해줘.</li><li>실험 결과에서 제시된 주요 수치와 의의는 무엇이야?</li></ul></div></div>'
  
  try {
    const res = await getChatHistoryAPI(doc.id)
    const history = res.history || []
    if (history && history.length > 0) {
      for (const msg of history) {
        state.chatHistory.push({ role: msg.role, content: msg.content })
        const isAssistant = msg.role === 'assistant'
        const renderedContent = isAssistant ? formatChatHtml(msg.content) : formatUserChatHtml(msg.content)
        appendChatMessage(msg.role, renderedContent, true)
      }
    }
  } catch (err) {
    console.error('채팅 기록 로드 실패:', err)
  }

  await loadPDF(`/api/library/${doc.id}/pdf`)
  docTitle.textContent  = displayTitle
  docTitle.title        = doc.filename
  pageTotal.textContent = `/ ${doc.total_pages}`
  pageInput.max   = doc.total_pages
  pageInput.value = 1

  showViewer()
  await initScrollViewer()
  hideOutlineSidebar()
  await loadPDFOutline()
}

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
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

function hexToRgba(hex, alpha) {
  if (!hex) return '';
  let cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }
  const num = parseInt(cleanHex, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Range 객체를 받아와 화면에 어노테이션(하이라이트/밑줄)을 실제로 렌더링하고 로컬에 저장
function applyAnnotationToRange(range, type, textLayerDiv, pageNum, color) {
  const offsets = getPageTextOffset(range, textLayerDiv)
  if (offsets.startOffset === null || offsets.endOffset === null) return
  
  const text = range.toString()
  const chosenColor = color || (type === 'highlight' ? state.activeHighlightColor : state.activeUnderlineColor)

  // 1. DOM에 스타일 적용 (텍스트 노드 분할)
  applyAnnotationToRangeWithoutSave(range, type, chosenColor, offsets.startOffset, offsets.endOffset)

  // 2. LocalStorage에 저장
  const annotations = loadAnnotations(state.sessionId)
  if (!annotations[`page_${pageNum}`]) {
    annotations[`page_${pageNum}`] = []
  }
  annotations[`page_${pageNum}`].push({
    type,
    text,
    startOffset: offsets.startOffset,
    endOffset: offsets.endOffset,
    color: chosenColor
  })
  saveAnnotations(state.sessionId, annotations)
  showToast(type === 'highlight' ? '하이라이트가 추가되었습니다 ✓' : '밑줄이 추가되었습니다 ✓', 'success')
}

// 저장 없이 DOM 상에 직접 span을 감싸서 스타일 입히는 헬퍼
function applyAnnotationToRangeWithoutSave(range, type, color, overallStartOffset, overallEndOffset) {
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
    if (type === 'highlight') {
      span.className = 'pdf-annotation-highlight'
      const baseColor = color || '#eab308'
      span.style.backgroundColor = hexToRgba(baseColor, 0.4)
    } else {
      span.className = 'pdf-annotation-underline'
      const baseColor = color || '#ef4444'
      span.style.borderBottomColor = baseColor
    }
    
    // 호버 툴팁 매칭 및 간편 삭제 처리를 위해 데이터셋 부여
    if (overallStartOffset !== undefined && overallStartOffset !== null) {
      span.dataset.startOffset = overallStartOffset
    }
    if (overallEndOffset !== undefined && overallEndOffset !== null) {
      span.dataset.endOffset = overallEndOffset
    }
    
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
        applyAnnotationToRangeWithoutSave(range, ann.type, ann.color, ann.startOffset, ann.endOffset)
      } catch (e) {
        console.warn("Failed to restore annotation:", ann, e)
      }
    }
  })
}

// PDF와 번역본의 문장 수 차이를 고려한 오프셋 기반 매핑 함수
function getMappedElementsAndIndices(target, pageNum, sentenceIdx) {
  let pdfIdx = -1;
  let transIdx = -1;
  let pdfElements = [];

  const transSpans = Array.from(viewerScrollContainer.querySelectorAll(`.trans-sentence[data-page="${pageNum}"]`));
  const pdfSpans = Array.from(viewerScrollContainer.querySelectorAll(`.pdf-sentence[data-page="${pageNum}"]`));

  if (transSpans.length === 0 || pdfSpans.length === 0) {
    return { pdfIdx, transIdx, pdfElements };
  }

  // 양측의 고유한 문장 인덱스 집합
  const transIdxSet = new Set(transSpans.map(s => parseInt(s.dataset.sentenceIdx || '0', 10)));
  const pdfIdxSet = new Set(pdfSpans.map(s => parseInt(s.dataset.sentenceIdx || '0', 10)));
  const pdfCount = pdfIdxSet.size;
  const transCount = transIdxSet.size;
  const maxPdfIdx = Math.max(...pdfIdxSet);
  const maxTransIdx = Math.max(...transIdxSet);

  // 만약 사전에 백엔드에서 정렬 매핑한 문장이 존재하면 1:1 직접 매핑을 적용합니다.
  const sentences = state.translationSentences && state.translationSentences[pageNum];
  if (sentences && sentences.length > 0) {
    // LLM에 의해 병합된 빈 번역 문장을 감지하여 상위 그룹 인덱스로 매핑
    const parentIdxMap = [];
    let lastActiveIdx = 0;
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i].trans && sentences[i].trans.trim()) {
        lastActiveIdx = i;
      }
      parentIdxMap[i] = lastActiveIdx;
    }
    let firstActiveIdx = sentences.findIndex(s => s.trans && s.trans.trim());
    if (firstActiveIdx === -1) firstActiveIdx = 0;
    for (let i = 0; i < firstActiveIdx; i++) {
      parentIdxMap[i] = firstActiveIdx;
    }

    const parentIdx = parentIdxMap[sentenceIdx] ?? sentenceIdx;
    pdfIdx = parentIdx;
    transIdx = parentIdx;

    // 동일한 그룹에 속하는 모든 PDF 엘리먼트 수집
    pdfElements = pdfSpans.filter(el => {
      const idx = parseInt(el.dataset.sentenceIdx || '0', 10);
      return parentIdxMap[idx] === parentIdx;
    });
    return { pdfIdx, transIdx, pdfElements };
  } else {
    // 기존 오프셋/비례식 알고리즘 폴백 (기존 캐시 대응)
    const diff = pdfCount - transCount;
    const absDiff = Math.abs(diff);

    if (absDiff === 0) {
      // 1:1 직접 매핑
      pdfIdx = Math.min(maxPdfIdx, sentenceIdx);
      transIdx = Math.min(maxTransIdx, sentenceIdx);
    } else if (absDiff <= 5) {
      // 오프셋 기반 매핑 (PDF와 번역본 중 어느 쪽이 더 많은지를 구분)
      if (diff > 0) {
        // PDF가 더 많음: PDF 앞에 데더 먹을 문장이 diff개 있다고 가정
        const offset = diff;
        if (target.classList.contains('trans-sentence')) {
          transIdx = sentenceIdx;
          pdfIdx = Math.min(maxPdfIdx, sentenceIdx + offset);
        } else {
          pdfIdx = sentenceIdx;
          transIdx = Math.max(0, Math.min(maxTransIdx, sentenceIdx - offset));
        }
      } else {
        // 번역본이 더 많음: 번역 앞에 데더 먹을 문장이 offset개 있다고 가정
        const offset = -diff; // transCount - pdfCount
        if (target.classList.contains('trans-sentence')) {
          transIdx = sentenceIdx;
          pdfIdx = Math.max(0, Math.min(maxPdfIdx, sentenceIdx - offset));
        } else {
          pdfIdx = sentenceIdx;
          transIdx = Math.min(maxTransIdx, sentenceIdx + offset);
        }
      }
    } else {
      // 큰 차이 → 비례(proportional) 매핑
      if (pdfCount <= 1 || transCount <= 1) {
        pdfIdx = 0;
        transIdx = 0;
      } else {
        const fraction = sentenceIdx / Math.max(target.classList.contains('trans-sentence') ? (transCount - 1) : (pdfCount - 1), 1);
        if (target.classList.contains('trans-sentence')) {
          transIdx = sentenceIdx;
          pdfIdx = Math.min(maxPdfIdx, Math.round(fraction * (pdfCount - 1)));
        } else {
          pdfIdx = sentenceIdx;
          transIdx = Math.min(maxTransIdx, Math.round(fraction * (transCount - 1)));
        }
      }
    }
  }

  // pdfIdx에 매핑되는 모든 PDF span 엘리먼트 수집
  pdfElements = pdfSpans.filter(el => parseInt(el.dataset.sentenceIdx || '0', 10) === pdfIdx);

  return { pdfIdx, transIdx, pdfElements };
}

// 커스텀 다이얼로그 확인 모달 유틸리티
function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.createElement('div')
    modal.className = 'custom-confirm-modal-wrapper'
    modal.innerHTML = `
      <div class="custom-confirm-modal">
        <div class="custom-confirm-modal-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span class="custom-confirm-modal-title">메모 삭제</span>
        </div>
        <div class="custom-confirm-modal-body">
          ${message.replace(/\n/g, '<br>')}
        </div>
        <div class="custom-confirm-modal-footer">
          <button class="custom-confirm-btn cancel-btn">취소</button>
          <button class="custom-confirm-btn confirm-btn">삭제</button>
        </div>
      </div>
    `
    document.body.appendChild(modal)

    // Trigger transition
    setTimeout(() => modal.classList.add('active'), 10)

    const cleanup = (value) => {
      modal.classList.remove('active')
      setTimeout(() => {
        modal.remove()
        resolve(value)
      }, 200)
    }

    modal.querySelector('.cancel-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      cleanup(false)
    })

    modal.querySelector('.confirm-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      cleanup(true)
    })

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        cleanup(false)
      }
    })
  })
}

// ── Floating Markdown Memo 관리 ─────────────────────────
function loadMemos(sessionId) {
  if (!sessionId) return {}
  const key = `easypaper_memos_${sessionId}`
  try {
    return JSON.parse(localStorage.getItem(key)) || {}
  } catch (e) {
    return {}
  }
}

function saveMemos(sessionId, memos) {
  if (!sessionId) return
  const key = `easypaper_memos_${sessionId}`
  localStorage.setItem(key, JSON.stringify(memos))
}

function updateMemoConnectorLine(pageWrapper, memo, sentenceEl) {
  let svg = pageWrapper.querySelector('.memo-connector-svg')
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'memo-connector-svg')
    pageWrapper.appendChild(svg)
  }

  const isLight = document.body.classList.contains('light-theme')
  let strokeColor = 'var(--accent-mid)'
  const colorMode = memo.color || 'default'
  if (colorMode === 'yellow') strokeColor = isLight ? '#ca8a04' : '#eab308'
  else if (colorMode === 'green') strokeColor = isLight ? '#059669' : '#10b981'
  else if (colorMode === 'blue') strokeColor = isLight ? '#2563eb' : '#3b82f6'
  else if (colorMode === 'red') strokeColor = isLight ? '#e11d48' : '#f43f5e'

  let path = svg.getElementById(`connector_${memo.id}`)
  if (!path) {
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('id', `connector_${memo.id}`)
    path.setAttribute('stroke', strokeColor)
    path.setAttribute('stroke-width', '1.5')
    path.setAttribute('stroke-dasharray', '4,4')
    path.setAttribute('fill', 'none')
    path.setAttribute('opacity', '0.6')
    svg.appendChild(path)
  } else {
    path.setAttribute('stroke', strokeColor)
  }

  if (!sentenceEl) {
    path.setAttribute('d', '')
    return
  }

  const sentenceIdx = memo.sentenceIdx
  const pageNum = parseInt(pageWrapper.dataset.page, 10)
  const { pdfElements } = getMappedElementsAndIndices(sentenceEl, pageNum, sentenceIdx)
  const startEl = (pdfElements && pdfElements.length > 0) ? pdfElements[0] : sentenceEl

  let anchorX = startEl.offsetLeft
  let anchorY = startEl.offsetTop + startEl.offsetHeight / 2

  let curr = startEl.offsetParent
  while (curr && curr !== pageWrapper) {
    anchorX += curr.offsetLeft || 0
    anchorY += curr.offsetTop || 0
    curr = curr.offsetParent
  }

  const memoLeft = (memo.x / 100) * pageWrapper.offsetWidth
  const memoTop = (memo.y / 100) * pageWrapper.offsetHeight
  const memoWidth = 260
  const memoEl = pageWrapper.querySelector(`.floating-memo[data-id="${memo.id}"]`)
  const memoHeight = memoEl ? memoEl.offsetHeight : 160

  const memoCenterX = memoLeft + memoWidth / 2
  const memoCenterY = memoTop + memoHeight / 2

  let targetX = memoCenterX
  let targetY = memoCenterY

  if (anchorX < memoLeft) {
    targetX = memoLeft
  } else if (anchorX > memoLeft + memoWidth) {
    targetX = memoLeft + memoWidth
  }

  if (anchorY < memoTop) {
    targetY = memoTop
  } else if (anchorY > memoTop + memoHeight) {
    targetY = memoTop + memoHeight
  }

  const cpX1 = anchorX + (targetX - anchorX) * 0.5
  const cpY1 = anchorY
  const cpX2 = anchorX + (targetX - anchorX) * 0.5
  const cpY2 = targetY
  path.setAttribute('d', `M ${anchorX} ${anchorY} C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${targetX} ${targetY}`)
}

function renderPageMemos(pageNum) {
  const pageWrapper = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`)
  if (!pageWrapper) return

  pageWrapper.querySelectorAll('.floating-memo').forEach(el => el.remove())
  const svg = pageWrapper.querySelector('.memo-connector-svg')
  if (svg) svg.innerHTML = ''
  
  // Clear any existing sentence has-memo highlights
  pageWrapper.querySelectorAll('.pdf-sentence-has-memo').forEach(el => {
    el.classList.remove('pdf-sentence-has-memo')
  })

  if (!state.sessionId) return
  const allMemos = loadMemos(state.sessionId)
  const pageMemos = allMemos[`page_${pageNum}`] || []

  pageMemos.forEach(memo => {
    const memoEl = document.createElement('div')
    memoEl.className = `floating-memo color-${memo.color || 'default'}`
    memoEl.setAttribute('data-id', memo.id)
    memoEl.style.left = `${memo.x}%`
    memoEl.style.top = `${memo.y}%`

    const sentenceEl = pageWrapper.querySelector(`.pdf-sentence[data-sentence-idx="${memo.sentenceIdx}"]`)
    if (sentenceEl) {
      const { pdfElements } = getMappedElementsAndIndices(sentenceEl, pageNum, memo.sentenceIdx)
      if (pdfElements) {
        pdfElements.forEach(el => el.classList.add('pdf-sentence-has-memo'))
      }
    }

    let isEditing = !memo.content.trim()

    function updateCardContent() {
      const body = memoEl.querySelector('.floating-memo-body')
      const actions = memoEl.querySelector('.floating-memo-actions')

      if (isEditing) {
        body.innerHTML = `<textarea class="floating-memo-textarea" placeholder="메모를 입력하세요 (Markdown 및 LaTeX 지원)...">${memo.content}</textarea>`
        actions.innerHTML = `
          <button class="floating-memo-action-btn delete delete-btn" title="삭제">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </button>
        `

        const textarea = body.querySelector('.floating-memo-textarea')
        textarea.focus()
        
        textarea.addEventListener('input', () => {
          memo.content = textarea.value
          const allMemosObj = loadMemos(state.sessionId)
          allMemosObj[`page_${pageNum}`] = pageMemos
          saveMemos(state.sessionId, allMemosObj)
          updateMemoConnectorLine(pageWrapper, memo, sentenceEl)
        })

        textarea.addEventListener('blur', () => {
          setTimeout(() => {
            const exists = memoEl.parentNode !== null
            if (exists) {
              isEditing = false
              updateCardContent()
              updateMemoConnectorLine(pageWrapper, memo, sentenceEl)
            }
          }, 150)
        })

        actions.querySelector('.delete-btn').addEventListener('mousedown', async (e) => {
          e.stopPropagation()
          e.preventDefault()
          const confirmDelete = await showCustomConfirm('이 메모를 삭제하시겠습니까?')
          if (confirmDelete) {
            const allMemosObj = loadMemos(state.sessionId)
            allMemosObj[`page_${pageNum}`] = pageMemos.filter(m => m.id !== memo.id)
            saveMemos(state.sessionId, allMemosObj)
            renderPageMemos(pageNum)
          }
        })
      } else {
        let renderedHtml = memo.content
        if (marked && typeof marked.parse === 'function') {
          try {
            renderedHtml = marked.parse(memo.content)
          } catch (e) {
            console.error("Markdown parsing failed:", e)
          }
        }
        body.innerHTML = `<div class="floating-memo-render">${renderedHtml}</div>`
        
        if (window.renderMathInElement) {
          try {
            window.renderMathInElement(body, {
              delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
                { left: '\\[', right: '\\]', display: true }
              ],
              throwOnError: false
            })
          } catch (e) {
            console.warn("KaTeX rendering failed inside memo:", e)
          }
        }

        actions.innerHTML = `
          <button class="floating-memo-action-btn edit-btn" title="편집">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/><path d="m15 5 3 3"/></svg>
          </button>
          <button class="floating-memo-action-btn delete delete-btn" title="삭제">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </button>
        `

        actions.querySelector('.edit-btn').addEventListener('click', (e) => {
          e.stopPropagation()
          isEditing = true
          updateCardContent()
        })


        actions.querySelector('.delete-btn').addEventListener('click', async (e) => {
          e.stopPropagation()
          const confirmDelete = await showCustomConfirm('이 메모를 삭제하시겠습니까?')
          if (confirmDelete) {
            const allMemosObj = loadMemos(state.sessionId)
            allMemosObj[`page_${pageNum}`] = pageMemos.filter(m => m.id !== memo.id)
            saveMemos(state.sessionId, allMemosObj)
            renderPageMemos(pageNum)
          }
        })
      }
    }

    const sentenceText = (sentenceEl ? sentenceEl.textContent.trim() : '') || memo.sentenceText || ''
    const shortTitle = sentenceText
      ? (sentenceText.length > 20 ? sentenceText.substring(0, 20) + '...' : sentenceText)
      : 'Memo'

    memoEl.innerHTML = `
      <div class="floating-memo-header">
        <div class="floating-memo-title" title="${sentenceText}">
          <span>📝 ${shortTitle}</span>
        </div>
        <div class="floating-memo-color-picker">
          <span class="color-dot default ${!memo.color || memo.color === 'default' ? 'selected' : ''}" data-color="default" title="기본"></span>
          <span class="color-dot yellow ${memo.color === 'yellow' ? 'selected' : ''}" data-color="yellow" title="노랑"></span>
          <span class="color-dot green ${memo.color === 'green' ? 'selected' : ''}" data-color="green" title="초록"></span>
          <span class="color-dot blue ${memo.color === 'blue' ? 'selected' : ''}" data-color="blue" title="파랑"></span>
          <span class="color-dot red ${memo.color === 'red' ? 'selected' : ''}" data-color="red" title="빨강"></span>
        </div>
        <div class="floating-memo-actions"></div>
      </div>
      <div class="floating-memo-body"></div>
    `

    updateCardContent()

    const body = memoEl.querySelector('.floating-memo-body')
    body.addEventListener('click', (e) => {
      if (isEditing) return
      if (e.target.closest('a')) return
      e.stopPropagation()
      isEditing = true
      updateCardContent()
    })

    const colorDots = memoEl.querySelectorAll('.color-dot')
    colorDots.forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation()
        const selectedColor = dot.getAttribute('data-color')
        
        colorDots.forEach(d => d.classList.remove('selected'))
        dot.classList.add('selected')
        
        memoEl.className = `floating-memo color-${selectedColor}`
        
        memo.color = selectedColor
        const allMemosObj = loadMemos(state.sessionId)
        allMemosObj[`page_${pageNum}`] = pageMemos
        saveMemos(state.sessionId, allMemosObj)
        
        updateMemoConnectorLine(pageWrapper, memo, sentenceEl)
      })
    })

    pageWrapper.appendChild(memoEl)

    const header = memoEl.querySelector('.floating-memo-header')
    header.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation()
      const startMouseX = e.clientX
      const startMouseY = e.clientY
      const startX = memo.x
      const startY = memo.y

      const onMouseMove = (moveEvt) => {
        const dx = moveEvt.clientX - startMouseX
        const dy = moveEvt.clientY - startMouseY

        const dxPct = (dx / pageWrapper.offsetWidth) * 100
        const dyPct = (dy / pageWrapper.offsetHeight) * 100

        // Clamp to a wide bounds so it can float outside page wrapper boundaries anywhere on screen
        const newX = Math.min(Math.max(-150, startX + dxPct), 250)
        const newY = Math.min(Math.max(-150, startY + dyPct), 250)

        memo.x = newX
        memo.y = newY

        memoEl.style.left = `${newX}%`
        memoEl.style.top = `${newY}%`

        updateMemoConnectorLine(pageWrapper, memo, sentenceEl)
      }

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)

        const allMemosObj = loadMemos(state.sessionId)
        allMemosObj[`page_${pageNum}`] = pageMemos
        saveMemos(state.sessionId, allMemosObj)
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    })

    setTimeout(() => {
      updateMemoConnectorLine(pageWrapper, memo, sentenceEl)
    }, 50)
  })
}

function createFloatingMemoForSentence(pageNum, sentenceIdx) {
  if (!state.sessionId) return

  const pageWrapper = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`)
  if (!pageWrapper) return

  const sentenceEl = pageWrapper.querySelector(`.pdf-sentence[data-sentence-idx="${sentenceIdx}"]`)
  if (!sentenceEl) return

  const sentenceText = sentenceEl ? sentenceEl.textContent.trim() : ''

  let sentenceX = sentenceEl.offsetLeft
  let sentenceY = sentenceEl.offsetTop
  let curr = sentenceEl.offsetParent
  while (curr && curr !== pageWrapper) {
    sentenceX += curr.offsetLeft || 0
    sentenceY += curr.offsetTop || 0
    curr = curr.offsetParent
  }

  const leftPct = Math.min(Math.max(10, ((sentenceX + sentenceEl.offsetWidth / 2) / pageWrapper.offsetWidth) * 100), 70)
  const topPct = Math.min(Math.max(10, ((sentenceY + sentenceEl.offsetHeight) / pageWrapper.offsetHeight) * 100 + 4), 85)

  const allMemosObj = loadMemos(state.sessionId)
  if (!allMemosObj[`page_${pageNum}`]) {
    allMemosObj[`page_${pageNum}`] = []
  }

  const newMemo = {
    id: `memo_${Date.now()}`,
    pageNum: pageNum,
    sentenceIdx: sentenceIdx,
    sentenceText: sentenceText,
    content: '',
    x: leftPct,
    y: topPct
  }

  allMemosObj[`page_${pageNum}`].push(newMemo)
  saveMemos(state.sessionId, allMemosObj)

  renderPageMemos(pageNum)
}

// ── 팝업 툴팁 선택 메뉴 관리 ──
let selectionMenu = null
let sentenceHoverTimer = null
let selectionMenuHideTimer = null

function createSelectionMenu() {
  if (selectionMenu) return selectionMenu
  
  const menu = document.createElement('div')
  menu.id = 'selection-menu'
  menu.className = 'selection-menu'
  menu.innerHTML = `
    <div class="menu-annotate-group" style="display: flex; gap: 6px; align-items: center; padding: 2px 4px;">
      <!-- 하이라이트 그룹 -->
      <div class="expand-wrapper highlight-wrapper">
        <button class="menu-btn highlight-btn" title="하이라이트 (우클릭: 색상 변경)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <div class="expand-colors highlight-colors">
          <span class="color-dot" data-color="#eab308" style="background: #eab308;" title="노랑"></span>
          <span class="color-dot" data-color="#22c55e" style="background: #22c55e;" title="초록"></span>
          <span class="color-dot" data-color="#3b82f6" style="background: #3b82f6;" title="파랑"></span>
          <span class="color-dot" data-color="#ec4899" style="background: #ec4899;" title="핑크"></span>
        </div>
      </div>
      
      <!-- 밑줄 그룹 -->
      <div class="expand-wrapper underline-wrapper">
        <button class="menu-btn underline-btn" title="밑줄 (우클릭: 색상 변경)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
        </button>
        <div class="expand-colors underline-colors">
          <span class="color-dot" data-color="#ef4444" style="background: #ef4444;" title="빨강"></span>
          <span class="color-dot" data-color="#f97316" style="background: #f97316;" title="주황"></span>
          <span class="color-dot" data-color="#3b82f6" style="background: #3b82f6;" title="파랑"></span>
          <span class="color-dot" data-color="#a855f7" style="background: #a855f7;" title="보라"></span>
        </div>
      </div>
      
      <!-- 지우기 버튼 -->
      <button class="menu-btn clear-btn" title="지우기">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
      </button>
      
      <!-- 메모 추가 버튼 -->
      <button class="menu-btn memo-btn" title="메모 추가">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
      </button>
      
      <div class="menu-divider" style="width: 1px; background: var(--border-strong); height: 16px; margin: 0 2px;"></div>
    </div>
    <button class="menu-btn ask-ai-btn" title="AI 어시스턴트에게 질문" style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--accent-mid); padding: 0 8px;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
      <span>Ask AI</span>
    </button>
  `
  document.body.appendChild(menu)
  selectionMenu = menu

  menu.addEventListener('mouseenter', () => {
    if (selectionMenuHideTimer) {
      clearTimeout(selectionMenuHideTimer)
      selectionMenuHideTimer = null
    }
  })

  menu.addEventListener('mouseleave', () => {
    hideSelectionMenuWithDelay()
  })
  
  menu.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  
  const highlightBtn = menu.querySelector('.highlight-btn')
  const underlineBtn = menu.querySelector('.underline-btn')
  const highlightWrapper = menu.querySelector('.highlight-wrapper')
  const underlineWrapper = menu.querySelector('.underline-wrapper')

  function updateActiveColors() {
    highlightBtn.querySelector('svg').style.color = state.activeHighlightColor
    underlineBtn.querySelector('svg').style.color = state.activeUnderlineColor
    
    menu.querySelectorAll('.highlight-colors .color-dot').forEach(dot => {
      if (dot.dataset.color === state.activeHighlightColor) {
        dot.classList.add('selected')
      } else {
        dot.classList.remove('selected')
      }
    })
    menu.querySelectorAll('.underline-colors .color-dot').forEach(dot => {
      if (dot.dataset.color === state.activeUnderlineColor) {
        dot.classList.add('selected')
      } else {
        dot.classList.remove('selected')
      }
    })
  }

  // 컬러 서클 클릭 핸들러 바인딩 (클릭 시 마킹 즉시 적용 및 메뉴 닫기)
  menu.querySelectorAll('.highlight-colors .color-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      state.activeHighlightColor = dot.dataset.color
      updateActiveColors()
      handleAnnotate('highlight', state.activeHighlightColor)
    })
  })
  
  menu.querySelectorAll('.underline-colors .color-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      state.activeUnderlineColor = dot.dataset.color
      updateActiveColors()
      handleAnnotate('underline', state.activeUnderlineColor)
    })
  })

  // 메인 아이콘 좌클릭: 활성화된 기존 색상으로 즉시 마킹 처리 적용
  highlightBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    handleAnnotate('highlight', state.activeHighlightColor)
  })

  // 메인 아이콘 우클릭: 색상 선택기 확장 토글
  highlightBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    underlineWrapper.classList.remove('expanded')
    highlightWrapper.classList.toggle('expanded')
  })

  // 메인 밑줄 좌클릭: 활성화된 기존 색상으로 즉시 마킹 처리 적용
  underlineBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    handleAnnotate('underline', state.activeUnderlineColor)
  })

  // 메인 밑줄 우클릭: 색상 선택기 확장 토글
  underlineBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    highlightWrapper.classList.remove('expanded')
    underlineWrapper.classList.toggle('expanded')
  })

  menu.querySelector('.clear-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    handleAnnotate('clear')
  })

  menu.querySelector('.memo-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    let sentenceEl = null
    let pageWrapper = null

    if (state.hoverSelectedPdfElements && state.hoverSelectedPdfElements.length > 0) {
      sentenceEl = state.hoverSelectedPdfElements[0]
      pageWrapper = sentenceEl.closest('.pdf-page-wrapper')
    } else {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        let startContainer = range.startContainer
        if (startContainer) {
          const parent = startContainer.nodeType === 3 ? startContainer.parentElement : startContainer
          sentenceEl = parent.closest('.pdf-sentence')
          pageWrapper = parent.closest('.pdf-page-wrapper')
        }
      }
    }

    if (sentenceEl && pageWrapper) {
      const pageNum = parseInt(pageWrapper.dataset.page, 10)
      const sentenceIdx = parseInt(sentenceEl.dataset.sentenceIdx, 10)
      createFloatingMemoForSentence(pageNum, sentenceIdx)
    }
    hideSelectionMenu()
  })

  menu.querySelector('.ask-ai-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (state.pendingFigureQuote) {
      askAIAssistantImage(state.pendingFigureQuote.base64Img, state.pendingFigureQuote.pageNum)
    } else {
      const selection = window.getSelection()
      const text = selection.toString().trim()
      if (text) {
        askAIAssistant(text)
      }
      selection.removeAllRanges()
    }
    hideSelectionMenu()
  })

  updateActiveColors()
  return menu
}

// ── 어노테이션(하이라이트/밑줄) 마우스 호버 툴팁 관리 ──
let annHoverTooltip = null
let annHoverHideTimer = null
let activeHoveredSpan = null

function createAnnHoverTooltip() {
  if (annHoverTooltip) return annHoverTooltip

  const tooltip = document.createElement('div')
  tooltip.id = 'ann-hover-tooltip'
  tooltip.className = 'selection-menu hidden'
  tooltip.style.cssText = 'position: absolute; z-index: 10005;'
  tooltip.innerHTML = `
    <button class="menu-btn delete-ann-btn" title="삭제">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
    </button>
    <div class="menu-divider" style="width: 1px; background: var(--border-strong); height: 16px; margin: 0 2px;"></div>
    <button class="menu-btn memo-ann-btn" title="메모 추가">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
    </button>
    <div class="menu-divider" style="width: 1px; background: var(--border-strong); height: 16px; margin: 0 2px;"></div>
    <button class="menu-btn ask-ai-btn ask-ai-ann-btn" title="AI 어시스턴트에게 질문">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
      <span>Ask AI</span>
    </button>
  `
  document.body.appendChild(tooltip)
  annHoverTooltip = tooltip

  tooltip.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })

  tooltip.addEventListener('mouseenter', () => {
    if (annHoverHideTimer) {
      clearTimeout(annHoverHideTimer)
      annHoverHideTimer = null
    }
  })

  tooltip.addEventListener('mouseleave', () => {
    hideAnnHoverTooltipWithDelay()
  })

  tooltip.querySelector('.delete-ann-btn').addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!activeHoveredSpan) return

    const sentenceEl = activeHoveredSpan.closest('.pdf-sentence')
    if (!sentenceEl) return
    const sentenceIdx = parseInt(sentenceEl.dataset.sentenceIdx, 10)
    const pageWrapper = activeHoveredSpan.closest('.pdf-page-wrapper')
    if (!pageWrapper) return
    const pageNum = parseInt(pageWrapper.dataset.page, 10)
    const textLayerDiv = pageWrapper.querySelector('.textLayer')

    // 문장에 속하는 모든 PDF 엘리먼트 가져오기
    const { pdfElements } = getMappedElementsAndIndices(sentenceEl, pageNum, sentenceIdx)

    if (pdfElements && pdfElements.length > 0) {
      const firstEl = pdfElements[0]
      const lastEl = pdfElements[pdfElements.length - 1]

      const firstWalker = document.createTreeWalker(firstEl, NodeFilter.SHOW_TEXT)
      const firstNodes = []
      while (firstWalker.nextNode()) firstNodes.push(firstWalker.currentNode)

      const lastWalker = document.createTreeWalker(lastEl, NodeFilter.SHOW_TEXT)
      const lastNodes = []
      while (lastWalker.nextNode()) lastNodes.push(lastWalker.currentNode)

      if (firstNodes.length > 0 && lastNodes.length > 0) {
        const r = document.createRange()
        r.setStart(firstNodes[0], 0)
        r.setEnd(lastNodes[lastNodes.length - 1], lastNodes[lastNodes.length - 1].length)

        const sentenceOffsets = getPageTextOffset(r, textLayerDiv)
        if (sentenceOffsets.startOffset !== null && sentenceOffsets.endOffset !== null) {
          const annotations = loadAnnotations(state.sessionId)
          if (annotations[`page_${pageNum}`]) {
            const originalCount = annotations[`page_${pageNum}`].length
            annotations[`page_${pageNum}`] = annotations[`page_${pageNum}`].filter(ann => {
              // 문장 오프셋 내에 시작점 또는 끝점이 겹치는 하이라이트/밑줄들을 모두 삭제 대상으로 식별
              const isOverlapping = (ann.startOffset >= sentenceOffsets.startOffset && ann.startOffset <= sentenceOffsets.endOffset) ||
                                    (ann.endOffset >= sentenceOffsets.startOffset && ann.endOffset <= sentenceOffsets.endOffset);
              return !isOverlapping;
            })

            if (annotations[`page_${pageNum}`].length !== originalCount) {
              saveAnnotations(state.sessionId, annotations)
              showToast('문장 어노테이션이 일괄 삭제되었습니다 ✓', 'success')
              reRenderPageAnnotations(textLayerDiv, pageNum)
            }
          }
        }
      }
    }
    hideAnnHoverTooltip()
  })

  tooltip.querySelector('.memo-ann-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!activeHoveredSpan) return
    const sentenceEl = activeHoveredSpan.closest('.pdf-sentence')
    const pageWrapper = activeHoveredSpan.closest('.pdf-page-wrapper')
    if (sentenceEl && pageWrapper) {
      const pageNum = parseInt(pageWrapper.dataset.page, 10)
      const sentenceIdx = parseInt(sentenceEl.dataset.sentenceIdx, 10)
      createFloatingMemoForSentence(pageNum, sentenceIdx)
    }
    hideAnnHoverTooltip()
  })

  tooltip.querySelector('.ask-ai-ann-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!activeHoveredSpan) return
    const text = activeHoveredSpan.textContent.trim()
    if (text) {
      askAIAssistant(text)
    }
    hideAnnHoverTooltip()
  })

  return tooltip
}

function showAnnotationHoverTooltip(annSpan) {
  if (annHoverHideTimer) {
    clearTimeout(annHoverHideTimer)
    annHoverHideTimer = null
  }

  activeHoveredSpan = annSpan
  const tooltip = createAnnHoverTooltip()
  tooltip.classList.remove('hidden')

  const rect = annSpan.getBoundingClientRect()
  const tooltipWidth = tooltip.offsetWidth || 110
  const tooltipHeight = tooltip.offsetHeight || 32

  const left = rect.left + rect.width / 2 - tooltipWidth / 2 + window.scrollX
  const top = rect.top - tooltipHeight - 6 + window.scrollY

  tooltip.style.left = `${Math.max(8, left)}px`
  tooltip.style.top = `${Math.max(8, top)}px`
}

function hideAnnHoverTooltip() {
  if (annHoverTooltip) {
    annHoverTooltip.classList.add('hidden')
  }
  activeHoveredSpan = null
}

function hideAnnHoverTooltipWithDelay() {
  if (annHoverHideTimer) clearTimeout(annHoverHideTimer)
  annHoverHideTimer = setTimeout(() => {
    hideAnnHoverTooltip()
  }, 250)
}

function handleAnnotate(type, color) {
  // 1. 호버 지연 대기에 의한 문장 전체 선택 모드 대응
  if (state.hoverSelectedPdfElements && state.hoverSelectedPdfElements.length > 0) {
    const pageNum = state.hoverSelectedPageNum;
    const textLayerDiv = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"] .textLayer`);
    if (textLayerDiv) {
      state.hoverSelectedPdfElements.forEach(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
          nodes.push(walker.currentNode);
        }
        if (nodes.length > 0) {
          const r = document.createRange();
          r.setStart(nodes[0], 0);
          r.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].length);
          
          if (type === 'clear') {
            clearAnnotationsInRange(r, textLayerDiv, pageNum);
          } else {
            applyAnnotationToRange(r, type, textLayerDiv, pageNum, color);
          }
        }
      });
      window.getSelection().removeAllRanges();
      hideSelectionMenu();
      state.hoverSelectedPdfElements = null;
      return;
    }
  }

  // 2. 일반 마우스 드래그 선택 대응
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
    applyAnnotationToRange(range, type, textLayerDiv, pageNum, color)
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

  // Restore floating memos for the page
  renderPageMemos(pageNum)
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
    selectionMenu.querySelectorAll('.expand-wrapper').forEach(w => w.classList.remove('expanded'))
  }
  state.pendingFigureQuote = null
  state.hoverSelectionDisabled = true
  if (sentenceHoverTimer) {
    clearTimeout(sentenceHoverTimer)
    sentenceHoverTimer = null
  }
  if (selectionMenuHideTimer) {
    clearTimeout(selectionMenuHideTimer)
    selectionMenuHideTimer = null
  }
}

function hideSelectionMenuWithDelay() {
  if (selectionMenuHideTimer) clearTimeout(selectionMenuHideTimer)
  selectionMenuHideTimer = setTimeout(() => {
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
    }
    hideSelectionMenu()
    state.hoverSelectedPdfElements = null
    state.hoverSelectedPageNum = null
    state.hoverSelectedSentenceIdx = null
  }, 250)
}

// 통합 텍스트 선택 종료 감지 리스너
document.addEventListener('mouseup', (e) => {
  setTimeout(() => {
    try {
      if (state.isCropMode) return
      if (e.target.closest('.pdf-figure-overlay') || (selectionMenu && selectionMenu.contains(e.target))) {
        return
      }
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        state.hoverSelectedPdfElements = null
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
  // 문장 1대1 매칭을 위한 세그멘테이션 추가
  segmentElementIntoSentences(textLayerDiv, pageNum, 'pdf-sentence')

  const transBlock = $(`trans-content-${pageNum}`)
  if (transBlock) {
    const transTextEl = transBlock.querySelector('.trans-text')
    if (transTextEl && !transTextEl.dataset.segmented) {
      segmentElementIntoSentences(transTextEl, pageNum, 'trans-sentence')
    }
  }

  if (!state.sessionId) return
  const annotations = loadAnnotations(state.sessionId)
  if (annotations[`page_${pageNum}`]) {
    applyAnnotationsFromOffsets(textLayerDiv, annotations[`page_${pageNum}`])
  }

  renderImageOverlayLayer(textLayerDiv, pageNum)

  // Render floating memos
  renderPageMemos(pageNum)
}

function cropFigureFromCanvas(canvas, imgPercent) {
  const tempCanvas = document.createElement('canvas')
  const ctx = tempCanvas.getContext('2d')
  
  // Calculate raw pixels coordinates from percentages
  const leftPx = (imgPercent.left / 100) * canvas.width
  const topPx = (imgPercent.top / 100) * canvas.height
  const widthPx = (imgPercent.width / 100) * canvas.width
  const heightPx = (imgPercent.height / 100) * canvas.height
  
  tempCanvas.width = widthPx
  tempCanvas.height = heightPx
  
  ctx.drawImage(
    canvas,
    leftPx, topPx, widthPx, heightPx,
    0, 0, widthPx, heightPx
  )
  
  return tempCanvas.toDataURL('image/png')
}

function renderImageOverlayLayer(textLayerDiv, pageNum) {
  const pageImages = (state.documentImages || []).filter(img => img.page === pageNum)
  const inner = textLayerDiv.parentElement
  if (!inner) return
  
  // Remove existing layer if any
  const oldLayer = inner.querySelector('.pdf-image-overlay-layer')
  if (oldLayer) oldLayer.remove()
  
  if (pageImages.length === 0) return
  
  const layer = document.createElement('div')
  layer.className = 'pdf-image-overlay-layer'
  layer.style.position = 'absolute'
  layer.style.top = '0'
  layer.style.left = '0'
  layer.style.width = '100%'
  layer.style.height = '100%'
  layer.style.pointerEvents = 'none'
  layer.style.zIndex = '3'
  
  pageImages.forEach((imgPercent, idx) => {
    const overlay = document.createElement('div')
    overlay.className = 'pdf-figure-overlay'
    overlay.dataset.page = pageNum
    overlay.dataset.index = idx
    overlay.style.position = 'absolute'
    overlay.style.left = `${imgPercent.left}%`
    overlay.style.top = `${imgPercent.top}%`
    overlay.style.width = `${imgPercent.width}%`
    overlay.style.height = `${imgPercent.height}%`
    overlay.style.pointerEvents = 'auto'
    overlay.style.cursor = 'pointer'
    
    overlay.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      
      // Clear text selection
      window.getSelection().removeAllRanges()
      
      const canvas = inner.querySelector('canvas')
      if (!canvas) return
      
      try {
        const base64Img = cropFigureFromCanvas(canvas, imgPercent)
        state.pendingFigureQuote = {
          pageNum: pageNum,
          imgPercent: imgPercent,
          base64Img: base64Img
        }
        
        // Show selection menu
        const rect = overlay.getBoundingClientRect()
        showSelectionMenu(rect, false) // false = hide annotation options
      } catch (err) {
        console.error("그림 크롭 실패:", err)
      }
    })
    
    layer.appendChild(overlay)
  })
  
  inner.appendChild(layer)
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

  // 0. 문장 정렬용 태그([S0], [S1] 등) 제거
  let t = text.replace(/\[[sS]\d+\]/g, '')

  const mathBlocks = []

  // 1. 블록 수식: $$...$$
  t = t.replace(/\$\$([\s\S]*?)\$\$/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: true })
    return `MATHBLOCK${id}`
  })
  // 2. 블록 수식: \[...\]
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: true })
    return `MATHBLOCK${id}`
  })
  // 3. 인라인: $...$
  t = t.replace(/(?<!\$)\$([^\$\n]+?)\$(?!\$)/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: false })
    return `MATHBLOCK${id}`
  })
  // 4. 인라인: \(...\)
  t = t.replace(/\\\(([\s\S]*?)\\\)/g, (_, f) => {
    const id = mathBlocks.length; mathBlocks.push({ formula: f.trim(), display: false })
    return `MATHBLOCK${id}`
  })

  // 4.3. 이스케이프된 볼드체 기호(\**, \__) 복원
  t = t.replace(/\\+\*\*/g, '**')
  t = t.replace(/\\+__/g, '__')

  // 4.5. 볼드체 기호(**, __) 내부의 불필요한 앞뒤 공백 제거
  t = t.replace(/\*\*\s*([\s\S]*?)\s*\*\*/g, '**$1**')
  t = t.replace(/__\s*([\s\S]*?)\s*__/g, '__$1__')

  // 4.7. 코드 블록 외부의 볼드체를 <strong> 태그로 미리 변환 (문장 부호 경계 파싱 버그 극복)
  t = replaceBoldOutsideCode(t)

  // 5. 마크다운 렌더링 (marked 사용)
  let html = ''
  if (marked && typeof marked.parse === 'function') {
    html = marked.parse(t)
  } else {
    html = t.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>')
  }

  // 6. 수식 플레이스홀더 복원
  html = html.replace(/MATHBLOCK(\d+)/g, (_, idStr) => {
    const item = mathBlocks[parseInt(idStr)]
    if (!item) return _
    if (window.katex) {
      try {
        const r = window.katex.renderToString(item.formula, { displayMode: item.display, throwOnError: false, output: 'html' })
        if (item.display) {
          return `<div class="katex-display-wrap" data-formula="${encodeURIComponent(item.formula)}" data-display="true">${r}</div>`
        } else {
          return `<span class="katex-inline-wrap" data-formula="${encodeURIComponent(item.formula)}" data-display="false">${r}</span>`
        }
      } catch (e) {
        return `<code class="math-error" data-formula="${encodeURIComponent(item.formula)}" data-display="${item.display}">${escapeHtml(item.formula)}</code>`
      }
    }
    const delim = item.display ? '$$' : '$'
    return `<code class="math-pending" data-formula="${encodeURIComponent(item.formula)}" data-display="${item.display}">${escapeHtml(delim + item.formula + delim)}</code>`
  })

  return html
}

function formatUserChatHtml(content) {
  if (!content) return ''
  
  if (content.startsWith('[인용된 본문 내용]:')) {
    const marker = '\n\n[질문]:\n'
    const markerIdx = content.indexOf(marker)
    if (markerIdx !== -1) {
      const firstQuote = content.indexOf('"', 12)
      const lastQuote = content.lastIndexOf('"', markerIdx)
      let quoteText = ''
      if (firstQuote !== -1 && lastQuote !== -1 && lastQuote > firstQuote) {
        quoteText = content.substring(firstQuote + 1, lastQuote)
      } else {
        quoteText = content.substring(21, markerIdx)
      }
      const questionText = content.substring(markerIdx + marker.length)
      return `<div class="message-quote"><span class="quote-symbol">❝</span><span class="quote-body">${escapeHtml(quoteText)}</span></div><div class="message-text">${escapeHtml(questionText)}</div>`
    }
  }
  
  if (content.startsWith('[인용된 이미지')) {
    const marker = ']\n\n질문:\n'
    const markerIdx = content.indexOf(marker)
    if (markerIdx !== -1) {
      const pageInfo = content.substring(1, markerIdx)
      const questionText = content.substring(markerIdx + marker.length)
      return `<div class="message-quote"><span class="quote-symbol">❝</span><span class="quote-body" style="font-size: 11px; opacity: 0.85;">📷 ${escapeHtml(pageInfo)}</span></div><div class="message-text">${escapeHtml(questionText)}</div>`
    }
  }
  
  return escapeHtml(content)
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
        if (!token.trim()) return;
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
        replyBubble.innerHTML = formatChatHtml(accumulatedText);
        applyKatexToElement(replyBubble);
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
  bubbleEl.innerHTML = `<div class="typing-container" style="display: flex; align-items: center; gap: 8px;"><span class="typing-text" style="font-size: 12px; color: var(--text-secondary);">AI가 답변을 준비하고 있습니다</span><div class="typing-indicator" style="display: flex; gap: 3px; align-items: center;"><span></span><span></span><span></span></div></div>`
  
  msgEl.appendChild(bubbleEl)
  chatMessages.appendChild(msgEl)
  chatMessages.scrollTop = chatMessages.scrollHeight

  const loadingProgress = $('chat-loading-progress')
  if (loadingProgress) {
    loadingProgress.classList.add('active')
  }

  return msgEl
}

function removeTypingIndicator() {
  const indicators = chatMessages.querySelectorAll('.temp-typing')
  indicators.forEach(el => el.remove())
  
  const loadingProgress = $('chat-loading-progress')
  if (loadingProgress) {
    loadingProgress.classList.remove('active')
  }
}

async function sendChatMessage() {
  if (!state.sessionId) return
  if (state.chatActiveStream) return
  
  const text = chatInput.value.trim()
  if (!text) return
  
  chatInput.value = ''
  chatInput.style.height = 'auto'
  
  if (state.quotedText) {
    const fullPayload = `[인용된 본문 내용]:\n"${state.quotedText}"\n\n[질문]:\n${text}`
    
    // UI에 답장/인용구 레이아웃으로 표시
    const userMsgHtml = `<div class="message-quote"><span class="quote-symbol">❝</span><span class="quote-body">${escapeHtml(state.quotedText)}</span></div><div class="message-text">${escapeHtml(text)}</div>`
    appendChatMessage('user', userMsgHtml, true)
    state.chatHistory.push({ role: 'user', content: fullPayload })
    
    // 인용 상태 초기화
    state.quotedText = null
    const quoteArea = $('chat-quote-area')
    if (quoteArea) quoteArea.classList.add('hidden')
  } else if (state.quotedImage) {
    const fullPayload = `[인용된 이미지 (Page ${state.quotedImagePage})]\n\n질문:\n${text}`
    
    // UI에 답장/인용구 레이아웃으로 표시
    const userMsgHtml = `<div class="message-quote"><span class="quote-symbol">❝</span><img class="message-quote-img" src="${state.quotedImage}" alt="Quoted Figure" /></div><div class="message-text">${escapeHtml(text)}</div>`
    appendChatMessage('user', userMsgHtml, true)
    state.chatHistory.push({ role: 'user', content: fullPayload })
    
    // 인용 상태 초기화
    state.quotedImage = null
    state.quotedImagePage = null
    const quoteArea = $('chat-quote-area')
    if (quoteArea) quoteArea.classList.add('hidden')
    const quoteImgEl = $('chat-quote-img')
    if (quoteImgEl) quoteImgEl.classList.add('hidden')
    const quoteTextEl = $('chat-quote-text')
    if (quoteTextEl) quoteTextEl.classList.remove('hidden')
  } else {
    appendChatMessage('user', text)
    state.chatHistory.push({ role: 'user', content: text })
  }
  
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
        if (!token.trim()) return
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
      
      if (replyBubble) {
        replyBubble.innerHTML = formatChatHtml(accumulatedText)
        if (replyBubble.parentElement) {
          appendActionButtons(replyBubble.parentElement, 'assistant', accumulatedText)
        }
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

  // 인용구 닫기(인용 취소) 버튼 리스너
  const quoteCloseBtn = $('chat-quote-close-btn')
  if (quoteCloseBtn) {
    quoteCloseBtn.addEventListener('click', () => {
      state.quotedText = null
      state.quotedImage = null
      state.quotedImagePage = null
      const quoteArea = $('chat-quote-area')
      if (quoteArea) quoteArea.classList.add('hidden')
      const quoteImgEl = $('chat-quote-img')
      if (quoteImgEl) quoteImgEl.classList.add('hidden')
      const quoteTextEl = $('chat-quote-text')
      if (quoteTextEl) quoteTextEl.classList.remove('hidden')
    })
  }
}

// AI Chat Sidebar 리스너 초기화 실행
initChatListeners()

function askAIAssistant(text) {
  if (!state.sessionId) {
    showToast('논문을 먼저 업로드하거나 선택해주세요.', 'error');
    return;
  }
  
  // 인용구 보관 및 영역 업데이트
  state.quotedText = text;
  state.quotedImage = null;
  state.quotedImagePage = null;
  
  const quoteTextEl = $('chat-quote-text');
  const quoteImgEl = $('chat-quote-img');
  const quoteArea = $('chat-quote-area');
  
  if (quoteImgEl) quoteImgEl.classList.add('hidden');
  if (quoteTextEl) {
    quoteTextEl.textContent = text;
    quoteTextEl.classList.remove('hidden');
  }
  if (quoteArea) quoteArea.classList.remove('hidden');
  
  // 사이드바 활성화
  if (chatSidebar.classList.contains('hidden')) {
    toggleChatSidebar();
  }
  
  // 입력 필드 초기화 및 포커싱
  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatInput.focus();
}

function askAIAssistantImage(base64Img, pageNum) {
  if (!state.sessionId) {
    showToast('논문을 먼저 업로드하거나 선택해주세요.', 'error');
    return;
  }
  
  state.quotedImage = base64Img;
  state.quotedImagePage = pageNum;
  state.quotedText = null;
  
  const quoteTextEl = $('chat-quote-text');
  const quoteImgEl = $('chat-quote-img');
  const quoteArea = $('chat-quote-area');
  
  if (quoteTextEl) quoteTextEl.classList.add('hidden');
  if (quoteImgEl) {
    quoteImgEl.src = base64Img;
    quoteImgEl.classList.remove('hidden');
  }
  if (quoteArea) quoteArea.classList.remove('hidden');
  
  // 사이드바 활성화
  if (chatSidebar.classList.contains('hidden')) {
    toggleChatSidebar();
  }
  
  // 입력 필드 초기화 및 포커싱
  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatInput.focus();
}

if (viewerScrollContainer) {
  viewerScrollContainer.addEventListener('scroll', hideSelectionMenu);
}

window.addEventListener('resize', hideSelectionMenu);

document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.pdf-figure-overlay')) return;
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

// ── PDF-번역본 문장 1대1 매칭 및 하이라이트 ────────────────
// 문장 세그멘테이션(span 태그 생성)을 제거하고 순수 텍스트 노드로 원복합니다.
function clearSegmentation(container, className) {
  if (!container) return;
  container.querySelectorAll(`.${className}`).forEach(span => {
    if (span.classList.contains('katex-display-wrap') || span.classList.contains('katex-inline-wrap') || span.classList.contains('math-pending') || span.classList.contains('math-error')) {
      span.classList.remove(className);
      delete span.dataset.page;
      delete span.dataset.sentenceIdx;
      span.style.cursor = '';
    } else {
      const textNode = document.createTextNode(span.textContent);
      span.replaceWith(textNode);
    }
  });
  container.normalize();
  delete container.dataset.segmented;
}

function segmentElementIntoSentences(container, pageNum, className) {
  if (!container) return;

  // 이미 세그멘테이션이 적용되어 있다면 기존 세그멘테이션 원복 후 재수행
  if (container.dataset.segmented === 'true') {
    clearSegmentation(container, className);
  }

  if (className === 'pdf-sentence') {
    segmentPdfElements(container, pageNum);
  } else {
    segmentTransElements(container, pageNum);
  }
}



// 주어진 텍스트에서 원문 문장들의 정확한 문자 범위(start, end)를 유니코드 인지 방식으로 추출하여 매핑합니다.
function alignSentencesToText(fullText, sentencesList, pageNum = '?') {
  const cleanToRaw = [];
  let cleanText = '';
  
  for (let i = 0; i < fullText.length; i++) {
    const char = fullText[i];
    // 알파벳, 숫자, 한글, 한자 및 그리스 문자(수식 기호 대응)만 비교 대상으로 삼음
    if (/[a-zA-Z0-9\u3131-\uD79D\u4e00-\u9fff\u0370-\u03ff]/.test(char)) {
      cleanToRaw.push(i);
      cleanText += char.toLowerCase();
    }
  }
  
  const sentenceRanges = [];
  let searchStart = 0;
  
  // 모든 문장 미리 전처리 - null/undefined 방어 및 그리스 문자 대응
  const cleanSents = (sentencesList || []).map(s => {
    const text = s || '';
    let clean = '';
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (/[a-zA-Z0-9\u3131-\uD79D\u4e00-\u9fff\u0370-\u03ff]/.test(char)) {
        clean += char.toLowerCase();
      }
    }
    return clean;
  });
  
  for (let k = 0; k < cleanSents.length; k++) {
    const cleanSent = cleanSents[k];
    const sText = sentencesList[k] || '';
    
    if (!cleanSent) {
      const rawPos = cleanToRaw[searchStart] ?? (cleanToRaw[cleanToRaw.length - 1] ?? 0);
      sentenceRanges.push({
        text: sText,
        start: rawPos,
        end: rawPos
      });
      continue;
    }
    
    // 1. 순차 검색 시도 (가장 최선)
    let idx = cleanText.indexOf(cleanSent, searchStart);
    
    // 2. 순차 검색 실패 시 전역 검색 시도 (정렬 어긋남 해결)
    if (idx === -1) {
      idx = cleanText.indexOf(cleanSent);
    }
    
    // 3. 접두어 기반 검색 시도 (사소한 문자 오차 해결)
    if (idx === -1) {
      const prefix = cleanSent.substring(0, Math.min(15, cleanSent.length));
      idx = cleanText.indexOf(prefix, searchStart);
      if (idx === -1) {
        idx = cleanText.indexOf(prefix);
      }
    }
    
    if (idx !== -1) {
      const cleanStart = idx;
      const cleanEnd = Math.min(cleanText.length, idx + cleanSent.length);
      
      const rawStart = cleanToRaw[cleanStart] ?? (cleanToRaw[cleanToRaw.length - 1] ?? 0);
      const lastCleanIdx = cleanEnd - 1;
      const rawEnd = (cleanToRaw[lastCleanIdx] !== undefined)
        ? cleanToRaw[lastCleanIdx] + 1
        : (cleanToRaw[cleanToRaw.length - 1] ?? fullText.length);
        
      sentenceRanges.push({
        text: fullText.substring(rawStart, rawEnd),
        start: rawStart,
        end: rawEnd
      });
      
      // 순차 검색 인덱스는 전방향 진행만 허용
      if (cleanEnd > searchStart) {
        searchStart = cleanEnd;
      }
    } else {
      // 매칭 실패 폴백
      console.warn(`[alignSentencesToText] Failed to match sentence on page ${pageNum}:`, sText);
      const rawPos = cleanToRaw[searchStart] ?? (cleanToRaw[cleanToRaw.length - 1] ?? 0);
      sentenceRanges.push({
        text: sText,
        start: rawPos,
        end: rawPos
      });
    }
  }

  // 매칭 실패(길이 0)인 문장들의 범위를 주변 매칭 성공 문장들 사이의 간격으로 보간(Interpolation)
  // 수식 등의 기호만 있는 문장들이 누락 없이 PDF 텍스트 레이어에 적절한 인덱스로 마킹되도록 지원
  for (let k = 0; k < sentenceRanges.length; k++) {
    if (sentenceRanges[k].start === sentenceRanges[k].end) {
      let prevEnd = 0;
      for (let i = k - 1; i >= 0; i--) {
        if (sentenceRanges[i].end > sentenceRanges[i].start) {
          prevEnd = sentenceRanges[i].end;
          break;
        }
      }
      let nextStart = fullText.length;
      for (let i = k + 1; i < sentenceRanges.length; i++) {
        if (sentenceRanges[i].end > sentenceRanges[i].start) {
          nextStart = sentenceRanges[i].start;
          break;
        }
      }
      
      if (prevEnd < nextStart) {
        sentenceRanges[k].start = prevEnd;
        sentenceRanges[k].end = nextStart;
      }
    }
  }
  
  return sentenceRanges;
}

// PDF 텍스트 레이어 물리적 문장 쪼개기 구현
// 세로 간격(vertical gap)과 글자 크기(font-size)를 기반으로 단락 경계를 감지하여 \n\n 삽입
function segmentPdfElements(container, pageNum) {
  try {
    const elements = Array.from(container.children).filter(el => el.nodeType === 1);
    if (elements.length === 0) return;

    // 2단 레이아웃 감지 및 font-size 정보 수집
    const nodes = elements.map(el => {
      const leftMatch = el.style.left?.match(/([\d.-]+)px/);
      const topMatch  = el.style.top?.match(/([\d.-]+)px/);
      const fsMatch   = el.style.fontSize?.match(/([\d.]+)/);
      return {
        el,
        left:     leftMatch ? parseFloat(leftMatch[1]) : 0,
        top:      topMatch  ? parseFloat(topMatch[1])  : 0,
        fontSize: fsMatch   ? parseFloat(fsMatch[1])   : 10,
      };
    });

    const pageWidth = parseFloat(container.style.width) || 600;
    const mid = pageWidth / 2;
    const leftCount  = nodes.filter(n => n.left < mid * 1.05).length;
    const rightCount = nodes.filter(n => n.left > mid * 0.95).length;
    const isTwoColumn = nodes.length > 5
      && (leftCount  / nodes.length > 0.3)
      && (rightCount / nodes.length > 0.3);

    let sortedNodes;
    if (isTwoColumn) {
      const leftNs  = nodes.filter(n => n.left < mid).sort((a, b) => a.top - b.top || a.left - b.left);
      const rightNs = nodes.filter(n => n.left >= mid).sort((a, b) => a.top - b.top || a.left - b.left);
      sortedNodes = leftNs.concat(rightNs);
    } else {
      sortedNodes = [...nodes].sort((a, b) =>
        Math.abs(a.top - b.top) < 4 ? a.left - b.left : a.top - b.top
      );
    }

    // 줄간격 중앙값(median line gap)과 글자크기 중앙값 계산
    const gaps = [];
    for (let i = 1; i < sortedNodes.length; i++) {
      const gap = sortedNodes[i].top - sortedNodes[i - 1].top;
      if (gap > 0) gaps.push(gap);
    }
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
    const paraGapThreshold = medianGap * 1.8; // 기준 줄간격의 1.8배 이상 벌어지면 단락 구분

    const fontSizes = sortedNodes.map(n => n.fontSize).sort((a, b) => a - b);
    const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 10;
    const headerFsThreshold = medianFontSize * 1.15; // 중앙값보다 15% 이상 큰 폰트는 헤더/제목으로 판정

    // 텍스트 노드 수집 헬퍼
    function collectTextNodesFromEl(el) {
      const textNodes = [];
      function walk(node) {
        if (node.nodeType === 3) {
          if (node.nodeValue && node.nodeValue.trim()) textNodes.push(node);
        } else if (
          node.nodeName !== 'SCRIPT' &&
          node.nodeName !== 'STYLE' &&
          !node.classList?.contains('katex') &&
          !node.classList?.contains('katex-display-wrap')
        ) {
          for (const child of node.childNodes) walk(child);
        }
      }
      walk(el);
      return textNodes;
    }

    // 순차적으로 fullText 구성, 단락 경계에 \n\n 삽입
    let fullText = '';
    const nodeRanges = [];
    let prevTop = null;
    let prevFontSize = medianFontSize;

    for (let i = 0; i < sortedNodes.length; i++) {
      const { el, top, fontSize } = sortedNodes[i];
      const elNodes = collectTextNodesFromEl(el);
      if (elNodes.length === 0) continue;

      if (fullText.length > 0) {
        const gap = prevTop !== null ? top - prevTop : 0;
        const isPrevHeader = prevFontSize > headerFsThreshold;
        const isCurrentHeader = fontSize > headerFsThreshold;
        const isLargeGap = gap > paraGapThreshold;

        // 이전 노드가 순수 섹션 번호(예: "1.", "A.")인 경우는 제목과 하나의 문장으로 묶이도록 단락 분할을 건너뜁니다.
        const prevText = collectTextNodesFromEl(sortedNodes[i - 1].el).map(n => n.nodeValue).join('').trim();
        const isPrevSectionNum = /^(?:[IVXLCDM\d]+(?:\.[IVXLCDM\d]+)*\.?|[A-Z]\.?)$/i.test(prevText);

        // 이전/현재 폰트가 헤더 크기이거나, 줄간격이 기준치보다 크거나, 줄 흐름이 아예 바뀐 경우 단락 경계
        if (!isPrevSectionNum && (isPrevHeader || isCurrentHeader || isLargeGap || gap < -50)) {
          if (!fullText.endsWith('\n\n')) {
            fullText += '\n\n';
          }
        } else {
          // 일반 공백 삽입 조건
          const prevChar = fullText[fullText.length - 1];
          const nextChar = elNodes[0].nodeValue[0];
          if (prevChar !== ' ' && nextChar !== ' ' && prevChar !== '\n') {
            fullText += ' ';
          }
        }
      }

      for (let j = 0; j < elNodes.length; j++) {
        const node = elNodes[j];
        if (j > 0) {
          const prevChar = fullText[fullText.length - 1];
          const nextChar = node.nodeValue[0];
          if (prevChar !== ' ' && nextChar !== ' ') {
            fullText += ' ';
          }
        }
        const start = fullText.length;
        fullText += node.nodeValue;
        nodeRanges.push({ node, start, end: fullText.length });
      }

      prevTop = top;
      prevFontSize = fontSize;
    }

    if (nodeRanges.length === 0) return;

    // 단락 단위 인지 문장 분할
    let sentenceRanges;
    const sentences = state.translationSentences && state.translationSentences[pageNum];
    if (sentences && sentences.length > 0) {
      const srcSents = sentences.map(s => s.src);
      sentenceRanges = alignSentencesToText(fullText, srcSents, pageNum);
    } else {
      sentenceRanges = splitIntoSentences(fullText);
    }
    if (sentenceRanges.length === 0) return;

    // 물리적 DOM 쪼개기 수행
    for (const range of nodeRanges) {
      const parent = range.node.parentNode;
      if (!parent) continue;

      const segments = [];
      for (let i = 0; i < sentenceRanges.length; i++) {
        const sent = sentenceRanges[i];
        const start = Math.max(range.start, sent.start);
        const end = Math.min(range.end, sent.end);
        if (start < end) {
          segments.push({
            sentenceIdx: i,
            startInNode: start - range.start,
            endInNode: end - range.start,
            text: range.node.nodeValue.substring(start - range.start, end - range.start),
          });
        }
      }
      if (segments.length === 0) continue;

      const fragment = document.createDocumentFragment();
      let lastIdx = 0;
      segments.sort((a, b) => a.startInNode - b.startInNode);

      for (const seg of segments) {
        if (seg.startInNode > lastIdx) {
          fragment.appendChild(document.createTextNode(
            range.node.nodeValue.substring(lastIdx, seg.startInNode)
          ));
        }

        const span = document.createElement('span');
        span.className = 'pdf-sentence';
        span.dataset.page = pageNum;
        span.dataset.sentenceIdx = seg.sentenceIdx;
        span.textContent = seg.text;
        span.style.cursor = 'pointer';
        
        fragment.appendChild(span);
        lastIdx = seg.endInNode;
      }

      if (lastIdx < range.node.nodeValue.length) {
        fragment.appendChild(document.createTextNode(
          range.node.nodeValue.substring(lastIdx)
        ));
      }

      parent.replaceChild(fragment, range.node);
    }

    if (!state.pdfPageSentences) state.pdfPageSentences = {};
    state.pdfPageSentences[pageNum] = sentenceRanges;

    container.dataset.segmented = 'true';
  } catch (err) {
    console.warn(`segmentPdfElements failed for p.${pageNum}:`, err);
  }
}

// 번역본용 문장 쪼개기
// HTML의 헤더(h2~h4) 및 <br><br> 개행 태그를 기준으로 문단(\n\n) 처리
function segmentTransElements(container, pageNum) {
  try {
    const textNodes = [];
    const nodeParagraphBreak = [];

    function walk(node, isFirstInBlock) {
      if (node.nodeType === 3) {
        if (node.nodeValue && node.nodeValue.trim()) {
          textNodes.push(node);
          nodeParagraphBreak.push(isFirstInBlock);
          return true;
        }
        return false;
      } else if (
        node.nodeName === 'SCRIPT' ||
        node.nodeName === 'STYLE'
      ) {
        return false;
      } else if (
        node.classList?.contains('katex-display-wrap') ||
        node.classList?.contains('katex-inline-wrap') ||
        node.classList?.contains('math-pending') ||
        node.classList?.contains('math-error')
      ) {
        // 수식 블록은 단일 원자 노드로 수집하여 쪼개짐 방지
        textNodes.push(node);
        nodeParagraphBreak.push(isFirstInBlock);
        return true;
      } else {
        const isBlock = ['H2', 'H3', 'H4', 'H5', 'H6', 'P', 'DIV', 'BLOCKQUOTE', 'LI'].includes(node.nodeName);
        let firstChild = true;
        let hadText = false;
        
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          
          if (child.nodeName === 'BR') {
            // 연속된 <br> 태그가 감지되면 단락 나눔으로 판정
            const next = node.childNodes[i + 1];
            if (next && next.nodeName === 'BR') {
              firstChild = true;
              i++; // 다음 BR 건너뜀
            }
            continue;
          }
          
          const childFirst = isBlock ? firstChild : isFirstInBlock;
          const childHadText = walk(child, childFirst && !hadText);
          if (childHadText) {
            hadText = true;
            firstChild = false;
          }
        }
        return hadText;
      }
    }

    walk(container, false);

    if (textNodes.length === 0) return;

    let fullText = '';
    const nodeRanges = [];
    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      if (i > 0) {
        if (nodeParagraphBreak[i]) {
          if (!fullText.endsWith('\n\n')) {
            fullText += '\n\n';
          }
        } else {
          const prevChar = fullText[fullText.length - 1];
          let nextChar = ' ';
          if (node.nodeType === 3) {
            nextChar = node.nodeValue ? node.nodeValue[0] : ' ';
          }
          if (prevChar !== ' ' && nextChar !== ' ' && prevChar !== '\n') {
            fullText += ' ';
          }
        }
      }
      const start = fullText.length;
      let nodeText = '';
      if (node.nodeType === 3) {
        nodeText = node.nodeValue || '';
      } else {
        // 수식 기호 복원 ($...$ 또는 $$...$$) - 안전하게 디코딩
        let formula = '';
        try {
          formula = decodeURIComponent(node.dataset.formula || '');
        } catch (e) {
          formula = node.dataset.formula || '';
        }
        const display = node.dataset.display === 'true';
        const delim = display ? '$$' : '$';
        nodeText = delim + formula + delim;
      }
      fullText += nodeText;
      nodeRanges.push({ node, start, end: fullText.length });
    }

    let sentenceRanges;
    const sentences = state.translationSentences && state.translationSentences[pageNum];
    if (sentences && sentences.length > 0) {
      const transSents = sentences.map(s => s.trans);
      sentenceRanges = alignSentencesToText(fullText, transSents, pageNum);
    } else {
      sentenceRanges = splitIntoSentences(fullText);
    }

    for (const range of nodeRanges) {
      const parent = range.node.parentNode;
      if (!parent) continue;

      if (range.node.nodeType === 3) {
        const segments = [];
        for (let i = 0; i < sentenceRanges.length; i++) {
          const sent = sentenceRanges[i];
          const start = Math.max(range.start, sent.start);
          const end = Math.min(range.end, sent.end);
          if (start < end) {
            segments.push({
              sentenceIdx: i,
              startInNode: start - range.start,
              endInNode: end - range.start,
              text: range.node.nodeValue.substring(start - range.start, end - range.start),
            });
          }
        }

        if (segments.length === 0) continue;

        const fragment = document.createDocumentFragment();
        let lastIdx = 0;
        segments.sort((a, b) => a.startInNode - b.startInNode);

        for (const seg of segments) {
          if (seg.startInNode > lastIdx) {
            fragment.appendChild(document.createTextNode(
              range.node.nodeValue.substring(lastIdx, seg.startInNode)
            ));
          }

          const span = document.createElement('span');
          span.className = 'trans-sentence';
          span.dataset.page = pageNum;
          span.dataset.sentenceIdx = seg.sentenceIdx;
          span.textContent = seg.text;
          span.style.cursor = 'pointer';
          
          fragment.appendChild(span);
          lastIdx = seg.endInNode;
        }

        if (lastIdx < range.node.nodeValue.length) {
          fragment.appendChild(document.createTextNode(
            range.node.nodeValue.substring(lastIdx)
          ));
        }

        parent.replaceChild(fragment, range.node);
      } else {
        // 수식 엘리먼트 자체를 1:1 매칭 문장 스팬으로 마킹
        // 단순 앞선 경계 겹침 대신, 문자 범위 교집합(intersection)이 가장 큰 문장 매치
        let matchedIdx = -1;
        let maxOverlap = 0;
        for (let i = 0; i < sentenceRanges.length; i++) {
          const sent = sentenceRanges[i];
          const overlap = Math.max(0, Math.min(range.end, sent.end) - Math.max(range.start, sent.start));
          if (overlap > maxOverlap) {
            maxOverlap = overlap;
            matchedIdx = i;
          }
        }

        if (matchedIdx !== -1) {
          range.node.classList.add('trans-sentence');
          range.node.dataset.page = pageNum;
          range.node.dataset.sentenceIdx = matchedIdx;
          range.node.style.cursor = 'pointer';
        }
      }
    }

    container.dataset.segmented = 'true';
  } catch (err) {
    console.error("Translation segmentation error:", err);
  }
}

// ── 공통 문장 분리 유틸리티 ────────────────────────────────
/**
 * 주어진 텍스트를 단락과 문장 단위로 분리합니다.
 * \n\n(단락 경계)는 강제 문장 경계로 판정합니다.
 */
function splitIntoSentences(fullText) {
  const sentenceRanges = [];
  
  // 먼저 문단 단위(\n\n)로 1차 분할 수행
  const paraRegex = /\n{2,}/g;
  let lastParaIndex = 0;
  let match;
  const paras = [];
  
  while ((match = paraRegex.exec(fullText)) !== null) {
    paras.push({
      text: fullText.substring(lastParaIndex, match.index),
      start: lastParaIndex,
      end: match.index
    });
    lastParaIndex = paraRegex.lastIndex;
  }
  paras.push({
    text: fullText.substring(lastParaIndex),
    start: lastParaIndex,
    end: fullText.length
  });
  
  const abbreviations = new Set([
    'al', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'tab', 'tabs',
    'eg', 'ie', 'vol', 'no', 'vs', 'dr', 'prof', 'approx', 'etc', 'cf',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    'sec', 'sect', 'app', 'chap', 'ch', 'pp', 'p', 'est', 'ave', 'st', 'dept'
  ]);
  
  for (const para of paras) {
    const paraText = para.text;
    const paraStart = para.start;
    if (!paraText.trim()) continue;
    
    // 문단 내부에서 구두점을 기준으로 2차 문장 분할
    const candRegex = /([.!?]+)([ \t\n\r]+)/g;
    let lastSentenceIndex = 0;
    let sMatch;
    
    while ((sMatch = candRegex.exec(paraText)) !== null) {
      const puncIndex = sMatch.index;
      const punc = sMatch[1];
      const whitespace = sMatch[2];
      const nextIndex = puncIndex + punc.length + whitespace.length;
      
      if (nextIndex >= paraText.length) {
        // 문단 끝 부분
        const sentenceText = paraText.substring(lastSentenceIndex, puncIndex + punc.length);
        if (sentenceText.trim()) {
          sentenceRanges.push({
            text: sentenceText,
            start: paraStart + lastSentenceIndex,
            end: paraStart + puncIndex + punc.length
          });
        }
        lastSentenceIndex = nextIndex;
        continue;
      }
      
      const nextChar = paraText[nextIndex];
      const isPeriod = punc.includes('.');
      
      // 다음 글자가 소문자/숫자/특수문자이면 문장 구분 안 함
      const isLowerOrDigitOrSpecial = /^[a-z0-9\-_\'\(\[\{"\u00e0-\u00f6\u00f8-\u00fe]/.test(nextChar);
      if (isPeriod && isLowerOrDigitOrSpecial) {
        continue;
      }
      
      // 섹션 번호 형식 ("1.", "2.1.") 등은 단일 문장으로 분할하지 않음
      if (isPeriod) {
        const leftText = paraText.substring(lastSentenceIndex, puncIndex).trim();
        if (/^\d+(\.\d+)*$/.test(leftText)) {
          continue;
        }
        
        // 약어 매칭
        const words = leftText.split(/[\s,()\[\]{}.]+/);
        const lastWord = words.length > 0 ? words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '') : '';
        const isAbbreviation = abbreviations.has(lastWord) || (lastWord.length === 1 && /^[a-z]$/i.test(lastWord));
        if (isAbbreviation) continue;
        
        // 소수점 패턴 (\d.\d)
        const charBeforePunc = paraText[puncIndex - 1];
        if (charBeforePunc && /\d/.test(charBeforePunc) && /^\d/.test(nextChar)) continue;
      }
      
      const sentenceText = paraText.substring(lastSentenceIndex, puncIndex + punc.length);
      if (sentenceText.trim()) {
        sentenceRanges.push({
          text: sentenceText,
          start: paraStart + lastSentenceIndex,
          end: paraStart + puncIndex + punc.length
        });
      }
      lastSentenceIndex = nextIndex;
    }
    
    if (lastSentenceIndex < paraText.length) {
      const remaining = paraText.substring(lastSentenceIndex);
      if (remaining.trim()) {
        sentenceRanges.push({
          text: remaining,
          start: paraStart + lastSentenceIndex,
          end: paraStart + paraText.length
        });
      }
    }
  }
  
  return sentenceRanges;
}

// 1대1 매칭 마우스 오버/아웃 및 클릭 이벤트 위임 등록
if (viewerScrollContainer) {
  // PDF와 번역본의 문장 수 차이를 고려한 오프셋 기반 매핑 함수
  viewerScrollContainer.addEventListener('mousemove', () => {
    state.hoverSelectionDisabled = false;
  });

  viewerScrollContainer.addEventListener('mouseover', (e) => {
    try {
      if (sentenceHoverTimer) {
        clearTimeout(sentenceHoverTimer);
        sentenceHoverTimer = null;
      }

      const annSpan = e.target.closest('.pdf-annotation-highlight, .pdf-annotation-underline');
      if (annSpan) {
        showAnnotationHoverTooltip(annSpan);
      }

      const target = e.target.closest('.trans-sentence') || e.target.closest('.pdf-sentence');

      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && !annSpan) {
        if (e.buttons === 1) {
          return;
        }
        if (target) {
          const pageWrapper = target.closest('.pdf-page-wrapper') || target.closest('.trans-page-block');
          const hoveredPageNum = pageWrapper ? parseInt(pageWrapper.dataset.page, 10) : -1;
          const hoveredSentenceIdx = parseInt(target.dataset.sentenceIdx, 10);

          const isSameAsSelected = (hoveredPageNum === state.hoverSelectedPageNum && hoveredSentenceIdx === state.hoverSelectedSentenceIdx);

          if (!isSameAsSelected) {
            hideSelectionMenuWithDelay();
          } else {
            if (selectionMenuHideTimer) {
              clearTimeout(selectionMenuHideTimer);
              selectionMenuHideTimer = null;
            }
            return;
          }
        } else {
          return;
        }
      }

      if (!target) return;

      // PDF 텍스트 문장에 마우스가 700ms 동안 머물러 있으면 문장 단위 자동 드래그 선택 및 툴팁 띄우기
      // 단, 이미 어노테이션이 입혀진 span 위에 올라온 경우나 호버 자동 선택이 비활성화된 경우는 작동 제외
      const pdfTarget = e.target.closest('.pdf-sentence');
      if (pdfTarget && !annSpan && !state.hoverSelectionDisabled) {
        sentenceHoverTimer = setTimeout(() => {
          const curSel = window.getSelection();
          if (curSel && !curSel.isCollapsed) return;

          const sentenceIdx = parseInt(pdfTarget.dataset.sentenceIdx, 10);
          if (isNaN(sentenceIdx)) return;

          const pageWrapper = pdfTarget.closest('.pdf-page-wrapper');
          if (!pageWrapper) return;
          const pageNum = parseInt(pageWrapper.dataset.page, 10);

          const { pdfIdx, transIdx, pdfElements } = getMappedElementsAndIndices(pdfTarget, pageNum, sentenceIdx);

          if (pdfElements && pdfElements.length > 0) {
            state.hoverSelectedPdfElements = pdfElements;
            state.hoverSelectedPageNum = pageNum;
            state.hoverSelectedSentenceIdx = pdfIdx;

            const firstEl = pdfElements[0];
            const lastEl = pdfElements[pdfElements.length - 1];

            const firstWalker = document.createTreeWalker(firstEl, NodeFilter.SHOW_TEXT);
            const firstNodes = [];
            while (firstWalker.nextNode()) firstNodes.push(firstWalker.currentNode);

            const lastWalker = document.createTreeWalker(lastEl, NodeFilter.SHOW_TEXT);
            const lastNodes = [];
            while (lastWalker.nextNode()) lastNodes.push(lastWalker.currentNode);

            if (firstNodes.length > 0 && lastNodes.length > 0) {
              const range = document.createRange();
              range.setStart(firstNodes[0], 0);
              range.setEnd(lastNodes[lastNodes.length - 1], lastNodes[lastNodes.length - 1].length);

              curSel.removeAllRanges();
              curSel.addRange(range);

              const rect = pdfTarget.getBoundingClientRect();
              showSelectionMenu(rect, true);
            }
          }
        }, 700);
      }

      const pageWrapper = target.closest('.pdf-page-wrapper') || target.closest('.trans-page-block');
      if (!pageWrapper) return;
      const pageNum = pageWrapper.dataset.page;
      if (!pageNum) return;

      const sentenceIdx = parseInt(target.dataset.sentenceIdx, 10);
      if (isNaN(sentenceIdx)) return;

      const { pdfIdx, transIdx, pdfElements } = getMappedElementsAndIndices(target, pageNum, sentenceIdx);

      // 기존의 모든 하이라이트 제거
      viewerScrollContainer.querySelectorAll('.sentence-highlight').forEach(el => {
        el.classList.remove('sentence-highlight');
      });

      // 1. PDF 엘리먼트들 하이라이트
      pdfElements.forEach(el => {
        el.classList.add('sentence-highlight');
      });

      // 2. 번역본 문장 하이라이트
      if (transIdx !== -1) {
        viewerScrollContainer.querySelectorAll(
          `.trans-sentence[data-page="${pageNum}"][data-sentence-idx="${transIdx}"]`
        ).forEach(el => {
          el.classList.add('sentence-highlight');
        });
      }
    } catch (err) {
      console.warn("mouseover highlight mapping failed:", err);
    }
  });

  viewerScrollContainer.addEventListener('mouseout', (e) => {
    try {
      if (sentenceHoverTimer) {
        clearTimeout(sentenceHoverTimer);
        sentenceHoverTimer = null;
      }

      const annSpan = e.target.closest('.pdf-annotation-highlight, .pdf-annotation-underline');
      if (annSpan) {
        if (!e.relatedTarget || !e.relatedTarget.closest('#ann-hover-tooltip')) {
          hideAnnHoverTooltipWithDelay();
        }
      }

      viewerScrollContainer.querySelectorAll('.sentence-highlight').forEach(el => {
        el.classList.remove('sentence-highlight');
      });
    } catch (err) {
      // no-op
    }
  });

  // 클릭 시 해당 매칭 문장으로 스크롤 이동 및 양방향 고정 하이라이트 매칭 적용
  viewerScrollContainer.addEventListener('click', (e) => {
    try {
      state.hoverSelectionDisabled = true;
      if (sentenceHoverTimer) {
        clearTimeout(sentenceHoverTimer);
        sentenceHoverTimer = null;
      }

      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      const target = e.target.closest('.trans-sentence') || e.target.closest('.pdf-sentence');
      if (!target) {
        // 문장이 아닌 곳 클릭 시 기존 매칭 하이라이트 제거
        viewerScrollContainer.querySelectorAll('.active-mapped-sentence').forEach(el => {
          el.classList.remove('active-mapped-sentence');
        });
        return;
      }

      const pageWrapper = target.closest('.pdf-page-wrapper') || target.closest('.trans-page-block');
      if (!pageWrapper) return;
      const pageNum = pageWrapper.dataset.page;
      if (!pageNum) return;

      const sentenceIdx = parseInt(target.dataset.sentenceIdx, 10);
      if (isNaN(sentenceIdx)) return;

      const { pdfIdx, transIdx, pdfElements } = getMappedElementsAndIndices(target, pageNum, sentenceIdx);
      if (pdfIdx === -1 || transIdx === -1) return;

      // 1. 기존 매칭 하이라이트 제거
      viewerScrollContainer.querySelectorAll('.active-mapped-sentence').forEach(el => {
        el.classList.remove('active-mapped-sentence');
      });

      // 2. 신규 고정 매칭 하이라이트 지정
      pdfElements.forEach(el => {
        el.classList.add('active-mapped-sentence');
      });
      if (transIdx !== -1) {
        viewerScrollContainer.querySelectorAll(
          `.trans-sentence[data-page="${pageNum}"][data-sentence-idx="${transIdx}"]`
        ).forEach(el => {
          el.classList.add('active-mapped-sentence');
        });
      }

      // 번역본 클릭 -> PDF로 스크롤
      if (target.classList.contains('trans-sentence')) {
        if (pdfElements.length > 0) {
          const firstEl = pdfElements[0];
          firstEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          pdfElements.forEach(el => {
            el.classList.add('sentence-pulse');
            setTimeout(() => el.classList.remove('sentence-pulse'), 1000);
          });
        }
      } 
      // PDF 클릭 -> 번역본으로 스크롤
      else {
        if (transIdx !== -1) {
          const match = viewerScrollContainer.querySelector(
            `.trans-sentence[data-page="${pageNum}"][data-sentence-idx="${transIdx}"]`
          );
          if (match) {
            match.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            match.classList.add('sentence-pulse');
            setTimeout(() => match.classList.remove('sentence-pulse'), 1000);
          }
        }
      }
    } catch (err) {
      console.warn("click scroll mapping failed:", err);
    }
  });
}

// ── 영역 캡처 모드 (Manual Crop Tool) ──────────────────
let isCropping = false
let cropStart = { x: 0, y: 0 }
let cropOverlay = null
let cropPageEl = null

function initCropTool() {
  const container = viewerScrollContainer
  if (!container) return
  
  container.addEventListener('mousedown', (e) => {
    if (!state.isCropMode) return
    const pageInner = e.target.closest('.pdf-page-inner')
    if (!pageInner) return
    
    e.preventDefault()
    e.stopPropagation()
    
    isCropping = true
    cropPageEl = pageInner
    
    const rect = pageInner.getBoundingClientRect()
    cropStart.x = e.clientX - rect.left
    cropStart.y = e.clientY - rect.top
    
    cropOverlay = pageInner.querySelector('.pdf-crop-overlay')
    if (!cropOverlay) {
      cropOverlay = document.createElement('div')
      cropOverlay.className = 'pdf-crop-overlay'
      cropOverlay.style.position = 'absolute'
      cropOverlay.style.border = '2px dashed var(--accent-mid, #8b5cf6)'
      cropOverlay.style.background = 'rgba(139, 92, 246, 0.15)'
      cropOverlay.style.pointerEvents = 'none'
      cropOverlay.style.zIndex = '10'
      pageInner.appendChild(cropOverlay)
    }
    
    cropOverlay.style.left = `${cropStart.x}px`
    cropOverlay.style.top = `${cropStart.y}px`
    cropOverlay.style.width = '0px'
    cropOverlay.style.height = '0px'
    cropOverlay.style.display = 'block'
  })
  
  container.addEventListener('mousemove', (e) => {
    if (!state.isCropMode || !isCropping || !cropPageEl || !cropOverlay) return
    
    const rect = cropPageEl.getBoundingClientRect()
    const currentX = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const currentY = Math.max(0, Math.min(rect.height, e.clientY - rect.top))
    
    const left = Math.min(cropStart.x, currentX)
    const top = Math.min(cropStart.y, currentY)
    const width = Math.abs(cropStart.x - currentX)
    const height = Math.abs(cropStart.y - currentY)
    
    cropOverlay.style.left = `${left}px`
    cropOverlay.style.top = `${top}px`
    cropOverlay.style.width = `${width}px`
    cropOverlay.style.height = `${height}px`
  })
  
  container.addEventListener('mouseup', (e) => {
    if (!state.isCropMode || !isCropping || !cropPageEl || !cropOverlay) return
    isCropping = false
    
    const rect = cropPageEl.getBoundingClientRect()
    const currentX = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const currentY = Math.max(0, Math.min(rect.height, e.clientY - rect.top))
    
    const left = Math.min(cropStart.x, currentX)
    const top = Math.min(cropStart.y, currentY)
    const width = Math.abs(cropStart.x - currentX)
    const height = Math.abs(cropStart.y - currentY)
    
    cropOverlay.style.display = 'none'
    
    if (width < 10 || height < 10) {
      cropPageEl = null
      return
    }
    
    const wrapper = cropPageEl.closest('.pdf-page-wrapper')
    const pageNum = wrapper ? parseInt(wrapper.dataset.page) : 1
    
    const canvas = cropPageEl.querySelector('canvas')
    if (canvas) {
      try {
        const dprScaleX = canvas.width / rect.width
        const dprScaleY = canvas.height / rect.height
        
        const leftPx = left * dprScaleX
        const topPx = top * dprScaleY
        const widthPx = width * dprScaleX
        const heightPx = height * dprScaleY
        
        const tempCanvas = document.createElement('canvas')
        const ctx = tempCanvas.getContext('2d')
        tempCanvas.width = widthPx
        tempCanvas.height = heightPx
        
        ctx.drawImage(
          canvas,
          leftPx, topPx, widthPx, heightPx,
          0, 0, widthPx, heightPx
        )
        
        const base64Img = tempCanvas.toDataURL('image/png')
        
        toggleCropMode(false)
        askAIAssistantImage(base64Img, pageNum)
      } catch (err) {
        console.error("Manual crop failed:", err)
        showToast("캡처에 실패했습니다.", "error")
      }
    }
    
    cropPageEl = null
  })
}

function toggleCropMode(forceState) {
  state.isCropMode = forceState !== undefined ? forceState : !state.isCropMode
  
  if (state.isCropMode) {
    viewerScrollContainer.classList.add('crop-mode')
    if (captureAreaBtn) captureAreaBtn.classList.add('active')
    showToast("마우스로 드래그하여 질문할 영역을 선택하세요.", "success")
  } else {
    viewerScrollContainer.classList.remove('crop-mode')
    if (captureAreaBtn) captureAreaBtn.classList.remove('active')
    document.querySelectorAll('.pdf-crop-overlay').forEach(el => el.remove())
  }
}

// 영역 캡처 버튼 리스너 등록
if (captureAreaBtn) {
  captureAreaBtn.addEventListener('click', () => {
    if (!state.sessionId) {
      showToast("논문을 먼저 업로드하거나 선택해주세요.", "error")
      return
    }
    toggleCropMode()
  })
}

// 캡처 툴 초기화 실행
initCropTool()

// ── 번역 창 접기 및 너비 크기 조절 (드래그/버튼 연동) ──────────────────────
function updateTransPaneWidth(newWidth) {
  currentTransPaneWidth = Math.max(320, Math.min(newWidth, 820))
  document.documentElement.style.setProperty('--trans-pane-width', `${currentTransPaneWidth}px`)
  localStorage.setItem('trans-pane-width', currentTransPaneWidth)
}

// 드래그 리사이저 핸들 조작 바인딩 (이벤트 위임)
let isResizingTrans = false
let resizerStartX = 0
let resizerStartWidth = 0

viewerScrollContainer.addEventListener('mousedown', (e) => {
  const handle = e.target.closest('.trans-resizer-handle')
  if (!handle) return
  if (e.target.closest('.trans-collapse-btn')) return // 접기 버튼 클릭은 무시
  if (isTransPaneCollapsed) return // 접혀있는 상태에서는 드래그 금지
  
  isResizingTrans = true
  resizerStartX = e.clientX
  resizerStartWidth = currentTransPaneWidth
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.body.classList.add('resizing-trans')
})

function triggerMemosRedraw() {
  document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
    const pageNum = parseInt(wrapper.dataset.page, 10)
    if (!isNaN(pageNum)) {
      const allMemos = loadMemos(state.sessionId)
      const pageMemos = allMemos[`page_${pageNum}`] || []
      pageMemos.forEach(memo => {
        const sentenceEl = wrapper.querySelector(`.pdf-sentence[data-sentence-idx="${memo.sentenceIdx}"]`)
        if (sentenceEl) {
          updateMemoConnectorLine(wrapper, memo, sentenceEl)
        }
      })
    }
  })
}

document.addEventListener('mousemove', (e) => {
  if (!isResizingTrans) return
  // 우측에 배치되어 있으므로 오른쪽으로 당기면(dx가 양수) 커지고, 왼쪽으로 밀면 작아짐
  const dx = e.clientX - resizerStartX
  updateTransPaneWidth(resizerStartWidth + dx)
  triggerMemosRedraw()
})

document.addEventListener('mouseup', () => {
  if (isResizingTrans) {
    isResizingTrans = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.body.classList.remove('resizing-trans')
  }
})

window.addEventListener('resize', triggerMemosRedraw)

// 인라인 접기/펴기 버튼 클릭 이벤트 바인딩 (이벤트 위임)
viewerScrollContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.trans-collapse-btn')
  if (!btn) return
  e.stopPropagation()
  
  isTransPaneCollapsed = !isTransPaneCollapsed
  document.body.classList.toggle('collapse-translation', isTransPaneCollapsed)
  localStorage.setItem('trans-pane-collapsed', isTransPaneCollapsed)
  
  const leftChevron = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`
  const rightChevron = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`
  
  // 모든 페이지 쌍의 인라인 화살표 상태 동기화
  document.querySelectorAll('.trans-collapse-btn').forEach(b => {
    b.innerHTML = isTransPaneCollapsed ? rightChevron : leftChevron
    b.title = isTransPaneCollapsed ? '번역 창 펴기' : '번역 창 접기'
  })
  
  showToast(isTransPaneCollapsed ? '번역 창이 접혔습니다.' : '번역 창이 펼쳐졌습니다.', 'info')
});

// 초기 로드 시 localStorage 상태 복원 및 초기화 실행
(function initTransPaneControls() {
  const savedCollapsed = localStorage.getItem('trans-pane-collapsed') === 'true'
  const savedWidth = parseInt(localStorage.getItem('trans-pane-width')) || 620

  updateTransPaneWidth(savedWidth)
  
  if (savedCollapsed) {
    isTransPaneCollapsed = true
    document.body.classList.add('collapse-translation')
  }
})()

// ── 해시 라우팅 및 뒤로가기 제어 ──────────────────────
async function handleRouting() {
  try {
    const hash = location.hash
    console.log("[Router] handleRouting triggered. Current hash:", hash)
    
    if (hash.startsWith('#viewer?id=')) {
      const docId = hash.split('?id=')[1]
      if (docId) {
        if (state.sessionId === docId && viewerScreen.classList.contains('active')) {
          console.log("[Router] Viewer already active for document:", docId)
          return
        }
        console.log("[Router] Routing to viewer for document:", docId)
        const doc = await fetchLibraryDoc(docId)
        if (doc) {
          await openFromLibrary(doc, false)
          return
        }
      }
      location.hash = 'library'
    } else {
      console.log("[Router] Routing to Library screen. Viewer active:", viewerScreen.classList.contains('active'), "Library active:", libraryScreen.classList.contains('active'))
      if (viewerScreen.classList.contains('active') || !libraryScreen.classList.contains('active')) {
        await showLibraryScreen(false)
      }
    }
  } catch (err) {
    console.error("[Router] Error in handleRouting:", err)
  }
}

window.addEventListener('popstate', (e) => {
  console.log("[Router] popstate fired. state:", e.state)
  handleRouting()
})

window.addEventListener('hashchange', () => {
  console.log("[Router] hashchange fired")
  handleRouting()
})

// ── 논문 목차(Outline) 제어 및 바인딩 ─────────────────
async function loadPDFOutline() {
  if (!outlineContent) return
  outlineContent.innerHTML = '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:20px;">목차 로드 중...</div>'
  
  try {
    const outline = await getPDFOutline()
    outlineContent.innerHTML = ''
    
    if (!outline || outline.length === 0) {
      // 목차 메타데이터가 존재하지 않는 경우를 대비한 전체 페이지 리스트 폴백(Fallback) 렌더링
      const infoMsg = document.createElement('div')
      infoMsg.style.cssText = 'font-size:11px; color:var(--text-muted); padding:4px 10px 12px; border-bottom:1px dashed var(--border); margin-bottom:8px; line-height:1.4;'
      infoMsg.textContent = '💡 본 PDF에 목차(TOC) 정보가 존재하지 않아, 전체 페이지 리스트를 대신 제공합니다.'
      outlineContent.appendChild(infoMsg)
      
      for (let p = 1; p <= state.totalPages; p++) {
        const div = document.createElement('div')
        div.className = 'outline-item depth-0'
        const iconSvg = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="opacity:0.6; margin-right:8px; flex-shrink:0;"><circle cx="12" cy="12" r="8"/></svg>`
        div.innerHTML = `${iconSvg}<span>${p} 페이지</span>`
        div.addEventListener('click', () => {
          scrollToPage(viewerScrollContainer, p)
        })
        div.title = `${p}페이지로 이동`
        outlineContent.appendChild(div)
      }
      return
    }
    
    function renderTree(items, depth = 0) {
      items.forEach(item => {
        const div = document.createElement('div')
        div.className = `outline-item depth-${depth}`
        const iconSvg = depth === 0 
          ? `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="opacity:0.6; margin-right:8px; flex-shrink:0;"><circle cx="12" cy="12" r="8"/></svg>`
          : `<svg width="5" height="5" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.4; margin-right:8px; flex-shrink:0; margin-left:4px;"><circle cx="12" cy="12" r="10"/></svg>`
        div.innerHTML = `${iconSvg}<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.title)}</span>`
        if (item.pageNum) {
          div.addEventListener('click', () => {
            scrollToPage(viewerScrollContainer, item.pageNum)
          })
          div.title = `${item.pageNum}페이지로 이동`
        }
        outlineContent.appendChild(div)
        if (item.items && item.items.length > 0) {
          renderTree(item.items, depth + 1)
        }
      })
    }
    
    renderTree(outline)
  } catch (err) {
    console.error("Outline load error:", err)
    outlineContent.innerHTML = '<div style="font-size:12px; color:var(--error); text-align:center; padding:20px;">목차 로드 실패</div>'
  }
}

function hideOutlineSidebar() {
  if (outlineSidebar) {
    outlineSidebar.classList.add('hidden')
    if (outlineToggleBtn) outlineToggleBtn.classList.remove('active')
  }
}

function showOutlineSidebar() {
  if (outlineSidebar) {
    outlineSidebar.classList.remove('hidden')
    if (outlineToggleBtn) outlineToggleBtn.classList.add('active')
  }
}

// 목차 이벤트 바인딩
if (outlineToggleBtn) {
  outlineToggleBtn.addEventListener('click', () => {
    console.log("[Outline] Toggle button clicked. Sidebar:", outlineSidebar, "ToggleBtn:", outlineToggleBtn)
    if (!outlineSidebar) {
      showToast('목차 사이드바를 찾을 수 없습니다.', 'error')
      return
    }
    if (outlineSidebar.classList.contains('hidden')) {
      showOutlineSidebar()
    } else {
      hideOutlineSidebar()
    }
  })
} else {
  console.error("[Outline] outlineToggleBtn is null!")
}
if (outlineCloseBtn) {
  outlineCloseBtn.addEventListener('click', hideOutlineSidebar)
}

// ── 번역 문장 더블클릭 수동 수정 (Inline Edit) ──────
if (viewerScrollContainer) {
  viewerScrollContainer.addEventListener('dblclick', (e) => {
    const span = e.target.closest('.trans-sentence')
    if (!span) return
    
    if (span.getAttribute('contenteditable') === 'true') return
    
    e.preventDefault()
    e.stopPropagation()
    
    const pageNum = parseInt(span.dataset.page)
    const sentenceIdx = parseInt(span.dataset.sentenceIdx)
    if (isNaN(pageNum) || isNaN(sentenceIdx)) return
    
    const originalText = span.textContent.trim()
    span.contentEditable = true
    span.classList.add('inline-editing')
    span.focus()
    
    // 포커스 시 텍스트 맨 뒤에 캐럿 배치
    const range = document.createRange()
    range.selectNodeContents(span)
    range.collapse(false)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    
    let finished = false
    
    async function finishEdit(commit) {
      if (finished) return
      finished = true
      span.contentEditable = false
      span.classList.remove('inline-editing')
      
      if (commit) {
        const newText = span.textContent.trim()
        if (newText && newText !== originalText) {
          try {
            // 1. 상태 업데이트
            const oldText = state.translationSentences[pageNum][sentenceIdx].trans
            state.translationSentences[pageNum][sentenceIdx].trans = newText
            
            // 캐시 텍스트 치환
            if (state.translationCache[pageNum]) {
              state.translationCache[pageNum] = state.translationCache[pageNum].replace(oldText, newText)
            }
            
            // 2. 백엔드 API 연동 저장
            const payload = {
              translation: state.translationCache[pageNum],
              sentences: state.translationSentences[pageNum]
            }
            await updateLibraryTranslation(state.sessionId, pageNum, payload, getTranslationOptions())
            
            showToast('문장 번역이 수정되어 저장되었습니다.', 'success')
          } catch (err) {
            console.error("Failed to save edited translation:", err)
            showToast('번역 수정 저장 실패', 'error')
            span.textContent = originalText
          }
        } else {
          span.textContent = originalText
        }
      } else {
        span.textContent = originalText
      }
    }
    
    span.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault()
        finishEdit(true)
      } else if (evt.key === 'Escape') {
        evt.preventDefault()
        finishEdit(false)
      }
    })
    
    span.addEventListener('blur', () => {
      finishEdit(true)
    })
  })
}

