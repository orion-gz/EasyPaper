import './style.css'
import './styles/shell.css'
import './styles/library-page.css'
import './styles/research-graph.css'
import "./styles/document-modes.css"
import { marked } from 'marked'
import { createWorkspaceModeController } from "./workspaceModeController.js"
import { getModeSetting, normalizeSettingsMode, setModeSetting } from './modeSettings.js'
import { parseStructuredVocabulary, renderStructuredVocabulary } from "./vocabularyView.js"
import { defaultDocumentType, loadDocumentTypeOptions, saveDocumentTypeOptions, CURRENT_ONBOARDING_VERSION, ONBOARDING_VERSION_KEY } from "./documentModes.js"
import DOMPurify from 'dompurify'
import { uploadPDF, checkHealth, streamTranslation, getJobStatus, getPageTranslation, loginAPI, logoutAPI, checkAuthAPI, changeCredentialsAPI, getSkipLoginAPI, setSkipLoginAPI, getSystemSettingsAPI, saveSystemSettingsAPI, restartJobAPI, streamPullModelAPI, deleteModelAPI, streamChatAPI, clearTranslationCacheAPI, clearPagesCacheAPI, clearSingleDocCacheAPI, getChatHistoryAPI, cancelJobAPI, triggerSystemUpdateAPI, checkForUpdateAPI, streamPageInsightAPI, getOllamaStatusAPI, streamInstallOllamaAPI, fetchCliAvailability, getUpdateCheckConfigAPI, setUpdateCheckConfigAPI, getPostUpdateNoticeAPI, streamCompareChatAPI, getCompareChatHistoryAPI, getFullChangelogAPI, getChatSessionsAPI, getCompareChatSessionsAPI, getSuggestedQuestionsAPI, fetchPdfParsersInfoAPI, installPdfParserAPI, uninstallPdfParserAPI, fetchDocumentTypesAPI, getWorkspaceSettingsAPI, patchWorkspaceSettingsAPI, patchDocumentClassificationAPI, estimateInsightJobAPI, startInsightJobAPI, getInsightJobStatusAPI, cancelInsightJobAPI, getLanguagesAPI, getLanguageSettingsAPI, saveLanguageSettingsAPI, patchDocumentLanguagesAPI, patchDocumentProcessingPolicyAPI, retryDocumentTaskAPI, createReparsePreviewAPI, getReparsePreviewAPI, applyReparsePreviewAPI } from './api.js'
import { loadPDF, renderScrollView, scrollToPage, reRenderAll, getScale, getTotalPages, getPDFOutline, renderFigureCrop } from './pdfViewer.js'
import { fetchLibrary, fetchLibraryDoc, fetchLibraryFolders, createLibraryFolder, updateLibraryFolder, deleteLibraryFolder, moveLibraryDocuments, deleteLibraryDoc, fetchLibraryTranslation, fetchLibraryDocImages, updateLibraryDocMetadata, updateLibraryDocTitle, updateLibraryTranslation, fetchLibraryTrash, restoreLibraryDoc, emptyLibraryTrash, deleteLibraryDocPermanently, searchLibrary, exportAnnotatedPdf, fetchLibraryReferences, resolveLibraryReference, fetchPrimer, regeneratePrimer, fetchLibraryBibliography, fetchLibraryAnnotations, putLibraryAnnotations, fetchLibraryMemos, putLibraryMemos, fetchLibraryGraph, fetchGraphNodeQuestions, searchGraphNodes, fetchReadingRecommendations, fetchCachedReadingRecommendations, fetchLibraryHeatmapMatrix, sendReadingHeartbeat, fetchPaperTagOntology, updatePaperTags, reclassifyPaperTags } from './library.js'
import { icon } from './icons.js'
import { formatTranslationHtml, applyKatexToElement, linkPageCitations } from './textFormat.js'
import { createSelectionRect, resolveDragSelection } from './library-selection.js'
import { globalAnalyticsTracker } from './readingAnalytics.js'
import { globalReadingTimeActivityTracker } from './readingTimeActivity.js'
import { compareDocsByLastRead } from './readPages.js'
import { buildScholarSearchUrl, extractCitationTitle } from './citationSearch.js'
import { changeLocale, getLocale, initI18n, loadFeatureNamespaces, loadNamespaces, t } from './i18n.js'
import { saveUserLanguagePreferences, saveDocumentLanguageOverride } from './languagePreferences.js'
import { canRetryTranslationTask, isTranslationTaskRunning, shouldRetryFailedTranslationTask } from './translationTaskState.js'

const i18nReady = initI18n()


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
const COMPARE_MIN_DOCS = 2
const COMPARE_MAX_DOCS = 5

const state = {
  currentLibraryTab: 'archive', // 'archive'(보관함) / 'trash'(휴지통) - Library 페이지 내부 상태
  previousLibraryTab: 'archive', // 휴지통 진입 전 이전 탭 기억용
  currentWorkspacePage: 'dashboard', // 'dashboard'/'library'/'history'/'chats'/'notes'/'graph' - 사이드바 최상위 페이지 상태
  currentDocId: null,
  currentDocMetadata: {},
  currentDocumentMode: "research",
  currentDocumentType: "research_paper",
  sourceLanguage: "auto",
  detectedSourceLanguage: "und",
  preferredTargetLanguage: null,
  processingPolicy: "inherit",
  processingStatus: null,
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
  translationTaskId: null,     // 현재 영속 번역 작업 ID
  translationTaskStatus: null, // queued/running/partial_failed/...
  username: 'admin',           // 현재 로그인한 사용자명 저장
  chatHistory: [],             // AI 채팅 히스토리
  chatActiveStream: null,      // 현재 활성화된 채팅 스트림 abort 함수
  chatCurrentText: '',         // 현재 스트리밍 답변 텍스트 임시 저장
  availableOllamaModels: [],   // Ollama에서 설치된 모델 목록
  quotedText: null,            // AI 질문 시 인용구 보관용
  documentImages: [],          // 문서 내 이미지 좌표 목록
  referenceMap: {},            // 참고문헌 번호 -> 원문 텍스트 맵
  citationStyle: null,         // 'number' | 'author-year' | 'mixed' | null(미감지) - detectCitationStyle 결과
  referencesHeaderPageNum: null, // References/참고문헌 섹션이 시작되는 페이지 번호(감지 전엔 null)
  quotedImage: null,           // AI 질문 시 인용 이미지 보관용 (Base64)
  quotedImagePage: null,       // AI 질문 시 인용 이미지의 페이지 번호
  activeHighlightColor: '#eab308', // 기본 하이라이트 노란색
  activeUnderlineColor: '#ef4444',  // 기본 밑줄 빨간색
  isCropMode: false,           // 영역 캡처 모드 여부
  isSelectionDragging: false,   // 마우스 드래그 선택 중인지 여부
  pdfPageSentences: {},        // pageNum → sentenceRanges 보관용
  pdfPageElements: {},         // pageNum → elRanges 보관용
  cliAvailability: { antigravity: true, claude_code: true, codex: true },
  // PDF 원문 위에 마우스를 올려두면(드래그 없이) 700ms 뒤 자동으로 문장을 선택하고
  // 선택 메뉴(툴팁)를 띄우는 기능을 끌지 여부. true면 드래그로 직접 선택할 때만 뜬다.
  disableHoverTooltip: localStorage.getItem('easypaper_disable_hover_tooltip') === 'true',
  // 마지막으로 읽던 페이지를 자동 저장하고, 문서를 다시 열 때 그 위치로 이동하는
  // 책갈피 기능을 끌지 여부. true면 항상 1페이지부터 시작한다.
  disableBookmark: localStorage.getItem('easypaper_disable_bookmark') === 'true',
  // 번역 패널의 "키워드/단어", "요약" 탭을 끌지 여부(기본값 켜짐 - 다른 편의
  // 설정과 달리 토큰을 추가로 소모하는 기능이라 설정에서 끌 수 있게 함).
  disableInsights: getModeSetting('disableInsights', 'research'),
  // 본문 인용([1], (Smith, 2020) 등) 표기 호버 미리보기를 끌지 여부.
  disableCitationOverlay: getModeSetting('disableCitationOverlay', 'research'),
  // Figure/Table/수식 참조 표기 호버 미리보기를 끌지 여부.
  disableFigureOverlay: getModeSetting('disableFigureOverlay', 'research'),
  // 논문을 처음 열 때 뜨는 "읽기 전 브리핑" 게이팅 모달을 끌지 여부. 꺼도
  // 뷰어 툴바 버튼으로는 언제든 다시 열어볼 수 있다.
  disablePrimer: getModeSetting('disablePrimer', 'research'),
  // 아래로 스크롤하면 상단 툴바를 자동으로 숨기고 위로 스크롤하면 다시 보여줄지
  // 여부. 다른 편의 설정과 달리 새로 추가하는 화면 동작이라 기본값은 꺼짐(false).
  toolbarAutoHide: localStorage.getItem('easypaper_toolbar_autohide') === 'true',
  // pageNum_kind(예: "3_keywords") → 생성된 텍스트. 탭 재방문 시 재요청 방지용 캐시.
  pageInsightCache: {}
}

// ── DOM 참조 ──────────────────────────────────────
const $ = (id) => document.getElementById(id)

let languageCatalog = []

function populateLanguageControls(settings = {}) {
  const sourceSelect = $('setting-source-lang')
  const targetSelect = $('setting-target-lang')
  const sourceValue = settings.default_source_language || localStorage.getItem('easypaper_default_source_language') || 'auto'
  const targetValue = settings.target_language || getModeSetting('targetLang', 'research')
  const options = languageCatalog.map(({ code, translation_key: key }) =>
    '<option value="' + code + '">' + t('common:' + key) + '</option>'
  ).join('')
  if (sourceSelect) {
    sourceSelect.innerHTML = '<option value="auto">' + t('common:language.auto') + '</option>' + options
    sourceSelect.value = sourceValue
  }
  if (targetSelect) {
    targetSelect.innerHTML = options
    targetSelect.value = targetValue
  }
  const documentSource = $('document-source-lang')
  const documentTarget = $('document-target-lang')
  if (documentSource) {
    documentSource.innerHTML = '<option value="auto">' + t('common:language.auto') + '</option>' + options
    documentSource.value = state.sourceLanguage || 'auto'
  }
  if (documentTarget) {
    documentTarget.innerHTML = options
    documentTarget.value = state.preferredTargetLanguage || targetValue
  }
  renderDocumentLanguageStatus()
  for (const id of ['login-ui-locale', 'onboarding-ui-locale', 'setting-ui-locale']) {
    const select = $(id)
    if (select) select.value = getLocale()
  }
}

function languageDisplayName(code) {
  return t('common:language.' + code, { fallback: code })
}

function renderDocumentLanguageStatus() {
  const status = $('document-language-status')
  const controls = $('document-language-controls')
  if (!status || !controls) return
  controls.hidden = !state.sessionId
  if (!state.sessionId) return
  const source = state.sourceLanguage === 'auto' ? state.detectedSourceLanguage : state.sourceLanguage
  const target = state.preferredTargetLanguage || getModeSetting('targetLang', state.currentDocumentMode)
  if (source === 'und') status.textContent = t('viewer:source.undetermined')
  else if (source === 'mul') status.textContent = t('viewer:source.multiple')
  else if (!languageCatalog.some(item => item.code === source)) {
    status.textContent = t('viewer:source.unsupportedCode', { language: source })
  } else if (source === target) {
    status.textContent = t('viewer:translation.sameLanguage')
  } else status.textContent = t('viewer:translation.pair', { source: languageDisplayName(source), target: languageDisplayName(target) })
}

async function persistDocumentLanguageOverride() {
  if (!state.sessionId) return
  const source = $('document-source-lang')?.value || state.sourceLanguage || 'auto'
  const target = $('document-target-lang')?.value || state.preferredTargetLanguage || getModeSetting('targetLang', state.currentDocumentMode)
  const saved = await saveDocumentLanguageOverride(
    state.sessionId, { sourceLanguage: source, targetLanguage: target }, patchDocumentLanguagesAPI,
  )
  state.sourceLanguage = saved.source_language
  state.preferredTargetLanguage = saved.preferred_target_language
  state.pageInsightCache = {}
  renderDocumentLanguageStatus()
  showToast(t('viewer:language.saved'), 'success')
}

async function persistLanguagePreferences() {
  const source = $('setting-source-lang')?.value || localStorage.getItem('easypaper_default_source_language') || 'auto'
  const target = $('setting-target-lang')?.value || getModeSetting('targetLang', 'research')
  const saved = await saveUserLanguagePreferences(
    { uiLocale: getLocale(), sourceLanguage: source, targetLanguage: target },
    { saveSettings: saveLanguageSettingsAPI, storage: localStorage },
  )
  showToast(t('settings:saved'), 'success')
  return saved
}

async function syncLanguageSettingsFromServer() {
  await loadNamespaces(['settings', 'errors'])
  const [catalog, settings] = await Promise.all([getLanguagesAPI(), getLanguageSettingsAPI()])
  languageCatalog = catalog.languages || []
  if (settings.ui_locale) await changeLocale(settings.ui_locale)
  localStorage.setItem('easypaper_default_source_language', settings.default_source_language || 'auto')
  if (settings.target_language) {
    setModeSetting('targetLang', 'research', settings.target_language)
    setModeSetting('targetLang', 'general', settings.target_language)
  }
  populateLanguageControls(settings)
}

async function handleLocaleSelector(event) {
  await changeLocale(event.target.value)
  populateLanguageControls()
  if (state.username && ['setting-ui-locale', 'onboarding-ui-locale'].includes(event.target.id)) await persistLanguagePreferences()
}


// ── 모달(.modal-overlay) 표시/숨김 공용 헬퍼 ──────────────────────
// `.hidden`(display:none)과 opacity/transform 트랜지션을 같은 클래스 토글로
// 동시에 바꾸면, 브라우저가 "opacity:0"인 시작 프레임을 그릴 기회가 없어
// 트랜지션 없이 그냥 툭 튀어나오거나 사라지는 깜빡임이 생긴다. display 전환과
// opacity/transform 전환을 두 단계(reflow 강제 → 다음 프레임에 클래스 적용)로
// 분리해 트랜지션이 실제로 재생되게 한다.
const modalTriggerElements = new WeakMap()
const modalCloseTimers = new WeakMap()
const modalFocusableSelector = [
  '[autofocus]',
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function openOverlayModal(modal) {
  if (!modal) return
  if (!modal.hasAttribute('role')) modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  const closeTimer = modalCloseTimers.get(modal)
  if (closeTimer !== undefined) {
    window.clearTimeout(closeTimer)
    modalCloseTimers.delete(modal)
  }
  const trigger = document.activeElement
  if (trigger instanceof HTMLElement && trigger !== document.body) {
    modalTriggerElements.set(modal, trigger)
  }
  modal.classList.remove('hidden')
  void modal.offsetWidth // 강제 리플로우: display:none 해제를 먼저 확정시킨다
  modal.classList.add('is-visible')
  window.requestAnimationFrame(() => {
    if (!modal.classList.contains('is-visible')) return
    const focusTarget = modal.querySelector(modalFocusableSelector)
    if (focusTarget instanceof HTMLElement) focusTarget.focus()
  })
}
function closeOverlayModal(modal) {
  if (!modal) return
  const previousTimer = modalCloseTimers.get(modal)
  if (previousTimer !== undefined) window.clearTimeout(previousTimer)
  modal.classList.remove('is-visible')
  const closeTimer = window.setTimeout(() => {
    modalCloseTimers.delete(modal)
    if (modal.classList.contains('is-visible')) return
    modal.classList.add('hidden')
    const trigger = modalTriggerElements.get(modal)
    if (trigger?.isConnected) trigger.focus()
    modalTriggerElements.delete(modal)
  }, 300) // CSS 트랜지션(0.3s) 종료 후 display:none
  modalCloseTimers.set(modal, closeTimer)
}

// 열린 모달 안에서 Tab 순환을 유지한다. Escape 닫기는 각 모달의 기존
// 취소/닫기 로직이 담당하므로 데이터 상태 변경 경로를 우회하지 않는다.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return
  const openModals = Array.from(document.querySelectorAll('.modal-overlay.is-visible:not(.hidden)'))
  const modal = openModals.at(-1)
  if (!modal) return
  const focusable = Array.from(modal.querySelectorAll(modalFocusableSelector))
    .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true')
  if (!focusable.length) { event.preventDefault(); modal.focus(); return }
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
})

function announceA11y(message) {
  if (!a11yLiveRegion || !message) return
  a11yLiveRegion.textContent = ''
  window.requestAnimationFrame(() => { a11yLiveRegion.textContent = message })
}

const loginScreen       = $('login-screen')
const loginForm         = $('login-form')
const loginUsername     = $('login-username')
const loginPassword     = $('login-password')
const loginRememberCheckbox = $('login-remember-checkbox')
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
const settingSkipLoginCheckbox = $('setting-skip-login-checkbox')

// 첫 실행 온보딩은 완료하지 않은 사용자에게만 별도 청크로 로드한다.
let onboardingController = null

async function maybeShowOnboarding() {
  if (Number(localStorage.getItem(ONBOARDING_VERSION_KEY) || 0) >= CURRENT_ONBOARDING_VERSION) return
  if (!onboardingController) {
    const { createOnboarding } = await import('./onboarding.js')
    onboardingController = createOnboarding({
      openOverlayModal, closeOverlayModal, showToast, escapeHtml,
      providerConfig: PROVIDER_CONFIG,
      viewerTransPicker, settingDefaultAiPicker, settingTransPicker,
      chatSidebarPicker, settingChatPicker, settingAnalysisPicker, settingLibraryPicker,
      onWorkspaceSelected: async (mode) => {
        await workspaceModeController.markOnboardingComplete(mode)
        await patchWorkspaceSettingsAPI({ onboarding_version: CURRENT_ONBOARDING_VERSION, preferred_workspace_mode: mode })
      },
    })
  }
  onboardingController.maybeShowOnboarding()
}

// 탭 버튼 및 컨텐츠 영역
const tabBtns           = document.querySelectorAll('.tab-btn')
const tabPanes          = document.querySelectorAll('.tab-pane')

// 설정 폼 및 엘리먼트
const settingsModeTitle = $('settings-mode-title')
const settingsModeBadge = $('settings-mode-badge')
const settingsModeDescription = $('settings-mode-description')
const settingsTranslationHeading = $('settings-translation-heading')
const settingsAutomationTitle = $('settings-automation-title')
const settingsKeywordsLabel = $('settings-keywords-label')
const settingsKeywordsDescription = $('settings-keywords-description')
const settingsReadingToolsLabel = $('settings-reading-tools-label')
const settingUiLocale = $('setting-ui-locale')
const settingSourceLang = $('setting-source-lang')
const settingsThemeScope = $('settings-theme-scope')
const settingTargetLang   = $('setting-target-lang')
const settingTransStyle   = $('setting-trans-style')
const settingTranslationMode = $('setting-translation-mode')
const settingTranslationModeScope = $('setting-translation-mode-scope')
let settingsTranslationModeContext = 'research'
const settingIgnoreMath   = $('setting-ignore-math')
const settingIgnoreTable  = $('setting-ignore-table')
const settingIgnoreRefs   = $('setting-ignore-refs')
const settingDefaultZoom  = $('setting-default-zoom')
const settingToolbarPosition = $('setting-toolbar-position')
const settingDisableHoverTooltip = $('setting-disable-hover-tooltip')
const settingDisableBookmark = $('setting-disable-bookmark')
const settingDisableInsights = $('setting-disable-insights')
const settingDisableCitationOverlay = $('setting-disable-citation-overlay')
const settingDisableFigureOverlay = $('setting-disable-figure-overlay')
const settingDisablePrimer = $('setting-disable-primer')
const settingToolbarAutoHide = $('setting-toolbar-autohide')
const settingAutoGenerateKeywords = $('setting-auto-generate-keywords')
const settingAutoGenerateSummaries = $('setting-auto-generate-summaries')

for (const id of ['login-ui-locale', 'onboarding-ui-locale', 'setting-ui-locale']) {
  const selector = $(id)
  if (selector) selector.addEventListener('change', (event) => handleLocaleSelector(event).catch(console.error))
}
document.addEventListener('easypaper:locale-changed', () => { if (languageCatalog.length) populateLanguageControls(); renderDocumentLanguageStatus() })
i18nReady.then(() => populateLanguageControls()).catch(console.error)
if (settingSourceLang) settingSourceLang.addEventListener('change', () => persistLanguagePreferences().catch(console.error))
if (settingTargetLang) settingTargetLang.addEventListener('change', () => persistLanguagePreferences().catch(console.error))
for (const id of ['document-source-lang', 'document-target-lang']) {
  $(id)?.addEventListener('change', () => persistDocumentLanguageOverride().catch(error => showToast(error.message, 'error')))
}
const viewerTopbar = $('viewer-topbar')
const clearCacheBtn       = $('clear-cache-btn')
const clearPagesCacheBtn  = $('clear-pages-cache-btn')
const settingAccentSwatches = $('setting-accent-swatches')
const settingAccentPicker   = $('setting-accent-picker')
const settingAccentHex      = $('setting-accent-hex')
const settingAccentResetBtn = $('setting-accent-reset-btn')

const settingOllamaHost    = $('setting-ollama-host')
const settingOpenAIKey     = $('setting-openai-key')
const settingGeminiKey     = $('setting-gemini-key')
const settingClaudeKey     = $('setting-claude-key')
const settingOpenAlexMailto = $('setting-openalex-mailto')
const settingTransSameAsDefault = $('setting-trans-same-as-default')
const settingAnalysisSameAsDefault = $('setting-analysis-same-as-default')
const settingChatSameAsDefault = $('setting-chat-same-as-default')
const settingLibrarySameAsDefault = $('setting-library-same-as-default')

// (provider/model selects are now custom ProviderModelPicker instances – see below)

const settingPullModelName = $('setting-pull-model-name')
const settingPullModelBtn  = $('setting-pull-model-btn')
const pullModelProgressArea = $('pull-model-progress-area')
const pullStatusText       = $('pull-status-text')
const pullPctText          = $('pull-pct-text')
const pullProgressBar      = $('pull-progress-bar')
const pullModelSection     = $('pull-model-section')

const ollamaInstallSection  = $('ollama-install-section')
const ollamaInstallNotLocal = $('ollama-install-not-local')
const ollamaInstallPrompt   = $('ollama-install-prompt')
const ollamaInstallBtn      = $('ollama-install-btn')
const ollamaInstallProgressArea = $('ollama-install-progress-area')
const ollamaInstallLog      = $('ollama-install-log')

const libraryScreen     = $('library-screen')
const viewerScreen      = $('viewer-screen')
const fileInput         = $('file-input')
const libUploadBtn      = $('lib-upload-btn')
const libraryGrid       = $('library-grid')
const libraryCategoryFilters = $('library-category-filters')
const libraryCategoryFilterToggle = $('library-category-filter-toggle')
const librarySearchInput = $('library-search-input')
const librarySearchClearBtn = $('library-search-clear-btn')
const librarySearchStatus = $('library-search-status')
const libraryFilterRow  = $('library-filter-row')
const libraryCountBadge = $('library-count-badge')
const libTabTrash       = $('lib-tab-trash')
const libEmptyTrashBtn  = $('lib-empty-trash-btn')
const librarySearchBox  = $('library-search-box')
const libraryChatSection = $('library-chat-section')
const chatSubtabAssistant = $('chat-subtab-assistant')
const chatSubtabCompare   = $('chat-subtab-compare')
const chatSessionList     = $('chat-session-list')
const libraryAnnotationsSection = $('library-annotations-section')
const annotationSubtabMemo      = $('annotation-subtab-memo')
const annotationSubtabHighlight = $('annotation-subtab-highlight')
const annotationSubtabUnderline = $('annotation-subtab-underline')
const annotationList            = $('annotation-list')
const libraryGraphSection       = $('library-graph-section')
const libraryGraphRow           = $('library-graph-row')
const libraryGraphCanvas        = $('library-graph-canvas')
const libraryGraphResizer       = $('library-graph-resizer')
const libraryGraphDetailPanel   = $('library-graph-detail-panel')
const libraryGraphPendingBanner = $('library-graph-pending-banner')
const libraryGraphSearchInput   = $('library-graph-search-input')
const libraryGraphViewToggleGraph     = $('library-graph-view-toggle-graph')
const libraryGraphViewToggleHeatmap   = $('library-graph-view-toggle-heatmap')
const libraryGraphView         = $('library-graph-view')
const libraryHeatmapView       = $('library-heatmap-view')
const libraryHeatmapList       = $('library-heatmap-list')
const libraryRecommendationsBtn  = $('library-recommendations-btn')
const libraryRecommendationsList = $('library-recommendations-list')

// ── 워크스페이스 셸(사이드바/탑네비/페이지 라우팅) ────────────────
const appSidebar          = $('app-sidebar')
const sidebarToggleBtn    = $('sidebar-toggle-btn')
const sidebarNav          = $('app-sidebar-nav')
const sidebarSettingsBtn  = $('sidebar-settings-btn')
const sidebarLogoutBtn    = $('sidebar-logout-btn')
const workspacePageTitle  = $('workspace-page-title')
const workspaceSearchInput = $('workspace-search-input')
const pageOutlet          = $('page-outlet')
const workspaceLibraryState = {
  research: { tab: 'archive', category: 'ALL', status: 'all', search: '' },
  general: { tab: 'archive', category: 'ALL', status: 'all', search: '' },
}
let lastWorkspaceMode = 'research'
const workspaceModeController = createWorkspaceModeController({
  fetchDocumentTypes: fetchDocumentTypesAPI,
  getWorkspaceSettings: getWorkspaceSettingsAPI,
  patchWorkspaceSettings: patchWorkspaceSettingsAPI,
  showToast,
  onModeChange: async (mode) => {
    const outgoing = workspaceLibraryState[lastWorkspaceMode]
    outgoing.tab = state.currentLibraryTab
    outgoing.category = activeCategoryFilter
    outgoing.status = activeStatusFilter
    outgoing.search = state.currentWorkspacePage === 'library'
      ? (librarySearchInput?.value || '')
      : (workspaceSearchInput?.value || outgoing.search)

    const incoming = workspaceLibraryState[mode]
    lastWorkspaceMode = mode
    applyModeTheme(mode)
    if (settingsModal && !settingsModal.classList.contains('hidden')) {
      syncModeSettings(mode)
    }
    state.currentLibraryTab = incoming.tab
    activeCategoryFilter = incoming.category
    activeStatusFilter = incoming.status
    if (workspaceSearchInput) workspaceSearchInput.value = incoming.search
    // 모드 전환은 열려 있던 문서를 재분류하지 않고 대상 워크스페이스 홈으로 이동한다.
    state.currentWorkspacePage = 'dashboard'
    if (libraryScreen?.classList.contains("active")) {
      await showWorkspacePage('dashboard', { pushState: false })
    }
  },
})

const libCompareToggleBtn   = $('lib-compare-toggle-btn')
const compareSelectBar      = $('compare-select-bar')
const compareSelectCount    = $('compare-select-count')
const compareSelectCancelBtn = $('compare-select-cancel-btn')
const compareSelectStartBtn = $('compare-select-start-btn')

const compareScreen        = $('compare-screen')
const compareBackBtn       = $('compare-back-btn')
const compareDocChips      = $('compare-doc-chips')
const compareChatMessages  = $('compare-chat-messages')
const compareChatInput     = $('compare-chat-input')
const compareChatSendBtn   = $('compare-chat-send-btn')

// ── 단일 논문 대화 드로어 (AI Chats 목록에서 뷰어 없이 여는 우측 슬라이드 패널) ──
const chatDrawerOverlayEl  = $('chat-drawer-overlay')
const chatDrawerEl         = $('chat-drawer')
const chatDrawerCloseBtn   = $('chat-drawer-close-btn')
const chatDrawerTitle      = $('chat-drawer-title')
const chatDrawerViewerBtn  = $('chat-drawer-viewer-btn')
const chatDrawerMessages   = $('chat-drawer-messages')
const chatDrawerInput      = $('chat-drawer-input')
const chatDrawerSendBtn    = $('chat-drawer-send-btn')

const docPreviewOverlay  = $('doc-preview-overlay')
const docPreviewClose    = $('doc-preview-close')
const docPreviewCoverImg = $('doc-preview-cover-img')
const docPreviewTitle    = $('doc-preview-title')
const docPreviewPages    = $('doc-preview-pages')
const docPreviewTags     = $('doc-preview-tags')
const docPreviewMeta     = $('doc-preview-meta')
const docPreviewOpenBtn  = $('doc-preview-open-btn')

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
const viewerDocumentTypeChip = $("viewer-document-type-chip")
const docTitleEditBtn   = $('doc-title-edit-btn')
const pageInput         = $('page-input')
const pageTotal         = $('page-total')
const zoomInBtn         = $('zoom-in-btn')
const zoomOutBtn        = $('zoom-out-btn')
const zoomLabel         = $('zoom-level')
const syncScrollBtn     = $('sync-scroll-btn')
const exportBtn         = $('export-btn')
const memosHideAllBtn   = $('memos-hide-all-btn')
const translationScopeBtn = $('translation-scope-btn')
const retranslateBtn    = $('retranslate-btn')
const captureAreaBtn    = $('capture-area-btn')
const cancelTransBtn    = $('cancel-trans-btn')
const resumeTransBtn    = $('resume-trans-btn')
// (viewer/chat pickers are now ProviderModelPicker instances – see below)
const backBtn           = $('back-btn')
const logoBtn           = $('logo-btn')
const viewerReadToggleBtn = $('viewer-read-toggle-btn')
const viewerScrollContainer = $('viewer-scroll-container')
const progressMini          = $('translation-progress-mini')
const progressMiniBar       = $('progress-mini-bar')
const progressMiniText      = $('progress-mini-text')
const toast                 = $('toast')
const a11yLiveRegion        = $('a11y-live-region')
const toolbarKebabBtn       = $('toolbar-kebab-btn')
const toolbarKebabMenu      = $('toolbar-kebab-menu')

// AI Chat Sidebar DOM references
const chatToggleBtn      = $('chat-toggle-btn')
const chatSidebar        = $('chat-sidebar')
const chatResizer        = $('chat-resizer')
const chatCloseBtn       = $('chat-close-btn')
const chatMessages       = $('chat-messages')
const floatingScrollNav  = $('floating-scroll-nav')
const outlineToggleBtn   = $('outline-toggle-btn')
const outlineSidebar     = $('outline-sidebar')
const outlineCloseBtn    = $('outline-close-btn')
const outlineContent     = $('outline-content')
const viewerPrimerBtn    = $('viewer-primer-btn')

// 읽기 전 브리핑(Reading Primer) 모달
const primerModal          = $('primer-modal')
const primerCloseBtn       = $('primer-close-btn')
const primerRegenerateBtn  = $('primer-regenerate-btn')
const primerLoading        = $('primer-loading')
const primerError          = $('primer-error')
const primerBody           = $('primer-body')
const primerTitle          = $('primer-title')
const primerEyebrow        = $('primer-eyebrow')
const primerHookSection    = $('primer-hook-section')
const primerHookText       = $('primer-hook-text')
const primerQuestionsSection = $('primer-questions-section')
const primerQuestions      = $('primer-questions')
const primerFigureSection  = $('primer-figure-section')
const primerFigureImg      = $('primer-figure-img')
const primerChecklistSection = $('primer-checklist-section')
const primerChecklist      = $('primer-checklist')
const primerTabsBar        = $('primer-tabs')
const primerLineageSection = $('primer-lineage-section')
const primerLineageText    = $('primer-lineage-text')
const primerFeynmanSection = $('primer-feynman-section')
const primerFeynmanText    = $('primer-feynman-text')
const primerExperimentSection = $('primer-experiment-section')
const primerExperimentFlow = $('primer-experiment-flow')
const primerGlossarySection = $('primer-glossary-section')
const primerGlossary       = $('primer-glossary')
const primerGraphSection   = $('primer-graph-section')
const primerGraph          = $('primer-graph')
const primerSkipBtn        = $('primer-skip-btn')
const primerContinueBtn    = $('primer-continue-btn')
const chatInput          = $('chat-input')
const chatInputExpandBtn = $('chat-input-expand-btn')
const chatSendBtn        = $('chat-send-btn')


// ── 설정 기본값 및 옵션 헬퍼 ──────────────────────────
function getActiveSettingsMode(documentMode = null) {
  if (documentMode) return normalizeSettingsMode(documentMode)
  if (state.sessionId) return normalizeSettingsMode(state.currentDocumentMode)
  return normalizeSettingsMode(document.body.dataset.workspaceMode)
}

function getTranslationOptions(documentMode = null) {
  const mode = getActiveSettingsMode(documentMode)
  return {
    targetLang: (state.sessionId && normalizeSettingsMode(state.currentDocumentMode) === mode && state.preferredTargetLanguage) || getModeSetting('targetLang', mode),
    style: getModeSetting('style', mode),
    ignoreMath: getModeSetting('ignoreMath', mode),
    ignoreTable: getModeSetting('ignoreTable', mode),
    ignoreRefs: getModeSetting('ignoreRefs', mode),
    sourceLang: state.sessionId && normalizeSettingsMode(state.currentDocumentMode) === mode
      ? (state.sourceLanguage === "auto" ? state.detectedSourceLanguage : state.sourceLanguage)
      : (localStorage.getItem('easypaper_default_source_language') || 'auto')
  }
}

function getKeywordMode(documentMode = null) {
  return getModeSetting('keywordMode', getActiveSettingsMode(documentMode))
}

function getSummaryMode(documentMode = null) {
  return getModeSetting('summaryMode', getActiveSettingsMode(documentMode))
}

function applyModeViewerSettings(documentMode) {
  const mode = normalizeSettingsMode(documentMode)
  state.disableInsights = getModeSetting('disableInsights', mode)
  state.disableCitationOverlay = getModeSetting('disableCitationOverlay', mode)
  state.disableFigureOverlay = getModeSetting('disableFigureOverlay', mode)
  state.disablePrimer = getModeSetting('disablePrimer', mode)
}

function showInsightJobProgress(sessionId, kind, title) {
  const existing = document.querySelector(`[data-insight-job="${CSS.escape(sessionId)}:${CSS.escape(kind)}"]`)
  if (existing) return
  const modal = document.createElement('div')
  modal.className = 'insight-job-progress'
  modal.dataset.insightJob = `${sessionId}:${kind}`
  modal.setAttribute('role', 'status')
  modal.setAttribute('aria-live', 'polite')
  modal.innerHTML = `<strong>${escapeHtml(title)}</strong><span class="insight-job-progress-text">작업 준비 중...</span><div class="insight-job-progress-track"><i></i></div><div><button type="button" data-action="cancel">취소</button><button type="button" data-action="retry" class="hidden">실패 페이지 재시도</button><button type="button" data-action="close" class="hidden">닫기</button></div>`
  document.body.appendChild(modal)
  const text = modal.querySelector('.insight-job-progress-text')
  const bar = modal.querySelector('i')
  const cancel = modal.querySelector('[data-action="cancel"]')
  const retry = modal.querySelector('[data-action="retry"]')
  const close = modal.querySelector('[data-action="close"]')
  let stopped = false
  let currentTaskId = null
  async function poll() {
    if (stopped || !modal.isConnected) return
    try {
      const status = await getInsightJobStatusAPI(sessionId, kind)
      currentTaskId = status.task_id || currentTaskId
      const total = Math.max(1, status.eligible_pages || 0)
      const done = status.completed_pages || 0
      const pct = Math.min(100, Math.round((done / total) * 100))
      bar.style.width = `${pct}%`
      const retryLabel = status.status === 'retry_wait' && status.next_retry_at ? t('viewer:task.retryAt', { time: new Date(status.next_retry_at).toLocaleTimeString() }) : ''
      const errorLabel = status.last_error_code ? ` · ${status.last_error_code}` : ''
      text.textContent = `${done}/${status.eligible_pages || status.total_pages}페이지 · ${pct}%${status.failed_pages?.length ? ` · 실패 ${status.failed_pages.length}` : ''}${retryLabel}${errorLabel}`
      if (['completed', 'completed_with_errors', 'succeeded', 'partial_failed', 'failed', 'cancelled'].includes(status.status)) {
        stopped = true
        cancel.classList.add('hidden')
        close.classList.remove('hidden')
        retry.classList.toggle('hidden', !['completed_with_errors', 'partial_failed', 'failed'].includes(status.status))
        return
      }
    } catch (error) {
      text.textContent = error.message
    }
    setTimeout(poll, 1000)
  }
  cancel.addEventListener('click', async () => {
    cancel.disabled = true
    await cancelInsightJobAPI(sessionId, kind).catch(() => {})
    stopped = false
    poll()
  })
  retry.addEventListener('click', async () => {
    if (!currentTaskId) return
    retry.disabled = true
    try {
      await retryDocumentTaskAPI(currentTaskId)
      stopped = false
      retry.classList.add('hidden')
      cancel.disabled = false
      cancel.classList.remove('hidden')
      close.classList.add('hidden')
      poll()
    } catch (error) {
      text.textContent = error.message
    } finally {
      retry.disabled = false
    }
  })
  close.addEventListener('click', () => modal.remove())
  poll()
}

// 툴바 위치: 'top'(기본) / 'bottom' / 'left' / 'right'. body에 클래스로
// 반영하고, 나머지는 전부 CSS(.toolbar-pos-*)가 처리한다 - 위치별로
// .topbar/.panels/.outline-sidebar/.floating-scroll-nav 등의 레이아웃이
// 바뀐다.
const TOOLBAR_POSITIONS = ['top', 'bottom', 'left', 'right']
function getToolbarPosition() {
  const saved = localStorage.getItem('easypaper_toolbar_position')
  return TOOLBAR_POSITIONS.includes(saved) ? saved : 'top'
}
function applyToolbarPosition(pos) {
  TOOLBAR_POSITIONS.forEach(p => document.body.classList.remove(`toolbar-pos-${p}`))
  if (pos !== 'top') document.body.classList.add(`toolbar-pos-${pos}`)
}
applyToolbarPosition(getToolbarPosition())

const LONG_DOCUMENT_PAGE_THRESHOLD = 50

function getTranslationMode(documentMode = null) {
  return getModeSetting('translationMode', getActiveSettingsMode(documentMode))
}

function isLongDocument(totalPages = state.totalPages) {
  return Number(totalPages) >= LONG_DOCUMENT_PAGE_THRESHOLD
}

function getEffectiveTranslationMode(documentMode = state.currentDocumentMode, totalPages = state.totalPages) {
  const configuredMode = getTranslationMode(documentMode)
  return configuredMode === 'auto' && isLongDocument(totalPages) ? 'scroll' : configuredMode
}

function getTranslationPlaceholderHtml(pageNum) {
  if (getEffectiveTranslationMode() === 'pane') {
    return `<div class="manual-translation-prompt">
      <span>필요한 페이지만 직접 번역할 수 있습니다.</span>
      <button type="button" class="translate-page-btn" data-page="${pageNum}">이 페이지 번역하기</button>
    </div>`
  }
  const message = isLongDocument()
    ? '페이지를 잠시 보고 있으면 자동으로 번역됩니다'
    : '스크롤하면 자동으로 번역됩니다'
  return `<div class="trans-page-placeholder">${message}</div>`
}

function syncModeSettings(documentMode) {
  settingsTranslationModeContext = normalizeSettingsMode(documentMode)
  const isGeneral = settingsTranslationModeContext === 'general'
  const options = getTranslationOptions(settingsTranslationModeContext)

  settingSourceLang.value = localStorage.getItem("easypaper_default_source_language") || "auto"
  settingTargetLang.value = options.targetLang
  settingTransStyle.value = options.style
  settingTranslationMode.value = getTranslationMode(settingsTranslationModeContext)
  settingIgnoreMath.checked = options.ignoreMath
  settingIgnoreTable.checked = options.ignoreTable
  settingIgnoreRefs.checked = options.ignoreRefs
  settingAutoGenerateKeywords.checked = getKeywordMode(settingsTranslationModeContext) === 'auto'
  settingAutoGenerateSummaries.checked = getSummaryMode(settingsTranslationModeContext) === 'auto'
  settingDisableInsights.checked = !getModeSetting('disableInsights', settingsTranslationModeContext)
  settingDisableCitationOverlay.checked = !getModeSetting('disableCitationOverlay', settingsTranslationModeContext)
  settingDisableFigureOverlay.checked = !getModeSetting('disableFigureOverlay', settingsTranslationModeContext)
  settingDisablePrimer.checked = !getModeSetting('disablePrimer', settingsTranslationModeContext)
  updateAccentSettingsUI(getModeSetting('accentColor', settingsTranslationModeContext))

  if (settingTranslationModeScope) {
    settingTranslationModeScope.textContent = isGeneral ? '일반 문서 모드에만 적용' : '연구 모드에만 적용'
  }
  if (settingsThemeScope) {
    const themeScopeKey = isGeneral ? 'settings:themeScopeGeneral' : 'settings:themeScopeResearch'
    settingsThemeScope.dataset.i18n = themeScopeKey
    settingsThemeScope.textContent = isGeneral
      ? t('settings:themeScopeGeneral')
      : t('settings:themeScopeResearch')
  }
  settingsModeTitle.textContent = isGeneral ? '일반 문서 모드 설정' : '연구 모드 설정'
  settingsModeBadge.textContent = isGeneral ? '일반 문서 모드' : '연구 모드'
  settingsModeDescription.textContent = isGeneral
    ? '책, 기술 문서, 보고서처럼 다양한 문서의 번역과 읽기에 적용됩니다.'
    : '논문 번역과 학술 읽기에 적용되는 기존 설정입니다.'
  settingsTranslationHeading.textContent = isGeneral ? '일반 문서 번역' : '논문 번역'
  settingsAutomationTitle.textContent = isGeneral ? '문서 처리 시 자동 생성' : '논문 처리 시 자동 생성'
  settingsReadingToolsLabel.textContent = isGeneral ? '일반 문서 모드 읽기 도구' : '연구 모드 읽기 도구'
  settingsKeywordsLabel.textContent = isGeneral ? '고급 어휘 자동 생성' : '키워드·단어 자동 생성'
  settingsKeywordsDescription.textContent = isGeneral
    ? '어려운 표현과 전문 용어를 페이지별로 정리합니다.'
    : '업로드 후 모든 페이지에 대해 백그라운드 생성합니다.'

  settingTransStyle.querySelector('option[value="academic"]').hidden = isGeneral
  settingTransStyle.querySelector('option[value="natural"]').hidden = !isGeneral
  document.querySelectorAll('[data-settings-mode-only="research"]').forEach(element => {
    element.classList.toggle('hidden', isGeneral)
  })
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
  stopLibraryPolling()
  viewerScreen.classList.remove('active')
  libraryScreen.classList.remove('active')
  if (compareScreen) compareScreen.classList.remove('active')
  closeChatDrawer()
  loginScreen.classList.add('active')
  // 글로벌 테마 토글 표시, 로그아웃 및 설정 버튼 숨김
  const globalToggle = $('global-theme-toggle')
  if (globalToggle) globalToggle.classList.remove('hidden')
  globalLogoutBtn.classList.add('hidden')
  globalSettingsBtn.classList.add('hidden')
}
function showViewer() {
  stopLibraryPolling()
  loginScreen.classList.remove('active')
  libraryScreen.classList.remove('active')
  if (compareScreen) compareScreen.classList.remove('active')
  closeChatDrawer()
  viewerScreen.classList.add('active')
  // 글로벌 테마 토글 숨김 (뷰어 상단바 테마 버튼 사용)
  const globalToggle = $('global-theme-toggle')
  if (globalToggle) globalToggle.classList.add('hidden')
}

function showCompareScreen() {
  stopLibraryPolling()
  loginScreen.classList.remove('active')
  libraryScreen.classList.remove('active')
  viewerScreen.classList.remove('active')
  closeChatDrawer()
  if (compareScreen) compareScreen.classList.add('active')
  // 라이브러리 화면과 동일하게 글로벌 테마/로그아웃/설정 버튼을 표시한다
  // (비교 화면 자체에는 별도의 테마 버튼이 없음)
  const globalToggle = $('global-theme-toggle')
  if (globalToggle) globalToggle.classList.remove('hidden')
  globalLogoutBtn.classList.remove('hidden')
  globalSettingsBtn.classList.remove('hidden')
}

function resetState() {
  globalAnalyticsTracker.stopSession()
  // 폴링 중단
  if (state.pollingTimer) { clearInterval(state.pollingTimer); state.pollingTimer = null }
  if (state.chatActiveStream) { state.chatActiveStream(); state.chatActiveStream = null }

  Object.assign(state, {
    sessionId: null, filename: null, title: null, totalPages: 0, currentPage: 1,
    zoom: 1.5, translationCache: {}, translationSentences: {}, translatingPages: new Set(), translatedPages: new Set(), pollingTimer: null,
    chatHistory: [], chatActiveStream: null, quotedText: null, quotedImage: null, quotedImagePage: null,
    activeHighlightColor: '#eab308', activeUnderlineColor: '#ef4444', isCropMode: false, documentImages: [], referenceMap: {},
    citationStyle: null, referencesHeaderPageNum: null
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
      beginClassifiedUpload(e.dataTransfer.files, activeLibraryFolderId)
    }
  })
}
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    const targetFolderId = state.currentWorkspacePage === 'library' ? activeLibraryFolderId : null
    beginClassifiedUpload(e.target.files, targetFolderId)
  }
})

// ── 파일 처리 ─────────────────────────────────────
async function beginClassifiedUpload(files, targetFolderId = null) {
  const selected = await workspaceModeController.chooseUploadClassification(Array.from(files))
  if (!selected) { fileInput.value = ""; return }
  await handleFiles(files, targetFolderId, selected)
}

async function handleFiles(files, targetFolderId = null, classification = null) {
  const pdfFiles = Array.from(files).filter(file => file.name.toLowerCase().endsWith('.pdf'))

  if (pdfFiles.length === 0) {
    showToast('PDF 파일만 업로드 가능합니다', 'error')
    return
  }

  const rememberedTypeOptions = classification?.documentType
    ? (loadDocumentTypeOptions()[classification.documentType] || {})
    : {}
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
      const result = await uploadPDF(file, {
        ...getTranslationOptions(classification?.documentMode || workspaceModeController.getMode()),
        ...rememberedTypeOptions,
        translationMode: getTranslationMode(classification?.documentMode || workspaceModeController.getMode()),
        keywordMode: getKeywordMode(classification?.documentMode || workspaceModeController.getMode()),
        summaryMode: getSummaryMode(classification?.documentMode || workspaceModeController.getMode()),
        documentMode: classification?.documentMode || workspaceModeController.getMode(),
        documentType: classification?.documentType || defaultDocumentType(workspaceModeController.getMode())
      }, (pct) => {
        uploadItemProgressBar.style.width = `${pct}%`
        uploadItemStatus.textContent = `업로드 중... ${pct}%`
      })

      uploadItemProgressBar.style.width = '100%'
      uploadItemStatus.textContent = '분석 및 저장 중...'

      lastSessionId = result.session_id
      lastFilename = result.filename
      lastTotalPages = result.total_pages
      lastTitle = (result.metadata && result.metadata.title) ? result.metadata.title : result.filename
      const uploadedDocumentMode = classification?.documentMode || workspaceModeController.getMode()
      if (isLongDocument(result.total_pages) && getTranslationMode(uploadedDocumentMode) === 'auto') {
        showToast(
          '50페이지 이상 문서는 전체 자동 번역 대신 보는 페이지부터 번역됩니다.',
          'info',
        )
      }
      successCount++
      if (result.document_mode === 'general' && getKeywordMode(result.document_mode) === 'auto' && result.total_pages > 20) {
        const uploadLanguageOptions = getTranslationOptions(result.document_mode)
        const estimate = await estimateInsightJobAPI(result.session_id, 'keywords', uploadLanguageOptions.targetLang, uploadLanguageOptions.sourceLang)
        const confirmed = await showCustomConfirm(
          `빈 페이지와 기존 캐시를 제외하고 최대 ${estimate.estimated_calls}회의 AI 호출이 예상됩니다. 전체 고급 어휘 생성을 시작할까요?`,
          { title: '장문 어휘 생성', confirmText: '생성 시작', danger: false },
        )
        if (confirmed) {
          await startInsightJobAPI(result.session_id, 'keywords', uploadLanguageOptions.targetLang, uploadLanguageOptions.sourceLang, true)
          showInsightJobProgress(result.session_id, 'keywords', `${lastTitle} · 고급 어휘`)
        }
      }
      if (classification?.documentType) {
        saveDocumentTypeOptions(classification.documentType, { ...rememberedTypeOptions, ...getTranslationOptions(classification.documentMode) })
        patchWorkspaceSettingsAPI({ document_type_options: loadDocumentTypeOptions() }).catch(() => {
          showToast('문서 종류별 옵션을 서버에 저장하지 못했습니다.', 'warning')
        })
      }
      if (targetFolderId) await moveLibraryDocuments([result.session_id], targetFolderId)

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
    const uploadedNoun = classification?.documentMode === 'general' ? '문서' : '논문'
    showToast(`${successCount}개의 ${uploadedNoun}가 라이브러리에 추가되었습니다 ✓`, 'success')

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

const visibleTranslationTimers = new Map()

function scheduleVisiblePageTranslation(pageNum) {
  const previousTimer = visibleTranslationTimers.get(pageNum)
  if (previousTimer) clearTimeout(previousTimer)

  if (!isLongDocument()) {
    translatePage(pageNum)
    return
  }

  const sessionId = state.sessionId
  const timer = setTimeout(() => {
    visibleTranslationTimers.delete(pageNum)
    if (state.sessionId !== sessionId || state.translatedPages.has(pageNum)) return

    const pagePair = viewerScrollContainer.querySelector(`.page-pair[data-page="${pageNum}"]`)
    if (!pagePair) return
    const pageRect = pagePair.getBoundingClientRect()
    const viewportRect = viewerScrollContainer.getBoundingClientRect()
    const visibleHeight = Math.max(0, Math.min(pageRect.bottom, viewportRect.bottom) - Math.max(pageRect.top, viewportRect.top))
    const visibilityRatio = visibleHeight / Math.max(1, Math.min(pageRect.height, viewportRect.height))
    if (visibilityRatio >= 0.5) translatePage(pageNum)
  }, 800)
  visibleTranslationTimers.set(pageNum, timer)
}

// ── 스크롤 뷰어 초기화 ────────────────────────────
async function initScrollViewer() {
  viewerScrollContainer.innerHTML = ''
  visibleTranslationTimers.forEach(timer => clearTimeout(timer))
  visibleTranslationTimers.clear()

  if (state.sessionId) {
    readingTimeActivityTracker.reset('reading')
    globalAnalyticsTracker.startSession(state.sessionId, state.totalPages || 0)
  }

  if (!viewerScrollContainer.dataset.analyticsListenersAttached) {
    viewerScrollContainer.dataset.analyticsListenersAttached = 'true'

    viewerScrollContainer.addEventListener('scroll', () => {
      if (state.currentPage) {
        const curPageEl = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${state.currentPage}"]`)
        globalAnalyticsTracker.trackScroll(state.currentPage, curPageEl, viewerScrollContainer, true, false)
      }
    }, { passive: true })

    let lastAnalyticsScrollInteractionAt = 0
    const trackUserScrollInteraction = () => {
      const now = Date.now()
      if (now - lastAnalyticsScrollInteractionAt < 1000 || !state.currentPage) return
      lastAnalyticsScrollInteractionAt = now
      globalAnalyticsTracker.trackInteraction('scroll', state.currentPage)
    }
    viewerScrollContainer.addEventListener('wheel', trackUserScrollInteraction, { passive: true })
    viewerScrollContainer.addEventListener('touchmove', trackUserScrollInteraction, { passive: true })

    viewerScrollContainer.addEventListener('mouseup', () => {
      const sel = window.getSelection()
      if (sel && sel.toString().trim().length > 0) {
        globalAnalyticsTracker.trackInteraction('selection', state.currentPage)
      }
    })
  }

  for (let i = 1; i <= state.totalPages; i++) {
    viewerScrollContainer.appendChild(createPagePair(i))
  }

  await renderScrollView(viewerScrollContainer, state.zoom, {
    onPageVisible: async (pageNum) => {
      updatePageDisplay(pageNum)
      globalAnalyticsTracker.setCurrentPage(pageNum)
      const visiblePageEl = viewerScrollContainer.querySelector('.pdf-page-wrapper[data-page="' + pageNum + '"]')
      globalAnalyticsTracker.trackScroll(pageNum, visiblePageEl, viewerScrollContainer, true, false)

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
          // 번역 로딩 실패 시 폴백 세그멘테이션 상태로 메모가 계속 숨겨져 있지
          // 않도록, 이미 그려진 문장 분할 기준으로 메모를 다시 그려준다.
          renderPageMemos(pageNum)
        }
      } else if (getEffectiveTranslationMode() === 'scroll') {
        // 번역 모드가 'scroll'이면 전체 문서 백그라운드 잡이 아예 시작되지
        // 않으므로, 스크롤로 보이게 된 페이지를 그때그때 개별 번역한다.
        scheduleVisiblePageTranslation(pageNum)
      }

      // 비동기 다음 페이지 번역 프리페칭 및 미리 렌더링
      const nextPage = pageNum + 1
      if (nextPage <= state.totalPages && !state.translationCache[nextPage]) {
        if (state.translatedPages.has(nextPage)) {
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
              renderPageMemos(nextPage)
            }
          })
        } else if (getEffectiveTranslationMode() === 'scroll' && !isLongDocument()) {
          // 다음 페이지도 미리 번역해둬 스크롤이 도착했을 때 바로 보이게 한다.
          translatePage(nextPage)
        }
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
  const translationPlaceholder = getTranslationPlaceholderHtml(pageNum)

  block.innerHTML = `
    <div class="trans-page-label">
      <span>${icon('fileText', 13, 'style="vertical-align:-2px;margin-right:3px"')}${t('viewer:pageLabel', { page: pageNum })}</span>
      <span class="trans-page-status" id="trans-status-${pageNum}">${t('viewer:translation.waiting')}</span>
    </div>
    <div class="trans-tabs${state.disableInsights ? ' insights-off' : ''}" id="trans-tabs-${pageNum}">
      <button class="trans-tab-btn active" data-tab="translation">번역</button>
      <button class="trans-tab-btn insight-tab-btn" data-tab="keywords">${state.currentDocumentMode === "general" ? "고급 어휘·키워드" : "키워드·단어"}</button>
      <button class="trans-tab-btn insight-tab-btn" data-tab="summary">요약</button>
      <button class="trans-tab-refresh-btn insight-tab-btn hidden" title="다시 생성">${icon('refreshCw', 12)}</button>
    </div>
    <div class="trans-page-content" id="trans-content-${pageNum}" dir="auto">
      ${translationPlaceholder}
    </div>
    <div class="trans-insight-content hidden" id="keywords-content-${pageNum}" dir="auto"></div>
    <div class="trans-insight-content hidden" id="summary-content-${pageNum}" dir="auto"></div>
    <div class="trans-resizer-handle"></div>
    <button class="trans-collapse-btn" title="${btnTitle}">${chevron}</button>`

  block.querySelectorAll('.trans-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTransTab(pageNum, btn.dataset.tab))
  })
  block.querySelector('.trans-tab-refresh-btn').addEventListener('click', (e) => {
    const tab = e.currentTarget.dataset.tab
    if (tab) loadPageInsight(pageNum, tab, true)
  })
  // 키워드/단어 탭에서 용어 클릭 시 PDF 원문 해당 위치로 스크롤 + 하이라이트
  // (콘텐츠는 renderInsightContent가 반복적으로 innerHTML을 교체하므로, 개별
  // 용어 엘리먼트가 아니라 컨테이너에 위임 방식으로 한 번만 등록한다)
  const keywordsContentEl = block.querySelector(`#keywords-content-${pageNum}`)
  if (keywordsContentEl) {
    keywordsContentEl.addEventListener('click', (e) => {
      const termEl = e.target.closest('.insight-keyword-term')
      if (!termEl) return
      locateTermInPdf(pageNum, termEl.textContent, Number(termEl.dataset.occurrence || 1)).catch(err => {
        // async 함수 내부에서 예상 못한 예외가 나면 토스트 없이 조용히
        // 아무 반응도 없는 것처럼 보일 수 있으므로, 항상 사용자에게 알리고
        // 콘솔에도 원인을 남긴다.
        console.error('locateTermInPdf failed:', err)
        showToast('원문 위치를 찾는 중 오류가 발생했습니다.', 'warning')
      })
    })
  }
  return block
}

// ── 번역 패널 탭 (번역 / 키워드·단어 / 요약) ─────────
function switchTransTab(pageNum, tab) {
  const block = $(`trans-block-${pageNum}`)
  if (!block) return
  block.querySelectorAll('.trans-tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab))

  const transContent = $(`trans-content-${pageNum}`)
  const keywordsContent = $(`keywords-content-${pageNum}`)
  const summaryContent = $(`summary-content-${pageNum}`)
  if (transContent) transContent.classList.toggle('hidden', tab !== 'translation')
  if (keywordsContent) keywordsContent.classList.toggle('hidden', tab !== 'keywords')
  if (summaryContent) summaryContent.classList.toggle('hidden', tab !== 'summary')

  const refreshBtn = block.querySelector('.trans-tab-refresh-btn')
  if (refreshBtn) {
    if (tab === 'translation') {
      refreshBtn.classList.add('hidden')
    } else {
      refreshBtn.classList.remove('hidden')
      refreshBtn.dataset.tab = tab
    }
  }

  if (tab === 'keywords' || tab === 'summary') {
    loadPageInsight(pageNum, tab, false)
  }
}

// 설정에서 키워드/요약 탭을 켜고 끌 때, 이미 열려있는 뷰어의 탭 바에도 즉시 반영
function applyInsightsTabVisibility() {
  document.querySelectorAll('.trans-tabs').forEach(tabsEl => {
    tabsEl.classList.toggle('insights-off', state.disableInsights)
    if (state.disableInsights) {
      const pageNum = tabsEl.id.replace('trans-tabs-', '')
      const activeBtn = tabsEl.querySelector('.trans-tab-btn.active')
      if (activeBtn && activeBtn.dataset.tab !== 'translation') {
        switchTransTab(pageNum, 'translation')
      }
    }
  })
}

function loadPageInsight(pageNum, kind, force) {
  const contentEl = $(`${kind}-content-${pageNum}`)
  if (!contentEl || !state.sessionId) return

  const cacheKey = `${pageNum}_${kind}`
  if (!force && state.pageInsightCache[cacheKey] !== undefined) {
    renderInsightContent(contentEl, kind, state.pageInsightCache[cacheKey])
    return
  }

  contentEl.innerHTML = `<div class="trans-waiting"><div class="trans-wait-spinner"></div><span>${kind === 'keywords' ? '키워드' : '요약'} 생성 중...</span></div>`

  let buffer = ''
  const { targetLang, sourceLang } = getTranslationOptions()
  streamPageInsightAPI(
    state.sessionId, pageNum, kind, targetLang, sourceLang, force,
    (token) => { buffer += token },
    () => {
      state.pageInsightCache[cacheKey] = buffer
      renderInsightContent(contentEl, kind, buffer)
    },
    (err) => {
      contentEl.innerHTML = `<div class="trans-error">생성 실패: ${escapeHtml(err.message)}</div>`
    }
  )
}

// "키워드/단어" 응답을 "- **용어**: 뜻풀이" 줄 단위로 파싱해서 용어(term)와
// 뜻풀이(def)를 분리한다. 형식에 맞지 않는 줄(예: "해당 없음" 안내 문구)은
// 안내 텍스트로 그대로 표시한다.
// LLM이 프롬프트 지시를 무시하고 뜻풀이 끝에 "(GRE 수준 단어)", "(전문용어)" 같은
// 분류용 괄호 주석을 덧붙이는 경우가 있어(이미 캐시된 이전 응답 포함), 표시 전에
// 방어적으로 제거한다. 실제 뜻풀이 내용에 있는 일반 괄호 설명은 건드리지 않도록
// 알려진 분류 키워드가 포함된 "끝에 붙은" 괄호만 제거한다.
const INSIGHT_LABEL_SUFFIX_RE = /\s*[（(](?:GRE\s*수준|고급\s*수준|전문\s*용어|고유\s*명사)[^)）]*[)）]\s*$/i

function parseKeywordItems(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const items = []
  for (const line of lines) {
    const m = line.match(/^[-*]?\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)$/)
    if (m) {
      const def = m[2].trim().replace(INSIGHT_LABEL_SUFFIX_RE, '')
      items.push({ term: m[1].trim(), def })
    } else {
      items.push({ term: null, def: line.replace(/^[-*]\s*/, '') })
    }
  }
  return items
}

function renderInsightContent(contentEl, kind, text) {
  if (!text || !text.trim()) {
    contentEl.innerHTML = `<div class="trans-page-placeholder">내용이 없습니다.</div>`
    return
  }

  if (kind === 'keywords') {
    const structured = parseStructuredVocabulary(text)
    if (structured) {
      contentEl.innerHTML = renderStructuredVocabulary(structured)
      return
    }
    const items = parseKeywordItems(text)
    contentEl.innerHTML = `<div class="insight-keyword-list">${items.map(it => {
      if (!it.term) {
        return `<div class="insight-keyword-empty">${escapeHtml(it.def)}</div>`
      }
      return `
        <div class="insight-keyword-item">
          <span class="insight-keyword-term" title="클릭하면 원문에서 위치를 찾아줍니다">${escapeHtml(it.term)}</span>
          <span class="insight-keyword-def">${formatTranslationHtml(it.def)}</span>
        </div>`
    }).join('')}</div>`
  } else {
    contentEl.innerHTML = `<div class="insight-summary-box">${formatTranslationHtml(text)}</div>`
  }

  applyKatexToElement(contentEl)
}

// ── 페이지 번역 ───────────────────────────────────
// 번역 모드가 'scroll'이거나 'pane'에서 사용자가 버튼을 눌렀을 때, 페이지 하나를
// 그 자리에서 즉시 번역한다(/translate/{id}/{page}
// SSE 엔드포인트, 캐시가 있으면 즉시 반환). 완료되면 job-polling 경로와 동일하게
// state.translatedPages/translationCache/translationSentences를 채워 이후
// 다시 방문했을 때는 재번역 없이 캐시를 바로 쓴다.
function translatePage(pageNum) {
  if (state.translatingPages.has(pageNum) || state.translatedPages.has(pageNum)) return
  if (!state.sessionId) return
  state.translatingPages.add(pageNum)

  const statusEl  = $(`trans-status-${pageNum}`)
  const contentEl = $(`trans-content-${pageNum}`)
  if (!contentEl) return

  // 스피너 + 대기 상태 표시
  contentEl.innerHTML = `
    <div class="trans-waiting">
      <div class="trans-wait-spinner"></div>
      <span>번역 중...</span>
    </div>`
  if (statusEl) statusEl.textContent = '번역 중...'

  const currentSessionId = state.sessionId
  let buffer = ''
  streamTranslation(
    currentSessionId, pageNum, getTranslationOptions(),
    (token) => { buffer += token },
    (cached, sentences) => {
      state.translatingPages.delete(pageNum)
      if (state.sessionId !== currentSessionId) return
      state.translatedPages.add(pageNum)
      state.translationCache[pageNum] = buffer
      state.translationSentences[pageNum] = sentences || []
      renderTransContent(pageNum, buffer, false)
    },
    (err) => {
      state.translatingPages.delete(pageNum)
      if (state.sessionId !== currentSessionId) return
      if (statusEl) statusEl.textContent = '번역 실패'
      contentEl.innerHTML = `<div class="trans-error">번역 실패: ${escapeHtml(err.message)}</div>`
    }
  )
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

const renderedTranslationContent = new WeakMap()

function renderTransContent(pageNum, text, cached = false) {
  const contentEl = $(`trans-content-${pageNum}`)
  const statusEl  = $(`trans-status-${pageNum}`)
  if (!contentEl) return

  // IntersectionObserver의 현재 페이지 콜백은 스크롤 중 노출 비율이 바뀔 때마다
  // 여러 번 실행된다. 이미 같은 번역을 그린 상태에서 DOM을 다시 만들면 아래의
  // 재세그멘테이션 경로가 메모 카드까지 제거/재생성해 메모가 깜빡이거나 편집
  // 포커스를 잃는다. 캐시 배지만 제자리에서 동기화하고 기존 콘텐츠는 유지한다.
  if (
    renderedTranslationContent.has(contentEl) &&
    renderedTranslationContent.get(contentEl) === text &&
    contentEl.querySelector('.trans-text')
  ) {
    const badge = contentEl.querySelector('.cached-badge')
    if (cached && !badge) {
      const cachedBadge = document.createElement('div')
      cachedBadge.className = 'cached-badge'
      cachedBadge.textContent = '✓ 캐시'
      contentEl.prepend(cachedBadge)
    } else if (!cached && badge) {
      badge.remove()
    }
    if (statusEl) { statusEl.textContent = '✓ 완료'; statusEl.classList.add('done') }
    return
  }

  renderedTranslationContent.set(contentEl, text)
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

    // 주석(하이라이트/언더라인) 및 메모 하이라이트 복원 - 위 재세그멘테이션으로
    // VirtualTextMap/문장 매핑이 통째로 새로 만들어지기 때문에, 이 페이지에 저장된
    // 하이라이트/언더라인이 없더라도(메모만 있는 경우) 반드시 다시 그려줘야 한다.
    // 예전에는 annotations[page_N]이 있을 때만 재렌더링해서, 메모만 있고 하이라이트/
    // 언더라인은 없는 페이지에서 번역 로딩이 끝나면 메모 하이라이트가 사라지는
    // 버그가 있었다.
    if (state.sessionId) {
      reRenderPageAnnotations(textLayerDiv, pageNum)
    }
  }

  if (statusEl) { statusEl.textContent = '✓ 완료'; statusEl.classList.add('done') }
}

// ── 페이지 표시 업데이트 ──────────────────────────
function updatePageDisplay(pageNum) {
  if (pageNum === state.currentPage) return
  state.currentPage = pageNum
  pageInput.value = pageNum
  scheduleSaveLastReadPage(pageNum)
}

// ── 마지막으로 읽던 위치(책갈피) 자동 저장 ─────────
// 스크롤 중 페이지가 바뀔 때마다 API를 호출하지 않도록 디바운스한다.
let saveLastReadPageTimer = null
let pendingLastReadPage = null
function scheduleSaveLastReadPage(pageNum) {
  if (!state.currentDocId || state.disableBookmark) return
  if (saveLastReadPageTimer) clearTimeout(saveLastReadPageTimer)
  pendingLastReadPage = pageNum
  saveLastReadPageTimer = setTimeout(() => {
    saveLastReadPageTimer = null
    const p = pendingLastReadPage
    pendingLastReadPage = null
    // last_page와 함께 last_read_at(마지막으로 읽은 시각)도 갱신한다 - 완독
    // 표시(read_at)를 하지 않고 읽던 중인 논문은 이 필드가 없으면 대시보드
    // "최근 읽은 논문"의 정렬/날짜 표시가 read_at||created_at로 떨어져
    // 계속 업로드 날짜("3일 전" 등)로만 보이는 문제가 있었다.
    updateLibraryDocMetadata(state.currentDocId, { last_page: p, last_read_at: new Date().toISOString() }).catch(() => {})
  }, 1500)
}

// 뷰어를 나갈 때(뒤로가기 등) 위 디바운스가 아직 안 끝났으면 그대로 잊혀지진
// 않지만(setTimeout 자체는 계속 살아있음) 그 사이에 Dashboard/Library가 먼저
// 옛날 last_page로 렌더링을 끝내버린다 - "논문을 읽고 나오면 최근 읽은
// 논문이 업데이트 안 된다"는 원인이 이것이었다. 화면을 벗어나기 직전 대기
// 중인 저장을 즉시(await로) 끝내, 다음 화면이 최신 값을 읽어가게 한다.
async function flushSaveLastReadPage() {
  if (saveLastReadPageTimer === null) return
  clearTimeout(saveLastReadPageTimer)
  saveLastReadPageTimer = null
  const docId = state.currentDocId
  const pageNum = pendingLastReadPage
  pendingLastReadPage = null
  if (!docId || pageNum == null) return
  try {
    await updateLibraryDocMetadata(docId, { last_page: pageNum, last_read_at: new Date().toISOString() })
  } catch {}
}

function updateProgressMini() {
  if (!state.totalPages) return
  const done = state.translatedPages.size
  const total = state.totalPages
  const isRunning = done < total
  updateProgressMiniRaw(done, total, isRunning)
}

function updateProgressMiniRaw(done, total, isRunning = true) {
  if (!total) return
  const pct = Math.round((done / total) * 100)

  if (pct >= 100 || !isRunning) {
    progressMini.classList.add('hidden')
  } else {
    progressMini.classList.remove('hidden')
    progressMiniBar.style.setProperty('--progress', `${pct}%`)
    progressMiniText.textContent = `${pct}%`
    progressMini.setAttribute('aria-label', t('viewer:translation.progress', { completed: done, total }))
  }
}

// ── 잡 폰링 ───────────────────────────────────────
function startJobPolling(sessionId) {
  if (state.pollingTimer) clearInterval(state.pollingTimer)

  // 완료된 페이지 수가 많거나 네트워크가 느리면 poll() 한 번의 실행이
  // 5초를 넘길 수 있는데, setInterval은 이전 실행이 끝났는지와 무관하게
  // 매번 새로 poll()을 호출한다. 그러면 두 호출이 같은 페이지에 대해
  // 동시에 getPageTranslation을 중복 요청/렌더링하게 되므로, 이전 poll()이
  // 아직 진행 중이면 이번 tick은 건너뛴다.
  let pollInFlight = false

  async function poll() {
    if (!state.sessionId || state.sessionId !== sessionId) return
    if (pollInFlight) return
    pollInFlight = true
    try {
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

      state.translationTaskId = job.task_id || null
      state.translationTaskStatus = job.task_status || null
      const done  = (job.completed_pages || []).length
      const total = job.total_pages || state.totalPages
      const isRunning = isTranslationTaskRunning(job)
      updateProgressMiniRaw(done, total, isRunning)
      if (job.task_status === 'retry_wait') {
        progressMiniText.textContent = job.next_retry_at ? t('viewer:task.retryAt', { time: new Date(job.next_retry_at).toLocaleTimeString() }) : t('viewer:task.retryWaiting')
        progressMini.setAttribute('aria-label', `${job.last_error_code || t('viewer:task.transientError')} · ${progressMiniText.textContent}`)
      } else if (job.failed_pages?.length) {
        progressMiniText.textContent = t('viewer:task.failedPages', { count: job.failed_pages.length })
      }

      if (job.status === 'running' || job.task_status === 'retry_wait') {
        cancelTransBtn.classList.remove('hidden')
        resumeTransBtn.classList.add('hidden')
      } else {
        cancelTransBtn.classList.add('hidden')
        const canRetry = canRetryTranslationTask(job)
        resumeTransBtn.classList.toggle('hidden', !canRetry)
        clearInterval(state.pollingTimer)
        state.pollingTimer = null
      }
    } finally {
      pollInFlight = false
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

// ── 우측 하단 floating 스크롤 내비게이션 (맨 위로/이전 페이지/다음 페이지/맨 아래로) ──
const scrollTopBtn      = $('scroll-top-btn')
const scrollPageUpBtn   = $('scroll-page-up-btn')
const scrollPageDownBtn = $('scroll-page-down-btn')
const scrollBottomBtn   = $('scroll-bottom-btn')

if (scrollTopBtn) {
  scrollTopBtn.addEventListener('click', () => scrollToPage(viewerScrollContainer, 1))
}
if (scrollBottomBtn) {
  scrollBottomBtn.addEventListener('click', () => scrollToPage(viewerScrollContainer, state.totalPages))
}
if (scrollPageUpBtn) {
  scrollPageUpBtn.addEventListener('click', () => {
    const target = Math.max(1, (parseInt(pageInput.value, 10) || 1) - 1)
    scrollToPage(viewerScrollContainer, target)
  })
}
if (scrollPageDownBtn) {
  scrollPageDownBtn.addEventListener('click', () => {
    const target = Math.min(state.totalPages, (parseInt(pageInput.value, 10) || 1) + 1)
    scrollToPage(viewerScrollContainer, target)
  })
}

// ── 줌 ────────────────────────────────────────────
// 클램핑 + 라벨 갱신만 즉시 수행하는 가벼운 버전. 핀치/휠 제스처처럼 짧은 시간에
// 값이 계속 바뀌는 상황에서, 매번 무거운 캔버스 재렌더링(reRenderAll)을 부르지
// 않고도 숫자 표시는 실시간으로 따라오게 하기 위해 분리했다.
function previewZoom(newZoom) {
  newZoom = Math.max(0.5, Math.min(3.0, newZoom))
  state.zoom = newZoom
  zoomLabel.textContent = `${Math.round(newZoom / 1.5 * 100)}%`
  return newZoom
}

// 제스처 도중에는 무거운 재렌더링(reRenderAll) 대신, 마지막으로 실제 렌더링된
// 배율(lastCommittedZoom) 대비 현재 미리보기 배율의 비율만큼 각 페이지에
// CSS transform(scale)을 걸어 그 자리에서 바로 확대/축소되는 것처럼 보이게
// 한다 - 캔버스를 다시 그리지 않아 비용이 거의 없고 즉각적이다. 제스처가
// 멈추면(디바운스) 실제로 새 배율로 재렌더링하고 transform은 원복한다.
let lastCommittedZoom = state.zoom

function applyZoomPreviewTransform(previewValue) {
  const ratio = previewValue / lastCommittedZoom
  viewerScrollContainer.querySelectorAll('.pdf-page-wrapper').forEach(w => {
    w.style.transformOrigin = 'center top'
    w.style.transform = ratio === 1 ? '' : `scale(${ratio})`
    // 확대된 페이지가 스크롤 방향으로 인접한 카드 위로 살짝 겹쳐도 잘리거나
    // 아래에 깔리지 않도록 그 순간만 앞으로 끌어올린다
    w.style.zIndex = ratio === 1 ? '' : '5'
  })
}

function clearZoomPreviewTransform() {
  viewerScrollContainer.querySelectorAll('.pdf-page-wrapper').forEach(w => {
    w.style.transform = ''
    w.style.zIndex = ''
  })
}

async function setZoom(newZoom) {
  newZoom = previewZoom(newZoom)
  lastCommittedZoom = newZoom
  if (!state.sessionId) { clearZoomPreviewTransform(); return }
  await reRenderAll(viewerScrollContainer, newZoom, {
    onPageVisible: (pageNum) => updatePageDisplay(pageNum)
  })
  // 재렌더링이 끝나 새 배율의 캔버스로 이미 교체된 뒤에 transform을 지워야
  // "확대된 미리보기 → 원래 크기로 순간 복귀 → 새 크기로 점프"하는 깜빡임이 없다.
  clearZoomPreviewTransform()
}

zoomInBtn.addEventListener('click',  () => setZoom(state.zoom + 0.2))
zoomOutBtn.addEventListener('click', () => setZoom(state.zoom - 0.2))

// 제스처 중에는 previewZoom(라벨) + CSS transform(시각적 미리보기)으로 즉시
// 반응하다가, 제스처가 잠시 멈추면(디바운스) 그 시점의 최종 값으로 실제
// 재렌더링을 한 번만 실행한다.
let zoomGestureTimer = null
function requestZoomFromGesture(newZoom) {
  newZoom = previewZoom(newZoom)
  applyZoomPreviewTransform(newZoom)
  if (zoomGestureTimer) clearTimeout(zoomGestureTimer)
  zoomGestureTimer = setTimeout(() => setZoom(state.zoom), 200)
}

// 트랙패드 핀치: 브라우저가 Ctrl+wheel 이벤트로 합성해서 보낸다(맥/윈도우 공통).
// 기본 동작(브라우저 페이지 전체 확대)을 막고 대신 뷰어 줌으로 처리한다.
viewerScrollContainer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  // 지수 스케일링 사용 - 매끄러운 트랙패드 핀치(작은 deltaY가 연속으로 여러 번)와
  // 마우스 휠 한 칸(±100 안팎의 큰 deltaY가 단발성으로) 양쪽 모두에서 한 번에
  // 과도하게 확대/축소되지 않도록 함
  requestZoomFromGesture(state.zoom * Math.exp(-e.deltaY * 0.002))
}, { passive: false })

// 터치스크린 핀치: 두 손가락 사이 거리 변화 비율만큼 확대/축소
let pinchStartDist = null
let pinchStartZoom = null
function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.hypot(dx, dy)
}
viewerScrollContainer.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    pinchStartDist = getTouchDistance(e.touches)
    pinchStartZoom = state.zoom
  }
}, { passive: true })
viewerScrollContainer.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchStartDist) {
    e.preventDefault()
    const scale = getTouchDistance(e.touches) / pinchStartDist
    requestZoomFromGesture(pinchStartZoom * scale)
  }
}, { passive: false })
viewerScrollContainer.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) {
    pinchStartDist = null
    pinchStartZoom = null
  }
})

// ── 내보내기 ──────────────────────────────────────
// 캐시에 로드되지 않은 번역 완료 페이지가 있다면 내보내기 전 비동기로 채워 넣는다
// (마크다운/PDF 내보내기가 공용으로 사용)
async function ensureAllTranslationsLoaded() {
  const missingPages = Array.from(state.translatedPages).filter(pageNum => {
    return !state.translationCache[pageNum] || state.translationCache[pageNum] === '__fetching__'
  })
  if (missingPages.length === 0) return

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

async function exportAsMarkdown() {
  await ensureAllTranslationsLoaded()

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
}

// 하이라이트/밑줄/메모(브라우저 localStorage 보관)를 실제 PDF 주석으로 구워
// 넣고, 번역·메모 섹션을 이어붙인 PDF를 서버에서 생성해 내려받는다.
async function exportAsAnnotatedPdf() {
  if (!state.sessionId) return
  await ensureAllTranslationsLoaded()

  const annotations = loadAnnotations(state.sessionId)
  const memos = loadMemos(state.sessionId)
  const opts = getTranslationOptions()

  showToast('번역·주석이 포함된 PDF를 생성하는 중입니다. 잠시만 기다려주세요...', 'info')
  try {
    const blob = await exportAnnotatedPdf(state.sessionId, {
      annotations,
      memos,
      target_lang: opts.targetLang,
      style: opts.style,
      ignore_math: opts.ignoreMath,
      ignore_table: opts.ignoreTable,
      ignore_refs: opts.ignoreRefs,
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const baseName = (state.filename || 'document').replace(/\.pdf$/i, '')
    a.href = url; a.download = `${baseName}_번역_주석.pdf`; a.click()
    URL.revokeObjectURL(url)
    showToast('PDF 파일을 다운로드했습니다 ✓', 'success')
  } catch (err) {
    showToast(err.message || 'PDF 내보내기 실패', 'error')
  }
}

// 내보내기 버튼 클릭 시 형식(마크다운/PDF)을 고르는 작은 드롭다운 메뉴
let exportFormatMenu = null

function createExportFormatMenu() {
  if (exportFormatMenu) return exportFormatMenu
  const menu = document.createElement('div')
  menu.id = 'export-format-menu'
  menu.className = 'selection-menu hidden'
  menu.style.flexDirection = 'column'
  menu.style.alignItems = 'stretch'
  menu.style.height = 'auto'
  menu.style.gap = '2px'
  menu.innerHTML = `
    <button type="button" class="menu-btn export-format-item" data-format="md" style="justify-content: flex-start; width: 100%; padding: 8px 12px; font-size: 12.5px; font-weight: 600; white-space: nowrap;">
      ${icon('fileText', 14, 'style="margin-right:6px;vertical-align:-2px"')}마크다운 (.md)
    </button>
    <button type="button" class="menu-btn export-format-item" data-format="pdf" style="justify-content: flex-start; width: 100%; padding: 8px 12px; font-size: 12.5px; font-weight: 600; white-space: nowrap;">
      ${icon('download', 14, 'style="margin-right:6px;vertical-align:-2px"')}PDF (번역·주석 포함)
    </button>
  `
  document.body.appendChild(menu)
  exportFormatMenu = menu

  menu.querySelectorAll('.export-format-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      hideExportFormatMenu()
      if (btn.dataset.format === 'md') {
        exportAsMarkdown()
      } else {
        exportAsAnnotatedPdf()
      }
    })
  })

  document.addEventListener('click', (e) => {
    if (exportFormatMenu && !exportFormatMenu.classList.contains('hidden') &&
        !exportFormatMenu.contains(e.target) && e.target !== exportBtn && !exportBtn.contains(e.target)) {
      hideExportFormatMenu()
    }
  })

  return menu
}

function hideExportFormatMenu() {
  if (exportFormatMenu) exportFormatMenu.classList.add('hidden')
}

exportBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  const menu = createExportFormatMenu()
  const isHidden = menu.classList.contains('hidden')
  if (!isHidden) { hideExportFormatMenu(); return }

  menu.classList.remove('hidden')
  const rect = exportBtn.getBoundingClientRect()
  const menuWidth = menu.offsetWidth || 210
  const idealLeft = rect.left + rect.width / 2 - menuWidth / 2 + window.scrollX
  const maxLeft = window.scrollX + document.documentElement.clientWidth - menuWidth - 8
  menu.style.left = `${Math.max(8, Math.min(idealLeft, maxLeft))}px`
  menu.style.top = `${rect.bottom + 8 + window.scrollY}px`
})

// ── 추가 메뉴(케밥): 번역 상태/모델, 번역 관리, 메모 숨기기, 테마 전환을 모아둔
// 드롭다운. 번역 모델 선택기(ProviderModelPicker)나 내보내기 형식 팝업처럼
// 메뉴 안에서 열리는 하위 팝업은 각자 자기 컨테이너에 상대 위치로 붙거나
// (모델 피커) document.body에 별도로 붙으므로(내보내기 팝업), 둘 다 케밥
// 메뉴 바깥 클릭으로 오인되어 메뉴가 먼저 닫혀버리는 문제 없이 자연스럽게
// 동작한다 - 모델 피커는 케밥 메뉴의 자손이라 outside-click 판정에서
// "안쪽"으로 처리되고, 내보내기 팝업은 형식을 실제로 골라야 바깥 클릭으로
// 잡혀 그때 케밥 메뉴도 함께 닫힌다.
if (toolbarKebabBtn && toolbarKebabMenu) {
  const getMenuItems = () => Array.from(toolbarKebabMenu.querySelectorAll('button:not([disabled]), select, [tabindex]:not([tabindex="-1"])'))
  const syncMenuState = () => toolbarKebabBtn.setAttribute('aria-expanded', String(!toolbarKebabMenu.classList.contains('hidden')))
  const closeMenu = (restoreFocus = false) => {
    toolbarKebabMenu.classList.add('hidden')
    syncMenuState()
    if (restoreFocus) toolbarKebabBtn.focus()
  }
  new MutationObserver(syncMenuState).observe(toolbarKebabMenu, { attributes: true, attributeFilter: ['class'] })

  toolbarKebabBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const willOpen = toolbarKebabMenu.classList.contains('hidden')
    toolbarKebabMenu.classList.toggle('hidden')
    syncMenuState()
    if (willOpen) window.requestAnimationFrame(() => toolbarKebabMenu.querySelector('.kebab-menu-item:not(.hidden):not([disabled])')?.focus())
  })

  toolbarKebabMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    const visibleItems = getMenuItems().filter(item => item.getClientRects().length > 0)
    const current = visibleItems.indexOf(document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = visibleItems[(current + delta + visibleItems.length) % visibleItems.length]
    if (next) { event.preventDefault(); next.focus() }
  })

  document.addEventListener('click', (e) => {
    if (toolbarKebabMenu.classList.contains('hidden')) return
    if (toolbarKebabMenu.contains(e.target) || toolbarKebabBtn.contains(e.target)) return
    closeMenu()
  })
}

const viewerClearCacheBtn = $('viewer-clear-cache-btn')
if (viewerClearCacheBtn) {
  viewerClearCacheBtn.addEventListener('click', async () => {
    toolbarKebabMenu?.classList.add('hidden')
    if (!state.sessionId) {
      showToast('열려있는 논문이 없습니다.', 'error')
      return
    }
    const currentDocTitle = $('doc-title')?.textContent || '현재 논문'
    const ok = await showCustomConfirm(`"${currentDocTitle}"의 PDF 추출 캐시를 삭제할까요?\n(다음 열람 시 PDF를 다시 파싱하게 됩니다.)`, { title: 'PDF 캐시 삭제', confirmText: '캐시 삭제' })
    if (!ok) return
    try {
      await clearSingleDocCacheAPI(state.sessionId)
      showToast('PDF 추출 캐시가 삭제되었습니다.', 'success')
    } catch (err) {
      showToast('캐시 삭제 실패: ' + err.message, 'error')
    }
  })
}

function showTranslationScopeDialog() {
  return new Promise(resolve => {
    const modal = document.createElement('div')
    modal.className = 'custom-confirm-modal-wrapper'
    modal.innerHTML = `
      <div class="custom-confirm-modal translation-scope-modal">
        <div class="custom-confirm-modal-header">
          <span class="custom-confirm-modal-title">번역 범위 선택</span>
        </div>
        <div class="custom-confirm-modal-body">필요한 범위만 선택해 번역할 수 있습니다.</div>
        <div class="translation-scope-options">
          <button data-scope="current"><strong>현재 페이지</strong><span>${state.currentPage}페이지 한 장만 번역</span></button>
          <button data-scope="remaining"><strong>남은 페이지</strong><span>${state.currentPage}–${state.totalPages}페이지 번역</span></button>
          <button data-scope="range"><strong>페이지 범위</strong><span>시작·끝 페이지를 직접 지정</span></button>
          <button data-scope="all"><strong>문서 전체</strong><span>1–${state.totalPages}페이지 번역</span></button>
        </div>
        <div class="custom-confirm-modal-footer">
          <button class="custom-confirm-btn cancel-btn">취소</button>
        </div>
      </div>`
    document.body.appendChild(modal)

    const close = value => {
      modal.classList.remove('active')
      setTimeout(() => { modal.remove(); resolve(value) }, 200)
    }
    modal.querySelector('.cancel-btn').addEventListener('click', () => close(null))
    modal.querySelectorAll('[data-scope]').forEach(button => {
      button.addEventListener('click', () => close(button.dataset.scope))
    })
    modal.addEventListener('click', event => { if (event.target === modal) close(null) })
    setTimeout(() => modal.classList.add('active'), 10)
  })
}

function parseTranslationPageRange(value) {
  const match = String(value || '').match(/^\s*(\d+)\s*[-~]\s*(\d+)\s*$/)
  if (!match) return null
  const startPage = Number.parseInt(match[1], 10)
  const endPage = Number.parseInt(match[2], 10)
  if (startPage < 1 || endPage < startPage || endPage > state.totalPages) return null
  return Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index)
}

async function startScopedTranslation(pageNumbers, label) {
  const pendingPages = pageNumbers.filter(pageNum => !state.translatedPages.has(pageNum))
  if (pendingPages.length === 0) {
    showToast('선택한 범위는 이미 번역되었습니다.', 'info')
    return
  }

  if (pendingPages.length >= LONG_DOCUMENT_PAGE_THRESHOLD) {
    const confirmed = await showCustomConfirm(
      `${label} ${pendingPages.length}페이지를 백그라운드에서 번역합니다. 계속하시겠습니까?\n작업은 언제든 중지하고 같은 범위부터 재개할 수 있습니다.`,
      { title: '긴 문서 번역', confirmText: '번역 시작', danger: false },
    )
    if (!confirmed) return
  }

  try {
    showToast(`${label} 번역 작업을 시작합니다.`, 'info')
    await restartJobAPI(state.sessionId, { ...getTranslationOptions(), pageNumbers: pendingPages })
    startJobPolling(state.sessionId)
    showToast(`${label} 번역이 시작되었습니다.`, 'success')
  } catch (err) {
    showToast(err.message || '번역 작업 시작 실패', 'error')
  }
}

translationScopeBtn?.addEventListener('click', async () => {
  toolbarKebabMenu?.classList.add('hidden')
  if (!state.sessionId) return
  const scope = await showTranslationScopeDialog()
  if (!scope) return

  if (scope === 'current') {
    translatePage(state.currentPage)
    return
  }

  let pageNumbers
  let label = '선택 범위'
  if (scope === 'remaining') {
    pageNumbers = Array.from({ length: state.totalPages - state.currentPage + 1 }, (_, index) => state.currentPage + index)
    label = '남은 페이지'
  } else if (scope === 'range') {
    const rawRange = await showCustomTextDialog({
      title: '페이지 범위 번역',
      label: `번역 범위 (예: 10-25, 전체 ${state.totalPages}페이지)`,
      value: `${state.currentPage}-${Math.min(state.currentPage + 9, state.totalPages)}`,
      confirmText: '범위 선택',
    })
    if (!rawRange) return
    pageNumbers = parseTranslationPageRange(rawRange)
    if (!pageNumbers) {
      showToast(`1-${state.totalPages} 사이의 올바른 범위를 입력해주세요.`, 'error')
      return
    }
    label = `${pageNumbers[0]}-${pageNumbers.at(-1)}페이지`
  } else {
    pageNumbers = Array.from({ length: state.totalPages }, (_, index) => index + 1)
    label = '문서 전체'
  }

  await startScopedTranslation(pageNumbers, label)
})

// ── 다시 번역하기 ──────────────────────────────────

retranslateBtn.addEventListener('click', async () => {
  if (!state.sessionId) return

  const ok = await showCustomConfirm('기존 번역 캐시를 삭제하고 처음부터 다시 번역을 시작하시겠습니까?\n(확인을 누르면 기존 번역이 완전히 초기화되고 새로 번역을 진행합니다.)', { title: '재번역 시작', confirmText: '재번역', danger: true })
  if (ok) {
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
        contentEl.innerHTML = getTranslationPlaceholderHtml(i)
      }
      if (statusEl) {
        statusEl.textContent = t('viewer:translation.waiting')
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

  const ok = await showCustomConfirm('현재 진행 중인 백그라운드 번역 작업을 중지하시겠습니까?', { title: '번역 작업 중지', confirmText: '중지', danger: true })
  if (ok) {
    try {
      showToast('번역 중지 요청 중...', 'info')
      await cancelJobAPI(state.sessionId)

      if (state.pollingTimer) {
        clearInterval(state.pollingTimer)
        state.pollingTimer = null
      }
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
    const retryFailedTask = shouldRetryFailedTranslationTask(
      state.translationTaskId, state.translationTaskStatus,
    )
    showToast(retryFailedTask ? t('viewer:task.retryingFailed') : '중단된 지점부터 번역을 재개하는 중...', 'info')
    if (retryFailedTask) await retryDocumentTaskAPI(state.translationTaskId)
    else await restartJobAPI(state.sessionId, { ...getTranslationOptions(), resumeScope: true })
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
          await updateLibraryDocTitle(state.sessionId, newTitle)
          state.title = newTitle
          docTitle.textContent = newTitle
          state.currentDocMetadata.title = newTitle
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
    await syncLanguageSettingsFromServer()
    loginScreen.classList.remove('active')
    globalLogoutBtn.classList.remove('hidden')
    globalSettingsBtn.classList.remove('hidden')
    if (location.hash && location.hash.startsWith('#viewer?id=')) {
      // 뷰어로 바로 진입하는 경로라 라이브러리 화면이 렌더링되지 않으므로,
      // 안읽음 배지/휴지통 탭 표시는 별도로 한 번 조회해서 채워야 한다.
      await workspaceModeController.initialize()
      lastWorkspaceMode = workspaceModeController.getMode()
      await handleRouting()
      await loadLibraryCount()
    } else {
      // showLibraryScreen() -> renderLibrary()가 이미 문서 목록을 받아와
      // 배지/휴지통 탭까지 갱신하므로, 여기서 loadLibraryCount()를 또 불러
      // GET /api/library(+trash)를 중복으로 쏠 필요가 없다. 앱 부팅 시마다
      // 라이브러리 목록을 사실상 두 번 불러오던 게 체감 로딩을 늘리던
      // 원인 중 하나였다.
      await workspaceModeController.initialize()
      lastWorkspaceMode = workspaceModeController.getMode()
      await showLibraryScreen()
    }
    applyModeTheme(workspaceModeController.getMode())
    await refreshSystemSettings()
    await maybeShowOnboarding()
    // 업데이트 직후(방금 재시작됨) 안내가 있으면 그것부터 먼저 보여주고, 없을
    // 때만 "새 업데이트가 있는지" 확인 - 두 팝업이 동시에 겹쳐 뜨지 않도록 함.
    // git pull 기반이라 git 저장소 없이 배포되는 Tauri 데스크탑 빌드에서는
    // 애초에 의미가 없으므로 건너뛴다(데스크탑 자체 업데이트는 Tauri updater가
    // 별도로 담당).
    if (!isTauriDesktop) {
      checkPostUpdateNoticeOnce().then((shown) => {
        if (!shown) maybeAutoCheckForUpdate()
      })
    } else {
      loadTauriAppVersion()
      maybeCheckTauriUpdateIfDue()
      startTauriUpdatePolling()
    }
  } else {
    showLogin()
  }
}

// 로그인 폼 제출 이벤트
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const username = loginUsername.value.trim()
  const password = loginPassword.value
  const remember = loginRememberCheckbox ? loginRememberCheckbox.checked : false
  try {
    await loginAPI(username, password, remember)
    showToast('로그인 성공!', 'success')
    loginPassword.value = ''
    await checkAuthentication()
  } catch (err) {
    showToast(err.message, 'error')
  }
})

// 로그아웃 버튼 클릭 이벤트
globalLogoutBtn.addEventListener('click', async () => {
  const ok = await showCustomConfirm('로그아웃 하시겠습니까?', { title: '로그아웃', confirmText: '로그아웃', danger: false })
  if (!ok) return
  try {
    await logoutAPI()
    showToast('로그아웃되었습니다.', 'success')
    showLogin()
  } catch (err) {
    showToast(err.message, 'error')
  }
})

// 휴지통 비우기 버튼 클릭 이벤트
if (libEmptyTrashBtn) {
  libEmptyTrashBtn.addEventListener('click', async () => {
    const ok = await showCustomConfirm('휴지통에 있는 모든 논문을 영구 삭제할까요?\n이 작업은 복구할 수 없습니다.', {
      title: '휴지통 비우기',
      confirmText: '휴지통 비우기',
      danger: true
    })
    if (!ok) return
    try {
      await emptyLibraryTrash()
      showToast('휴지통이 비워졌습니다.', 'success')
      await renderLibrary()
    } catch (err) {
      showToast('휴지통 비우기 실패: ' + err.message, 'error')
    }
  })
}

// ── 비밀번호 변경 모달 이벤트 ──────────────────────────
// ── Ollama 설정 새로고침 헬퍼 ──────────────────────────
// ── 시스템 설정 새로고침 헬퍼 ──────────────────────────
// ── Provider + Model 통합 선택 드롭다운 ─────────────────
const PROVIDER_CONFIG = [
  {
    id: 'antigravity', label: 'Antigravity', icon: icon('zap', 13),
    models: [
      // Gemini 3.7 Flash
      { value: 'Gemini 3.7 Flash (Low)',    label: 'Flash · Low',    group: 'Gemini 3.7 Flash' },
      { value: 'Gemini 3.7 Flash (Medium)', label: 'Flash · Medium', group: 'Gemini 3.7 Flash' },
      { value: 'Gemini 3.7 Flash (High)',   label: 'Flash · High',   group: 'Gemini 3.7 Flash' },
      // Gemini 3.6 Flash
      { value: 'Gemini 3.6 Flash (Low)',    label: 'Flash · Low',    group: 'Gemini 3.6 Flash' },
      { value: 'Gemini 3.6 Flash (Medium)', label: 'Flash · Medium', group: 'Gemini 3.6 Flash' },
      { value: 'Gemini 3.6 Flash (High)',   label: 'Flash · High',   group: 'Gemini 3.6 Flash' },
      // Gemini 3.5 Flash
      { value: 'Gemini 3.5 Flash (Low)',    label: 'Flash · Low',    group: 'Gemini 3.5 Flash' },
      { value: 'Gemini 3.5 Flash (Medium)', label: 'Flash · Medium', group: 'Gemini 3.5 Flash' },
      { value: 'Gemini 3.5 Flash (High)',   label: 'Flash · High',   group: 'Gemini 3.5 Flash' },
      // Gemini 3.1 Pro
      { value: 'Gemini 3.1 Pro (Low)',  label: 'Pro · Low',  group: 'Gemini 3.1 Pro' },
      { value: 'Gemini 3.1 Pro (High)', label: 'Pro · High', group: 'Gemini 3.1 Pro' },
      // Claude
      { value: 'Claude Sonnet 4.6 (Thinking)', label: 'Sonnet · Thinking', group: 'Claude' },
      { value: 'Claude Opus 4.6 (Thinking)',   label: 'Opus · Thinking',   group: 'Claude' },
      // GPT
      { value: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B · Medium', group: 'GPT' },
    ]
  },
  {
    id: 'claude_code', label: 'Claude Code', icon: icon('terminal', 13),
    models: [
      // Sonnet
      { value: 'sonnet|low',    label: 'Sonnet · Low',    group: 'Sonnet 5' },
      { value: 'sonnet|medium', label: 'Sonnet · Medium', group: 'Sonnet 5' },
      { value: 'sonnet|high',   label: 'Sonnet · High',   group: 'Sonnet 5' },
      { value: 'sonnet|xhigh',  label: 'Sonnet · xHigh',  group: 'Sonnet 5' },
      { value: 'sonnet|max',    label: 'Sonnet · Max',    group: 'Sonnet 5' },
      // Fable
      { value: 'fable|low',    label: 'Fable · Low',    group: 'Fable 5' },
      { value: 'fable|medium', label: 'Fable · Medium', group: 'Fable 5' },
      { value: 'fable|high',   label: 'Fable · High',   group: 'Fable 5' },
      { value: 'fable|xhigh',  label: 'Fable · xHigh',  group: 'Fable 5' },
      { value: 'fable|max',    label: 'Fable · Max',    group: 'Fable 5' },
      // Opus
      { value: 'opus|low',    label: 'Opus · Low',    group: 'Opus 5' },
      { value: 'opus|medium', label: 'Opus · Medium', group: 'Opus 5' },
      { value: 'opus|high',   label: 'Opus · High',   group: 'Opus 5' },
      { value: 'opus|xhigh',  label: 'Opus · xHigh',  group: 'Opus 5' },
      { value: 'opus|max',    label: 'Opus · Max',    group: 'Opus 5' },
      // Haiku
      { value: 'haiku|low',    label: 'Haiku · Low',    group: 'Haiku 4.5' },
      { value: 'haiku|medium', label: 'Haiku · Medium', group: 'Haiku 4.5' },
      { value: 'haiku|high',   label: 'Haiku · High',   group: 'Haiku 4.5' },
      { value: 'haiku|xhigh',  label: 'Haiku · xHigh',  group: 'Haiku 4.5' },
      { value: 'haiku|max',    label: 'Haiku · Max',    group: 'Haiku 4.5' },
    ]
  },
  {
    id: 'codex', label: 'Codex', icon: icon('code', 13),
    models: [
      // GPT-5.6 Terra
      { value: 'gpt-5.6-terra|low',    label: 'Terra · Low',    group: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-terra|medium', label: 'Terra · Medium', group: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-terra|high',   label: 'Terra · High',   group: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-terra|xhigh',  label: 'Terra · xHigh',  group: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-terra|max',    label: 'Terra · Max',    group: 'GPT-5.6 Terra' },
      // GPT-5.6 Luna
      { value: 'gpt-5.6-luna|low',    label: 'Luna · Low',    group: 'GPT-5.6 Luna' },
      { value: 'gpt-5.6-luna|medium', label: 'Luna · Medium', group: 'GPT-5.6 Luna' },
      { value: 'gpt-5.6-luna|high',   label: 'Luna · High',   group: 'GPT-5.6 Luna' },
      { value: 'gpt-5.6-luna|xhigh',  label: 'Luna · xHigh',  group: 'GPT-5.6 Luna' },
      // GPT-5.5
      { value: 'gpt-5.5|low',    label: 'GPT-5.5 · Low',    group: 'GPT-5.5' },
      { value: 'gpt-5.5|medium', label: 'GPT-5.5 · Medium', group: 'GPT-5.5' },
      { value: 'gpt-5.5|high',   label: 'GPT-5.5 · High',   group: 'GPT-5.5' },
      { value: 'gpt-5.5|xhigh',  label: 'GPT-5.5 · xHigh',  group: 'GPT-5.5' },
    ]
  },
  {
    id: 'ollama', label: 'Ollama', icon: icon('hardDrive', 13),
    models: [
      { value: 'qwen3.5:9b', label: 'qwen3.5 9b' },
      { value: 'llama3.1:8b', label: 'llamma 3.1' },
      { value: 'gemma4:e4b', label: 'gemma4 e4b' },
      { value: 'gemma4:12b', label: 'gemma4 12b' },
      { value: 'qwen3.6:27b', label: 'qwen3.6 27b' },
      { value: 'mistral-small3.2:24b', label: 'mistral-small3.2 24b' },
      { value: 'phi4-reasoning:14b', label: 'phi4-reasoning 14b' },
      { value: 'deepseek-r1:8b', label: 'deepseek-r1 8b' },
      { value: 'custom_input', label: '직접 입력' }
    ]
  },
  {
    id: 'openai', label: 'OpenAI', icon: '✦',
    models: [
      { value: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna' },
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
    id: 'claude', label: 'Anthropic Claude', icon: icon('cpu', 13),
    models: [
      { value: 'claude-fable-5', label: 'Claude Fable 5' },
      { value: 'claude-opus-5', label: 'Claude Opus 5' },
      { value: 'claude-opus-4.7', label: 'Claude Opus 4.7' },
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { value: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' }
    ]
  },
  {
    id: 'gemini', label: 'Google Gemini', icon: icon('star', 13),
    models: [
      { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
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

    // Ollama 다운로드 모델 매칭을 처리하기 위한 헬퍼 함수
    const isMatch = (installed, baseValue) => isOllamaModelMatch(installed, baseValue)


    // 지금 바로 사용 가능한(=키가 있거나, CLI가 감지됐거나, 모델이 받아져 있는) 공급자인지 여부
    const isProviderAvailable = (providerId) => {
      if (providerId === 'antigravity') return state.cliAvailability?.antigravity === true
      if (providerId === 'claude_code') return state.cliAvailability?.claude_code === true
      if (providerId === 'codex') return state.cliAvailability?.codex === true
      if (providerId === 'ollama') return downloaded.length > 0
      if (providerId === 'openai') return hasOpenAIKey
      if (providerId === 'gemini') return hasGeminiKey
      if (providerId === 'claude') return hasClaudeKey
      return false
    }

    let config = PROVIDER_CONFIG.filter(p => {
      // 뷰어/채팅 등 컴팩트 선택기에서는 사용 불가능한 CLI 공급자를 목록에서 아예 숨겨
      // 목록을 짧게 유지한다. 설정 화면에서는 아직 설정 전인 공급자도 볼 수 있어야
      // 하므로 숨기지 않고 아래에서 정렬 + "사용가능" 칩으로만 구분한다.
      if (!this.compact) return true
      if (p.id === 'antigravity') return state.cliAvailability?.antigravity !== false
      if (p.id === 'claude_code') return state.cliAvailability?.claude_code !== false
      if (p.id === 'codex') return state.cliAvailability?.codex !== false
      return true
    }).map(p => {
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
    } else {
      // 설정 화면: 지금 바로 사용 가능한 공급자를 먼저 나열 (그룹 내 상대 순서는 유지)
      config = config
        .map(p => ({ ...p, available: isProviderAvailable(p.id) }))
        .sort((a, b) => (b.available - a.available))
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
      const availableChipHtml = prov.available ? `<span class="picker-available-chip">사용가능</span>` : ''
      header.innerHTML = `<span class="g-icon">${prov.icon}</span><span>${prov.label}</span>${availableChipHtml}`
      group.appendChild(header)

      const models = prov.models.length > 0 ? prov.models : [{ value: '', label: '모델 없음' }]
      let lastGroup = null
      models.forEach(m => {
        // group 속성이 있으면 새 그룹이 시작될 때 소제목 삽입 (claude_code effort 그룹핑)
        if (m.group && m.group !== lastGroup) {
          if (lastGroup !== null) {
            const subDiv = document.createElement('div')
            subDiv.style.cssText = 'height:1px;background:var(--border);margin:3px 8px;'
            group.appendChild(subDiv)
          }
          const subHeader = document.createElement('div')
          subHeader.style.cssText = 'padding:4px 10px 2px 10px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);opacity:0.7;'
          subHeader.textContent = m.group
          group.appendChild(subHeader)
          lastGroup = m.group
        }
        const item = document.createElement('div')
        item.className = 'picker-model-item' + (this._provider === prov.id && this._model === m.value ? ' selected' : '')
        item.style.position = 'relative'
        item.textContent = m.label
        if (m.value) {
          item.addEventListener('click', async (e) => {
            e.stopPropagation()

            // 직접 모델명 입력 추가 옵션 처리
            if (m.value === 'custom_input') {
              this.container.classList.remove('open')

              // 1. 설정 모달 열기
              if (settingsModal) {
                openOverlayModal(settingsModal)
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
                const ok = await showCustomConfirm(`'${m.label.split(' ')[0]}' (${m.value}) 모델이 설치되어 있지 않습니다. 다운로드하시겠습니까?\n(설정 창 하단에서 다운로드 진행 상태를 보실 수 있습니다)`, { title: '모델 다운로드', confirmText: '다운로드', danger: false })
                if (ok) {
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
    const provIcon = prov ? prov.icon : '?'
    const provShort = prov ? (prov.label === 'Google Gemini' ? 'Gemini' : prov.label === 'Anthropic Claude' ? 'Claude' : prov.label.split(' ')[0]) : this._provider
    let modelLabel = this._model || '(선택 안 됨)'
    if (prov) {
      const found = prov.models.find(m => m.value === this._model)
      if (found) {
        modelLabel = found.label.replace(' (설치됨)', '').replace(' (미설치 - 클릭 시 다운로드)', '')
      }
    }
    this._btn.querySelector('.picker-icon').innerHTML = provIcon
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

// 뷰어용 2개와 설정 화면용 계층형 모델 선택기를 초기화한다.
const viewerTransPicker = new ProviderModelPicker($('viewer-trans-provider'), {
  compact: true,
  onChange: (provider, model) => changeProviderAndModel('trans', provider, model)
})

const chatSidebarPicker = new ProviderModelPicker($('chat-sidebar-provider'), {
  compact: true,
  onChange: (provider, model) => changeProviderAndModel('chat', provider, model)
})

const _PDF_DOC_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`
const _TRASH_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`

class PdfParserPicker {
  constructor(containerEl, { onChange } = {}) {
    if (!containerEl) return
    this.container = containerEl
    this.onChange = onChange || (() => {})
    this._selectedId = 'pymupdf'
    this._parsers = []
    this._build()
    this._bindClose()
  }

  _build() {
    const c = this.container
    c.className = 'provider-picker picker-left picker-full-wrap'

    this._btn = document.createElement('button')
    this._btn.type = 'button'
    this._btn.className = 'provider-picker-btn picker-full'
    this._btn.innerHTML = `<span class="picker-icon">${_PDF_DOC_SVG}</span><span class="picker-label">PyMuPDF (fitz) - [기본] (0 MB)</span><span class="picker-arrow">▾</span>`

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

  setParsersData(parsers, currentId) {
    this._parsers = parsers || []
    if (currentId) this._selectedId = currentId
    this._updateBtn()
  }

  _rebuildPanel() {
    this._panel.innerHTML = ''
    const list = this._parsers.length > 0 ? this._parsers : Object.values(PARSER_FALLBACK_META)

    const group = document.createElement('div')
    group.className = 'picker-group'

    const header = document.createElement('div')
    header.className = 'picker-group-header'
    header.innerHTML = `<span class="g-icon">${_PDF_DOC_SVG}</span><span>PDF 파서 엔진 목록</span>`
    group.appendChild(header)

    list.forEach(p => {
      const item = document.createElement('div')
      item.className = 'picker-model-item' + (this._selectedId === p.id ? ' selected' : '')

      const badgeHtml = p.installed
        ? `<span class="picker-available-chip" style="margin-left:auto;">설치됨</span>`
        : `<span style="margin-left:auto;font-size:11px;color:var(--text-muted);">${p.size_info || '미설치'}</span>`

      item.innerHTML = `<div style="display:flex;align-items:center;width:100%;gap:8px;"><span>${p.name}</span>${badgeHtml}</div>`

      item.addEventListener('click', (e) => {
        e.stopPropagation()
        this._selectedId = p.id
        this._updateBtn()
        this.container.classList.remove('open')
        this.onChange(p.id)
      })
      group.appendChild(item)
    })

    this._panel.appendChild(group)
  }

  _updateBtn() {
    const p = (this._parsers && this._parsers.find(item => item.id === this._selectedId)) || PARSER_FALLBACK_META[this._selectedId] || PARSER_FALLBACK_META.pymupdf
    const label = p ? `${p.name} - ${p.installed ? '[설치됨]' : `[미설치 - ${p.size_info}]`}` : this._selectedId
    if (this._btn) {
      this._btn.querySelector('.picker-icon').innerHTML = _PDF_DOC_SVG
      this._btn.querySelector('.picker-label').textContent = label
    }
  }

  _bindClose() {
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target)) {
        this.container.classList.remove('open')
      }
    })
  }

  getValue() {
    return this._selectedId
  }

  setValue(val) {
    if (val) {
      this._selectedId = val
      this._updateBtn()
    }
  }
}

const settingDefaultAiPicker = new ProviderModelPicker($('setting-default-ai-provider'), {
  compact: false,
  onChange: () => { applyDefaultModelToChildren(); autoSaveSystemSettings() }
})

const settingTransPicker = new ProviderModelPicker($('setting-trans-provider'), {
  compact: false,
  onChange: () => { updateSettingsUIVisibility(); autoSaveSystemSettings() }
})

const settingChatPicker = new ProviderModelPicker($('setting-chat-provider'), {
  compact: false,
  onChange: () => { updateSettingsUIVisibility(); autoSaveSystemSettings() }
})

const settingAnalysisPicker = new ProviderModelPicker($('setting-analysis-provider'), {
  compact: false,
  onChange: () => { updateSettingsUIVisibility(); autoSaveSystemSettings() }
})

const settingLibraryPicker = new ProviderModelPicker($('setting-library-provider'), {
  compact: false,
  onChange: () => { updateSettingsUIVisibility(); autoSaveSystemSettings() }
})

// marker와 mineru는 상충하는 transformers 버전이 필요하다. 서버 배포는 venv,
// Tauri 배포는 앱 데이터의 엔진별 패키지 폴더로 격리한다. Tauri에서는
// 어떤 엔진 전환도 앱을 재실행해 선택 엔진의 의존성만 로드한다.
let currentSavedPdfEngine = 'pymupdf'

// autoSaveSystemSettings 결과에 restarting이 담겨 있으면(설정 저장 API가
// 재시작이 트리거됐음을 알려준 것) 재시작 완료를 기다렸다가 새로고침한다.
async function maybeHandlePdfEngineRestart(res) {
  if (!res || !res.restarting) return false

  showToast(res.message || 'PDF 파서 엔진 적용을 위해 재시작합니다...', 'info')
  if (res.restart_mode === 'desktop_app' && isTauriDesktop) {
    try {
      // 앱 종료 이벤트에서 현재 sidecar를 정리한 뒤 새 프로세스를 시작한다.
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await new Promise(resolve => setTimeout(resolve, 500))
      await relaunch()
      return true
    } catch (err) {
      showToast('앱 재시작 실패: ' + (err.message || err), 'error')
      return false
    }
  }

  await waitForServerRestartAndReload()
  return true
}

const settingPdfParserPicker = new PdfParserPicker($('setting-pdf-parser-picker'), {
  onChange: async (selectedId) => {
    updateParserCardInfo(selectedId)
    const parser = pdfParsersData.find(p => p.id === selectedId) || PARSER_FALLBACK_META[selectedId]
    // 설치된 파서만 즉시 엔진 변경 저장. 미설치 파서는 카드의 [패키지 설치] 버튼을 눌러야 함.
    if (parser && parser.installed) {
      const needsRestartWarning = selectedId !== currentSavedPdfEngine &&
        (isTauriDesktop || selectedId === 'mineru' || currentSavedPdfEngine === 'mineru')
      if (needsRestartWarning) {
        const ok = await showCustomConfirm(
          `[${parser.name}](으)로 전환하면 ${isTauriDesktop ? '앱' : '서버'}이 재시작됩니다(약 3~5초 소요). 지금 진행 중인 번역이 있다면 중단될 수 있습니다. 계속할까요?`,
          { title: 'PDF 파서 엔진 전환', confirmText: '전환 및 재시작', danger: true }
        )
        if (!ok) {
          settingPdfParserPicker.setParsersData(pdfParsersData, currentSavedPdfEngine)
          updateParserCardInfo(currentSavedPdfEngine)
          return
        }
      }
      const res = await autoSaveSystemSettings({ silent: needsRestartWarning })
      currentSavedPdfEngine = selectedId
      const restarting = await maybeHandlePdfEngineRestart(res)
      if (!restarting) showToast(`PDF 파서 엔진이 [${parser.name}]로 설정되었습니다.`, 'success')
    }
  }
})

const modelSettingChildren = [
  { checkbox: settingTransSameAsDefault, picker: settingTransPicker, containerId: 'setting-trans-provider' },
  { checkbox: settingAnalysisSameAsDefault, picker: settingAnalysisPicker, containerId: 'setting-analysis-provider' },
  { checkbox: settingChatSameAsDefault, picker: settingChatPicker, containerId: 'setting-chat-provider' },
  { checkbox: settingLibrarySameAsDefault, picker: settingLibraryPicker, containerId: 'setting-library-provider' },
]

function applyDefaultModelToChild(child) {
  const checked = !!(child.checkbox && child.checkbox.checked)
  if (checked) {
    const { provider, model } = settingDefaultAiPicker.getValue()
    child.picker.setValue(provider, model)
  }
  const container = $(child.containerId)
  if (container) {
    container.style.opacity = checked ? '0.5' : ''
    container.style.pointerEvents = checked ? 'none' : ''
  }
}

function applyDefaultModelToChildren() {
  modelSettingChildren.forEach(applyDefaultModelToChild)
  updateSettingsUIVisibility()
}

modelSettingChildren.forEach(child => {
  if (child.checkbox) {
    child.checkbox.addEventListener('change', () => {
      applyDefaultModelToChild(child)
      updateSettingsUIVisibility()
    })
  }
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
  const defaultVal = settingDefaultAiPicker ? settingDefaultAiPicker.getValue() : { provider: 'antigravity' }
  const transVal = settingTransPicker ? settingTransPicker.getValue() : { provider: 'antigravity' }
  const chatVal = settingChatPicker ? settingChatPicker.getValue() : { provider: 'antigravity' }
  const analysisVal = settingAnalysisPicker ? settingAnalysisPicker.getValue() : chatVal
  const libraryVal = settingLibraryPicker ? settingLibraryPicker.getValue() : analysisVal

  const providers = new Set([defaultVal.provider, transVal.provider, chatVal.provider, analysisVal.provider, libraryVal.provider])

  // 1. Ollama 주소 (로컬 AI 사용 시) 표시 여부
  const hostGroup = $('setting-ollama-host-group')
  if (hostGroup) {
    hostGroup.style.display = providers.has('ollama') ? 'block' : 'none'
  }

  // 2. Ollama 모델 다운로드 섹션 표시 여부 (설치 여부에 따라 refreshOllamaInstallUI에서 최종 결정)
  if (providers.has('ollama')) {
    refreshOllamaInstallUI()
  } else {
    pullModelSection.classList.add('hidden')
    ollamaInstallSection.classList.add('hidden')
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

    // CLI 기반 엔진(Antigravity/Claude Code/Codex)의 실제 설치 여부를 반영 -
    // 이전에는 이 값이 한 번도 갱신되지 않아 항상 기본값(전부 사용 가능)으로 남아있었음
    try {
      state.cliAvailability = await fetchCliAvailability()
    } catch (err) {
      console.warn('CLI 가용성 조회 실패:', err)
    }

    settingOllamaHost.value = sys.ollama_host || ''
    const keyInputs = { openai: settingOpenAIKey, gemini: settingGeminiKey, claude: settingClaudeKey }
    Object.entries(keyInputs).forEach(([provider, input]) => {
      if (!input) return
      const status = sys.api_keys?.[provider] || { configured: false, masked: '' }
      input.value = ''
      input.dataset.configured = status.configured ? 'true' : 'false'
      input.dataset.deleteRequested = 'false'
      input.placeholder = status.configured
        ? t('settings:apiKeyConfigured', { masked: status.masked })
        : ({ openai: 'sk-...', gemini: 'AIzaSy...', claude: 'sk-ant-...' }[provider] || '')
      document.querySelector(`[data-api-key-delete="${provider}"]`)?.classList.toggle('hidden', !status.configured)
    })
    settingOpenAlexMailto.value = sys.openalex_mailto || ''

    const defaultProvider = sys.default_ai_provider || sys.trans_provider || 'antigravity'
    const defaultModel = sys.default_ai_model || sys.trans_model
    settingDefaultAiPicker.setValue(defaultProvider, defaultModel)
    viewerTransPicker.setValue(sys.trans_provider || defaultProvider, sys.trans_model || defaultModel)
    settingTransPicker.setValue(sys.trans_provider || 'antigravity', sys.trans_model)
    chatSidebarPicker.setValue(sys.chat_provider || 'antigravity', sys.chat_model)
    settingChatPicker.setValue(sys.chat_provider || 'antigravity', sys.chat_model)
    settingAnalysisPicker.setValue(sys.analysis_provider || sys.chat_provider || 'antigravity', sys.analysis_model || sys.chat_model)
    settingLibraryPicker.setValue(
      sys.library_provider || sys.analysis_provider || sys.chat_provider || 'antigravity',
      sys.library_model || sys.analysis_model || sys.chat_model
    )

    const sameAsDefault = (provider, model) =>
      !!defaultModel && provider === defaultProvider && model === defaultModel
    settingTransSameAsDefault.checked = sameAsDefault(sys.trans_provider, sys.trans_model)
    settingAnalysisSameAsDefault.checked = sameAsDefault(sys.analysis_provider, sys.analysis_model)
    settingChatSameAsDefault.checked = sameAsDefault(sys.chat_provider, sys.chat_model)
    settingLibrarySameAsDefault.checked = sameAsDefault(sys.library_provider, sys.library_model)
    applyDefaultModelToChildren()

    const promptTemplate = $('setting-prompt-template')
    if (promptTemplate) {
      promptTemplate.value = sys.translation_prompt_template || promptTemplate.value
    }
    updateSettingsUIVisibility()
    renderOllamaInstalledModels()
    updateRecommendModelButtons()
    await refreshPdfParsersUI(sys.pdf_parser_engine || 'pymupdf')

  } catch (err) {
    console.warn('System settings load error:', err)
  }
}

function renderOllamaInstalledModels() {
  const container = $('ollama-installed-models-list')
  if (!container) return

  const downloaded = state.availableOllamaModels || []
  const actualModels = downloaded.filter(m => m && m !== 'custom_input')

  if (actualModels.length === 0) {
    container.innerHTML = `<div style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">설치된 Ollama 모델이 없습니다. 아래 추천 모델 또는 직접 입력으로 다운로드해 주세요.</div>`
    return
  }

  const defaultVal = settingDefaultAiPicker ? settingDefaultAiPicker.getValue() : {}
  const transVal = settingTransPicker ? settingTransPicker.getValue() : {}
  const chatVal = settingChatPicker ? settingChatPicker.getValue() : {}
  const analysisVal = settingAnalysisPicker ? settingAnalysisPicker.getValue() : {}
  const libraryVal = settingLibraryPicker ? settingLibraryPicker.getValue() : {}

  container.innerHTML = ''
  actualModels.forEach(modelName => {
    const row = document.createElement('div')
    row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12.5px; gap: 8px;'

    const activeGroups = [
      ['기본', defaultVal],
      ['번역', transVal],
      ['채팅', chatVal],
      ['분석', analysisVal],
      ['라이브러리', libraryVal],
    ].filter(([, value]) => value.provider === 'ollama' && value.model === modelName)
      .map(([label]) => label)
    const inUseBadge = activeGroups.length
      ? `<span style="font-size: 10.5px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: rgba(74, 135, 181, 0.15); color: var(--accent-mid); margin-left: 6px; white-space: nowrap;">(${activeGroups.join('/')} 사용 중)</span>`
      : ''

    const left = document.createElement('div')
    left.style.cssText = 'display: flex; align-items: center; gap: 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; flex: 1;'
    left.innerHTML = `<span style="font-weight: 600; color: var(--text-primary); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis;">${escapeHtml(modelName)}</span>${inUseBadge}`

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'btn btn-secondary'
    deleteBtn.style.cssText = 'padding: 4px 10px; font-size: 11.5px; color: var(--color-danger, #ef4444); border-color: rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.05); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; flex-shrink: 0; border-radius: var(--radius-sm); font-weight: 500;'
    deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>삭제`

    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const confirm = await showCustomConfirm(`'${modelName}' 모델을 진짜로 삭제하시겠습니까?\n(Ollama 서버 디스크 공간에서 해당 모델 파일이 삭제됩니다)`, {
        title: 'Ollama 모델 삭제',
        confirmText: '삭제',
        danger: true
      })
      if (!confirm) return

      deleteBtn.disabled = true
      deleteBtn.textContent = '삭제 중...'
      try {
        await deleteModelAPI(modelName)
        showToast(`모델 '${modelName}'이(가) 성공적으로 삭제되었습니다.`, 'success')
        await refreshSystemSettings()
      } catch (err) {
        showToast(`삭제 실패: ${err.message}`, 'error')
        deleteBtn.disabled = false
        deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>삭제`
      }
    })

    row.appendChild(left)
    row.appendChild(deleteBtn)
    container.appendChild(row)
  })
}

export function isOllamaModelMatch(installedName, targetName) {
  if (!installedName || !targetName) return false
  if (targetName === 'custom_input' || installedName === 'custom_input') return false

  const cleanInst = installedName.trim().toLowerCase()
  const cleanTarget = targetName.trim().toLowerCase()

  if (cleanInst === cleanTarget) return true

  // 태그 분리 (:latest 생략 케이스 대응)
  const [instBase, instTag = 'latest'] = cleanInst.split(':')
  const [targetBase, targetTag = 'latest'] = cleanTarget.split(':')

  return instBase === targetBase && instTag === targetTag
}

function updateRecommendModelButtons() {
  const downloaded = state.availableOllamaModels || []

  document.querySelectorAll('.recommend-model-btn').forEach(btn => {
    const model = btn.getAttribute('data-model')
    if (!model) return
    const isInstalled = downloaded.some(dm => isOllamaModelMatch(dm, model))
    const baseLabel = btn.textContent.replace(' (설치됨)', '')
    if (isInstalled) {
      btn.textContent = `${baseLabel} (설치됨)`
      btn.style.borderColor = 'rgba(74, 135, 181, 0.4)'
      btn.style.background = 'rgba(74, 135, 181, 0.1)'
      btn.style.color = 'var(--accent-mid)'
    } else {
      btn.textContent = baseLabel
      btn.style.borderColor = 'var(--border-strong)'
      btn.style.background = 'var(--bg-secondary)'
      btn.style.color = 'var(--text-primary)'
    }
  })
}



// ── PDF 파서 엔진 선택 및 동적 설치 UI 핸들러 ──────────────────
let pdfParsersData = []
let targetInstallParserId = null

const PARSER_FALLBACK_META = {
  pymupdf: { id: 'pymupdf', name: 'PyMuPDF (fitz)', installed: true, size_info: '0 MB', description: '기본 제공 파서 - 텍스트 중심 문서에서 초고속으로 작동합니다.', pros: '초고속 (몇 ms 내 처리), 별도 설치 필요 없음', cons: '2단 복잡 구조, 수식 텍스트 엉킴 발생 가능' },
  pdfplumber: { id: 'pdfplumber', name: 'pdfplumber', installed: false, size_info: '약 15 MB', description: 'Python 기반 파서 - 표(Table) 추출 및 텍스트 위치 정밀 추적에 강점.', pros: '표(Table) 파싱 우수, 정밀 좌표 추적', cons: '소폭 더 큼, 수식 OCR 미지정' },
  marker: { id: 'marker', name: 'Marker (AI Markdown)', installed: false, size_info: '약 2.5 GB', description: '딥러닝 비전/레이아웃 AI - 논문 전체를 깨끗한 Markdown/LaTeX 수식으로 변환.', pros: '수식, 표, 2단 레이아웃 매우 정밀 분석', cons: '최초 모델 설치 시 대용량 다운로드 필요' },
  mineru: { id: 'mineru', name: 'MinerU (Magic-PDF)', installed: false, size_info: '약 3.0 GB', description: 'OpenDataLab 학술 서적 및 복잡 레이아웃 전문 추출 파서.', pros: '복잡 서적, 수식, 다단 구조 추출 최강', cons: '최초 모델 설치 시 대용량 다운로드 필요' }
}

async function refreshPdfParsersUI(savedEngine) {
  try {
    const data = await fetchPdfParsersInfoAPI()
    pdfParsersData = data.parsers || []
    const currentEngine = savedEngine || data.current_engine || 'pymupdf'
    currentSavedPdfEngine = currentEngine

    if (typeof settingPdfParserPicker !== 'undefined' && settingPdfParserPicker) {
      settingPdfParserPicker.setParsersData(pdfParsersData, currentEngine)
    }

    updateParserCardInfo(currentEngine)
  } catch (err) {
    console.warn('PDF 파서 목록 로드 실패:', err)
    currentSavedPdfEngine = savedEngine || 'pymupdf'
    if (typeof settingPdfParserPicker !== 'undefined' && settingPdfParserPicker) {
      settingPdfParserPicker.setParsersData(Object.values(PARSER_FALLBACK_META), savedEngine || 'pymupdf')
    }
    updateParserCardInfo(savedEngine || 'pymupdf')
  }
}

function clearParserInlineProgress() {
  const inlineProgress = $('pdf-parser-inline-progress')
  const inlineLog = $('pdf-parser-inline-log')
  const inlineStatus = $('pdf-parser-inline-status')
  if (inlineProgress) inlineProgress.classList.add('hidden')
  if (inlineLog) inlineLog.textContent = ''
  if (inlineStatus) inlineStatus.innerHTML = ''
}

function updateParserCardInfo(engineId) {
  const cardName = $('pdf-parser-card-name')
  const cardDesc = $('pdf-parser-card-desc')
  const cardPros = $('pdf-parser-card-pros')
  const cardCons = $('pdf-parser-card-cons')
  const installRow = $('pdf-parser-install-row')
  const installBtn = $('pdf-parser-install-btn')
  const uninstallRow = $('pdf-parser-uninstall-row')
  const uninstallBtn = $('pdf-parser-uninstall-btn')

  const parser = pdfParsersData.find(p => p.id === engineId) || PARSER_FALLBACK_META[engineId] || PARSER_FALLBACK_META.pymupdf
  if (!parser) return

  // 파서 변경 시 인라인 설치 로그 초기화
  clearParserInlineProgress()

  if (cardName) cardName.textContent = `${parser.name} ${parser.installed ? '(설치됨)' : `(${parser.size_info})`}`
  if (cardDesc) cardDesc.textContent = parser.description
  if (cardPros) cardPros.textContent = parser.pros
  if (cardCons) cardCons.textContent = parser.cons

  // 설치 버튼: pymupdf 제외, 미설치인 경우만 표시
  if (installRow) {
    if (parser.id !== 'pymupdf' && !parser.installed) {
      installRow.classList.remove('hidden')
    } else {
      installRow.classList.add('hidden')
    }
  }

  if (installBtn) {
    const newInstallBtn = installBtn.cloneNode(true)
    installBtn.parentNode.replaceChild(newInstallBtn, installBtn)
    newInstallBtn.addEventListener('click', () => {
      targetInstallParserId = parser.id
      openPdfParserInstallModal(parser)
    })
  }

  // 삭제 버튼: pymupdf 제외, 설치된 경우만 표시
  if (uninstallRow) {
    if (parser.id !== 'pymupdf' && parser.installed) {
      uninstallRow.classList.remove('hidden')
    } else {
      uninstallRow.classList.add('hidden')
    }
  }

  // 삭제 버튼 클릭 이벤트 연결 (매번 바인드 방지용 클론)
  if (uninstallBtn) {
    const newBtn = uninstallBtn.cloneNode(true)
    uninstallBtn.parentNode.replaceChild(newBtn, uninstallBtn)
    newBtn.addEventListener('click', async () => {
      const ok = await showCustomConfirm(`[${parser.name}] 파서 패키지를 가상환경(.venv)에서 삭제하시겠습니까?`, {
        title: '파서 패키지 삭제', confirmText: '삭제', danger: true
      })
      if (!ok) return
      try {
        showToast(`[${parser.name}] 패키지 삭제 진행 중...`, 'info')
        await uninstallPdfParserAPI(parser.id)
        showToast(`[${parser.name}] 패키지 삭제가 완료되었습니다.`, 'success')
        clearParserInlineProgress()
        await refreshSystemSettings()
      } catch (err) {
        showToast(`삭제 실패: ${err.message}`, 'error')
      }
    })
  }
}

function openPdfParserInstallModal(parser) {
  const modal = $('pdf-parser-install-modal')
  const introArea = $('pdf-parser-install-intro')
  const progressArea = $('pdf-parser-install-progress-area')
  const statusText = $('pdf-parser-install-status-text')
  const logElem = $('pdf-parser-install-log')
  const doneBtn = $('pdf-parser-install-done-btn')

  // 설정 카드 내부 인라인 엘리먼트
  const inlineProgressArea = $('pdf-parser-inline-progress')
  const inlineStatusText = $('pdf-parser-inline-status')
  const inlineLogElem = $('pdf-parser-inline-log')

  if (introArea) introArea.classList.add('hidden')
  if (progressArea) progressArea.classList.remove('hidden')
  if (inlineProgressArea) inlineProgressArea.classList.remove('hidden')

  if (logElem) logElem.textContent = ''
  if (inlineLogElem) inlineLogElem.textContent = ''
  if (doneBtn) doneBtn.classList.add('hidden')

  const initialMsg = `<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> 백엔드 가상환경에 [${parser.name}] 설치 진행 중...`
  if (statusText) statusText.innerHTML = initialMsg
  if (inlineStatusText) inlineStatusText.innerHTML = initialMsg

  openOverlayModal(modal)

  installPdfParserAPI(
    parser.id,
    (line) => {
      if (logElem) {
        logElem.textContent += line + '\n'
        logElem.scrollTop = logElem.scrollHeight
      }
      if (inlineLogElem) {
        inlineLogElem.textContent += line + '\n'
        inlineLogElem.scrollTop = inlineLogElem.scrollHeight
      }
    },
    async (successMsg) => {
      const succMsg = `<span style="color: var(--accent-mid); font-weight:600;">✓ [${parser.name}] 설치가 성공적으로 완료되었습니다!</span>`
      if (statusText) statusText.innerHTML = succMsg
      if (inlineStatusText) inlineStatusText.innerHTML = succMsg
      if (doneBtn) doneBtn.classList.remove('hidden')
      const res = await autoSaveSystemSettings({ silent: true })
      currentSavedPdfEngine = parser.id
      const restarting = await maybeHandlePdfEngineRestart(res)
      if (!restarting) await refreshSystemSettings()
    },
    async (err) => {
      const errMsg = `<span style="color: var(--danger, #ef4444); font-weight:600;">✕ 설치 중 오류 발생: ${err.message}</span>`
      if (statusText) statusText.innerHTML = errMsg
      if (inlineStatusText) inlineStatusText.innerHTML = errMsg
      if (doneBtn) doneBtn.classList.remove('hidden')
      await refreshSystemSettings()
    }
  )
}

const parserInstallCancelBtn = $('pdf-parser-install-cancel-btn')
const parserInstallCloseBtn = $('pdf-parser-install-close-btn')
const parserInstallModal = $('pdf-parser-install-modal')
const parserInstallDoneBtn = $('pdf-parser-install-done-btn')

if (parserInstallCancelBtn) {
  parserInstallCancelBtn.addEventListener('click', async () => {
    closeOverlayModal(parserInstallModal)
    await refreshSystemSettings()
  })
}

if (parserInstallCloseBtn) {
  parserInstallCloseBtn.addEventListener('click', async () => {
    closeOverlayModal(parserInstallModal)
    await refreshSystemSettings()
  })
}

if (parserInstallDoneBtn) {
  parserInstallDoneBtn.addEventListener('click', async () => {
    closeOverlayModal(parserInstallModal)
    await refreshSystemSettings()
  })
}

// ── Provider + Model 통합 변경 헬퍼 ──────────────────
async function changeProviderAndModel(type, newProvider, newModel) {
  try {
    const sys = await getSystemSettingsAPI()
    const nextTrans = {
      provider: type === 'trans' ? newProvider : (sys.trans_provider || 'antigravity'),
      model: type === 'trans' ? newModel : (sys.trans_model || '')
    }
    const nextChat = {
      provider: type === 'chat' ? newProvider : (sys.chat_provider || 'antigravity'),
      model: type === 'chat' ? newModel : (sys.chat_model || '')
    }
    const payload = {
      ollama_host: sys.ollama_host || '',
      default_ai_provider: sys.default_ai_provider || sys.trans_provider || 'antigravity',
      default_ai_model: sys.default_ai_model || sys.trans_model || '',
      trans_provider: nextTrans.provider,
      trans_model: nextTrans.model,
      chat_provider: nextChat.provider,
      chat_model: nextChat.model,
      analysis_provider: sys.analysis_provider || sys.chat_provider || 'antigravity',
      analysis_model: sys.analysis_model || sys.chat_model || '',
      library_provider: sys.library_provider || sys.analysis_provider || sys.chat_provider || 'antigravity',
      library_model: sys.library_model || sys.analysis_model || sys.chat_model || '',
      openai_api_key: '',
      gemini_api_key: '',
      claude_api_key: '',
      openalex_mailto: sys.openalex_mailto || '',
      translation_prompt_template: sys.translation_prompt_template || '',
      pdf_parser_engine: sys.pdf_parser_engine || 'pymupdf'
    }
    await saveSystemSettingsAPI(payload)
    // sync settings pickers
    if (type === 'trans') {
      settingTransPicker.setValue(newProvider, newModel)
      if (settingTransSameAsDefault) settingTransSameAsDefault.checked = false
    } else {
      settingChatPicker.setValue(newProvider, newModel)
      if (settingChatSameAsDefault) settingChatSameAsDefault.checked = false
    }
    updateSettingsUIVisibility()
    await checkAIStatus()
    showToast(`${type === 'trans' ? '번역' : '어시스턴트'} AI가 변경되었습니다.`, 'success')
    if (type === 'trans' && state.sessionId) {
      const ok = await showCustomConfirm('번역 AI가 변경되었습니다. 기존 캐시를 삭제하고 처음부터 다시 번역하시겠습니까?', { title: 'AI 변경으로 인한 재번역', confirmText: '재번역', danger: true })
      if (ok) {
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
  await loadNamespaces(['settings', 'errors'])
  openOverlayModal(settingsModal)

  // 1. 기본적으로 첫 번째 탭(일반 설정)을 활성화
  tabBtns.forEach(b => b.classList.remove('active'))
  tabPanes.forEach(p => p.classList.remove('active'))
  tabBtns[0].classList.add('active')
  tabPanes[0].classList.add('active')

  // 2. 일반 설정값 로드
  syncModeSettings(workspaceModeController.getMode())
  settingDefaultZoom.value = localStorage.getItem('easypaper_default_zoom') || '1.5'
  settingToolbarPosition.value = getToolbarPosition()
  // 아래 항목은 모드와 관계없는 공통 뷰어 설정이다.
  settingDisableHoverTooltip.checked = !state.disableHoverTooltip
  settingDisableBookmark.checked = !state.disableBookmark
  settingToolbarAutoHide.checked = state.toolbarAutoHide
  updateAccentSettingsUI(currentAccentColor)

  // 3. 시스템 설정값 로드 (백엔드 통신)
  await refreshSystemSettings()

  // 4. 계정 변경값 초기화
  changeCurrentPassword.value = ''
  changeNewUsername.value = state.username || 'admin'
  changeNewPassword.value = ''
  changeNewPasswordConfirm.value = ''

  // 5. 로그인 생략 설정값 로드
  if (settingSkipLoginCheckbox) {
    try {
      const { enabled } = await getSkipLoginAPI()
      settingSkipLoginCheckbox.checked = enabled
    } catch (err) {
      console.warn('로그인 생략 설정 로드 실패:', err)
    }
  }
})

closeSettingsBtn.addEventListener('click', () => {
  clearParserInlineProgress()
  closeOverlayModal(settingsModal)
})

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    clearParserInlineProgress()
    closeOverlayModal(settingsModal)
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

// Ollama 미설치 시 설치 섹션과 모델 다운로드 섹션 중 무엇을 보여줄지 결정
let ollamaStatusCheckInFlight = false
async function refreshOllamaInstallUI() {
  if (ollamaStatusCheckInFlight) return
  ollamaStatusCheckInFlight = true
  try {
    const { installed, is_local } = await getOllamaStatusAPI()
    if (installed) {
      ollamaInstallSection.classList.add('hidden')
      pullModelSection.classList.remove('hidden')
    } else {
      pullModelSection.classList.add('hidden')
      ollamaInstallSection.classList.remove('hidden')
      ollamaInstallNotLocal.classList.toggle('hidden', is_local)
      ollamaInstallPrompt.classList.toggle('hidden', !is_local)
    }
  } catch (err) {
    console.warn('Ollama 상태 확인 실패:', err)
  } finally {
    ollamaStatusCheckInFlight = false
  }
}

// Ollama 설치
ollamaInstallBtn.addEventListener('click', () => {
  ollamaInstallBtn.disabled = true
  ollamaInstallBtn.textContent = '설치 중...'
  ollamaInstallProgressArea.classList.remove('hidden')
  ollamaInstallLog.textContent = ''

  showToast('Ollama 설치를 시작합니다. 다소 시간이 걸릴 수 있습니다.', 'info')

  streamInstallOllamaAPI(
    (data) => {
      if (data.line) {
        ollamaInstallLog.textContent += data.line + '\n'
        ollamaInstallLog.scrollTop = ollamaInstallLog.scrollHeight
      }
    },
    async () => {
      showToast('Ollama 설치가 완료되었습니다!', 'success')
      ollamaInstallBtn.disabled = false
      ollamaInstallBtn.textContent = 'Ollama 설치하기'
      ollamaInstallProgressArea.classList.add('hidden')
      await refreshOllamaInstallUI()
    },
    (err) => {
      showToast(`Ollama 설치 실패: ${err.message}`, 'error')
      ollamaInstallBtn.disabled = false
      ollamaInstallBtn.textContent = 'Ollama 설치하기'
    }
  )
})

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
  btn.addEventListener('click', async () => {
    const model = btn.dataset.model
    if (!model) return
    const downloaded = state.availableOllamaModels || []
    const isInstalled = downloaded.some(dm => isOllamaModelMatch(dm, model))
    if (isInstalled) {
      const ok = await showCustomConfirm(`'${model}' 모델은 이미 설치되어 있습니다. 다시 다운로드하시겠습니까?`, {
        title: '모델 재다운로드',
        confirmText: '다시 다운로드',
        danger: false
      })
      if (!ok) return
    }
    settingPullModelName.value = model
    settingPullModelBtn.click()
  })
})



// 일반 설정: 저장 버튼 없이 필드 변경 즉시 저장한다. 번역 결과에 영향을 주는
// 필드(대상 언어/문체/모드/제외 요소)가 바뀌면 기존과 동일하게 재번역을 제안하고,
// 줌/툴바 위치처럼 뷰어 표시에만 영향을 주는 필드는 저장 후 바로 적용만 한다.
function persistGeneralSettingsToStorage() {
  setModeSetting('targetLang', settingsTranslationModeContext, settingTargetLang.value)
  setModeSetting('style', settingsTranslationModeContext, settingTransStyle.value)
  setModeSetting('translationMode', settingsTranslationModeContext, settingTranslationMode.value)
  setModeSetting('keywordMode', settingsTranslationModeContext, settingAutoGenerateKeywords.checked ? 'auto' : 'manual')
  setModeSetting('summaryMode', settingsTranslationModeContext, settingAutoGenerateSummaries.checked ? 'auto' : 'manual')
  setModeSetting('ignoreMath', settingsTranslationModeContext, settingIgnoreMath.checked)
  setModeSetting('ignoreTable', settingsTranslationModeContext, settingIgnoreTable.checked)
  setModeSetting('ignoreRefs', settingsTranslationModeContext, settingIgnoreRefs.checked)
  localStorage.setItem('easypaper_default_zoom', settingDefaultZoom.value)
  localStorage.setItem('easypaper_toolbar_position', settingToolbarPosition.value)
}

async function handleTranslationAffectingSettingChange() {
  persistGeneralSettingsToStorage()
  showToast(`${settingsTranslationModeContext === 'general' ? '일반 문서' : '연구'} 모드 설정이 저장되었습니다.`, 'success')

  // 현재 논문을 작업 중인 경우 번역 잡 재시작 제안
  if (state.sessionId && normalizeSettingsMode(state.currentDocumentMode) === settingsTranslationModeContext) {
    const ok = await showCustomConfirm('번역 설정을 즉시 변경하고 다시 번역하시겠습니까?\n(확인을 누르면 기존 번역이 초기화되고 새로 번역을 시작합니다.)', { title: '설정 변경 및 재번역', confirmText: '재번역', danger: true })
    if (ok) {
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
          contentEl.innerHTML = getTranslationPlaceholderHtml(i)
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
}

;[settingTargetLang, settingTransStyle, settingTranslationMode, settingIgnoreMath, settingIgnoreTable, settingIgnoreRefs].forEach(el => {
  el.addEventListener('change', handleTranslationAffectingSettingChange)
})

settingDefaultZoom.addEventListener('change', () => {
  persistGeneralSettingsToStorage()
  showToast('일반 설정이 저장되었습니다.', 'success')
  const newZoom = parseFloat(settingDefaultZoom.value) || 1.5
  if (state.sessionId) {
    setZoom(newZoom)
  }
})

settingToolbarPosition.addEventListener('change', () => {
  persistGeneralSettingsToStorage()
  applyToolbarPosition(settingToolbarPosition.value)
  showToast('일반 설정이 저장되었습니다.', 'success')
})

// 뷰어 편의 설정: 번역 관련 설정이 아니므로 폼 제출(및 재번역 제안)과 무관하게
// 체크 즉시 저장하고 바로 적용한다.
settingDisableHoverTooltip.addEventListener('change', () => {
  state.disableHoverTooltip = !settingDisableHoverTooltip.checked
  localStorage.setItem('easypaper_disable_hover_tooltip', state.disableHoverTooltip)
})

settingDisableBookmark.addEventListener('change', () => {
  state.disableBookmark = !settingDisableBookmark.checked
  localStorage.setItem('easypaper_disable_bookmark', state.disableBookmark)
})

settingDisableInsights.addEventListener('change', () => {
  const disabled = !settingDisableInsights.checked
  setModeSetting('disableInsights', settingsTranslationModeContext, disabled)
  if (state.sessionId && normalizeSettingsMode(state.currentDocumentMode) === settingsTranslationModeContext) {
    state.disableInsights = disabled
    applyInsightsTabVisibility()
  }
})

// 이미 렌더링되어 있는 페이지들의 오버레이 레이어를 다시 그려 설정 변경을
// 즉시 반영한다 (renderXOverlayLayer는 항상 기존 박스를 지우고 나서 다시
// 그리므로, 꺼진 상태면 지우기만 하고 끝난다).
function refreshAllPageOverlays() {
  document.querySelectorAll('.textLayer').forEach(textLayerDiv => {
    const pageWrapper = textLayerDiv.closest('.pdf-page-wrapper')
    if (!pageWrapper) return
    const pageNum = parseInt(pageWrapper.dataset.page)
    renderCitationOverlayLayer(textLayerDiv, pageNum)
    renderFigureRefOverlayLayer(textLayerDiv, pageNum)
  })
}

settingDisableCitationOverlay.addEventListener('change', () => {
  const disabled = !settingDisableCitationOverlay.checked
  setModeSetting('disableCitationOverlay', settingsTranslationModeContext, disabled)
  if (state.sessionId && normalizeSettingsMode(state.currentDocumentMode) === settingsTranslationModeContext) {
    state.disableCitationOverlay = disabled
    refreshAllPageOverlays()
  }
})

settingDisableFigureOverlay.addEventListener('change', () => {
  const disabled = !settingDisableFigureOverlay.checked
  setModeSetting('disableFigureOverlay', settingsTranslationModeContext, disabled)
  if (state.sessionId && normalizeSettingsMode(state.currentDocumentMode) === settingsTranslationModeContext) {
    state.disableFigureOverlay = disabled
    refreshAllPageOverlays()
  }
})

settingDisablePrimer.addEventListener('change', () => {
  const disabled = !settingDisablePrimer.checked
  setModeSetting('disablePrimer', settingsTranslationModeContext, disabled)
  if (state.sessionId && normalizeSettingsMode(state.currentDocumentMode) === settingsTranslationModeContext) {
    state.disablePrimer = disabled
  }
})

settingToolbarAutoHide.addEventListener('change', () => {
  state.toolbarAutoHide = settingToolbarAutoHide.checked
  localStorage.setItem('easypaper_toolbar_autohide', state.toolbarAutoHide)
  // 기능을 끄면 스크롤 위치와 무관하게 즉시 툴바를 다시 보여준다 - 꺼둔 채로
  // 숨겨진 상태가 남아있으면 툴바가 영영 안 보이는 것처럼 느껴질 수 있다.
  if (!state.toolbarAutoHide) setToolbarHidden(false)
})

// 모델 설정(시스템 설정) + 고급 설정(번역 프롬프트)은 백엔드에 하나의 설정
// 객체로 저장되므로, 저장 버튼 없이 두 탭의 어느 필드든 값이 바뀌면 즉시 이
// 통합 함수로 전체 설정을 다시 저장한다. 모델이 아직 선택되지 않은 초기
// 로딩 상태에서는 조용히 건너뛴다(에러 토스트 없이).
async function autoSaveSystemSettings({ silent = false } = {}) {
  const { provider: defaultProvider, model: defaultModel } = settingDefaultAiPicker.getValue()
  let { provider: transProvider, model: transModel } = settingTransPicker.getValue()
  if (settingTransSameAsDefault && settingTransSameAsDefault.checked) {
    transProvider = defaultProvider
    transModel = defaultModel
  }
  let { provider: chatProvider, model: chatModel } = settingChatPicker.getValue()
  if (settingChatSameAsDefault && settingChatSameAsDefault.checked) {
    chatProvider = defaultProvider
    chatModel = defaultModel
  }
  let { provider: analysisProvider, model: analysisModel } = settingAnalysisPicker.getValue()
  if (settingAnalysisSameAsDefault && settingAnalysisSameAsDefault.checked) {
    analysisProvider = defaultProvider
    analysisModel = defaultModel
  }
  let { provider: libraryProvider, model: libraryModel } = settingLibraryPicker.getValue()
  if (settingLibrarySameAsDefault && settingLibrarySameAsDefault.checked) {
    libraryProvider = defaultProvider
    libraryModel = defaultModel
  }

  const pdfParserEngine = (typeof settingPdfParserPicker !== 'undefined' && settingPdfParserPicker) ? settingPdfParserPicker.getValue() : 'pymupdf'

  const settings = {
    ollama_host: settingOllamaHost ? settingOllamaHost.value.trim() : '',
    default_ai_provider: defaultProvider || 'antigravity',
    default_ai_model: defaultModel || '',
    trans_provider: transProvider || 'antigravity',
    trans_model: transModel || '',
    chat_provider: chatProvider || 'antigravity',
    chat_model: chatModel || '',
    analysis_provider: analysisProvider || chatProvider || 'antigravity',
    analysis_model: analysisModel || chatModel || '',
    library_provider: libraryProvider || analysisProvider || chatProvider || 'antigravity',
    library_model: libraryModel || analysisModel || chatModel || '',
    openai_api_key: settingOpenAIKey ? settingOpenAIKey.value.trim() : '',
    gemini_api_key: settingGeminiKey ? settingGeminiKey.value.trim() : '',
    claude_api_key: settingClaudeKey ? settingClaudeKey.value.trim() : '',
    delete_openai_api_key: settingOpenAIKey?.dataset.deleteRequested === 'true',
    delete_gemini_api_key: settingGeminiKey?.dataset.deleteRequested === 'true',
    delete_claude_api_key: settingClaudeKey?.dataset.deleteRequested === 'true',
    openalex_mailto: settingOpenAlexMailto ? settingOpenAlexMailto.value.trim() : '',
    translation_prompt_template: $('setting-prompt-template') ? $('setting-prompt-template').value : '',
    pdf_parser_engine: pdfParserEngine
  }

  try {
    const res = await saveSystemSettingsAPI(settings)
    // sync compact pickers
    if (transProvider && transModel) viewerTransPicker.setValue(transProvider, transModel)
    if (chatProvider && chatModel) chatSidebarPicker.setValue(chatProvider, chatModel)
    if (!silent) showToast('설정이 저장되었습니다.', 'success')
    checkAIStatus()
    return res
  } catch (err) {
    showToast(err.message, 'error')
    return null
  }
}

;[settingOllamaHost, settingOpenAIKey, settingGeminiKey, settingClaudeKey, settingOpenAlexMailto].forEach(el => {
  if (el) el.addEventListener('change', () => autoSaveSystemSettings())
})

;[settingOpenAIKey, settingGeminiKey, settingClaudeKey].forEach(input => {
  input?.addEventListener('input', () => { if (input.value.trim()) input.dataset.deleteRequested = 'false' })
})
document.querySelectorAll('[data-api-key-delete]').forEach(button => {
  button.addEventListener('click', async () => {
    const input = $(`setting-${button.dataset.apiKeyDelete}-key`)
    if (!input) return
    input.value = ''
    input.dataset.deleteRequested = 'true'
    await autoSaveSystemSettings({ silent: true })
    await refreshSystemSettings()
    showToast(t('settings:saved'), 'success')
  })
})

;[settingAutoGenerateKeywords, settingAutoGenerateSummaries].forEach(el => {
  if (el) el.addEventListener('change', () => {
    persistGeneralSettingsToStorage()
    showToast('일반 설정이 저장되었습니다.', 'success')
  })
})

modelSettingChildren.forEach(child => {
  if (child.checkbox) child.checkbox.addEventListener('change', () => autoSaveSystemSettings())
})

const settingPromptTemplate = $('setting-prompt-template')
if (settingPromptTemplate) {
  settingPromptTemplate.addEventListener('change', () => autoSaveSystemSettings())
}

// 시스템 자동 업데이트: 확인(check)과 실행(run)을 분리한다 - 확인해서 새
// 업데이트가 있을 때만 실행 버튼이 활성화되고, 확인 시 변경 로그를 함께
// 보여준다. (waitForServerRestartAndReload/renderChangelogList/
// formatVersionLabel은 이 파일 아래쪽에 정의되어 있지만 function 선언이라
// 호이스팅되어 여기서도 안전하게 쓸 수 있다.)
const systemUpdateCheckBtn = $('system-update-check-btn')
const systemUpdateRunBtn = $('system-update-run-btn')
const systemUpdateStatus = $('system-update-status')
const systemUpdateChangelogBox = $('system-update-changelog-box')
const systemUpdateVersionLine = $('system-update-version-line')
const systemUpdateChangelogList = $('system-update-changelog')

let pendingSystemUpdateAvailable = false

function resetSystemUpdateCheckState() {
  pendingSystemUpdateAvailable = false
  if (systemUpdateRunBtn) systemUpdateRunBtn.disabled = true
  if (systemUpdateChangelogBox) systemUpdateChangelogBox.classList.add('hidden')
}

// 이 섹션의 "업데이트 확인/실행"은 git pull + npm build + systemctl(또는 자체
// 프로세스) 재시작을 수행한다 - git 저장소 없이 인스톨러로 배포되는 Tauri
// 데스크탑 빌드에서는 애초에 동작할 수 없는 전제라 UI 자체를 숨긴다. 백엔드
// 라우트는 서버/Docker 배포에서 계속 써야 하므로 그대로 둔다(변경 없음).
// window.__TAURI_INTERNALS__는 Tauri v2 webview에서만 주입되는 전역 값이다.
const isTauriDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const systemUpdateSection = $('system-update-section')
if (isTauriDesktop && systemUpdateSection) {
  systemUpdateSection.classList.add('hidden')
}

// ── 데스크탑(Tauri) 자체 업데이트: tauri-plugin-updater를 프론트에서 직접 호출한다.
// 기존에는 Rust 쪽 setup()에서 check()만 호출하고 결과를 로그에 남기는 게
// 전부라, 새 버전이 있어도 사용자에게 전달되거나 실제로 설치되는 경로가
// 전혀 없었다. updater:default 권한(check/download/install)과
// process:allow-restart 권한은 이미 capabilities/default.json에 있었으므로
// (스파이크 때 미리 넣어뒀던 것으로 보임) 프론트 바인딩만 연결하면 된다.
const tauriUpdateSection = $('tauri-update-section')
const tauriCurrentVersionLabel = $('tauri-current-version-label')
const tauriUpdateCheckBtn = $('tauri-update-check-btn')
const tauriUpdateInstallBtn = $('tauri-update-install-btn')
const tauriUpdateStatus = $('tauri-update-status')
const tauriUpdateNotesBox = $('tauri-update-notes-box')
const tauriUpdateVersionLine = $('tauri-update-version-line')
const tauriUpdateNotes = $('tauri-update-notes')
const settingTauriUpdateCheckInterval = $('setting-tauri-update-check-interval')

let pendingTauriUpdate = null
// 같은 버전으로는 팝업을 한 세션에 한 번만 띄운다 - "나중에"를 눌러도
// 주기적 재확인 때마다 같은 안내가 반복해서 뜨는 것을 막기 위함.
let lastNotifiedTauriUpdateVersion = null

// 데스크탑판 자동 업데이트 확인 주기 설정. 웹(git 기반) 배포판은 서버 쪽
// DB에 last_checked_at을 저장하지만(getUpdateCheckConfigAPI), 데스크탑은
// 사용자별 로컬 앱 설정이라 서버에 저장할 이유가 없어 localStorage를 쓴다.
const TAURI_UPDATE_CHECK_STORAGE_KEY = 'easypaper_tauri_update_check_interval'
const TAURI_UPDATE_LAST_CHECKED_STORAGE_KEY = 'easypaper_tauri_update_last_checked_at'

function getTauriUpdateCheckInterval() {
  return localStorage.getItem(TAURI_UPDATE_CHECK_STORAGE_KEY) || 'weekly'
}

if (settingTauriUpdateCheckInterval) {
  settingTauriUpdateCheckInterval.value = getTauriUpdateCheckInterval()
  settingTauriUpdateCheckInterval.addEventListener('change', () => {
    localStorage.setItem(TAURI_UPDATE_CHECK_STORAGE_KEY, settingTauriUpdateCheckInterval.value)
  })
  globalSettingsBtn.addEventListener('click', () => {
    settingTauriUpdateCheckInterval.value = getTauriUpdateCheckInterval()
  })
}

// 로그인 시 1회 체크로는 앱을 오래 켜둔 사용자가 새 버전을 놓칠 수 있어,
// 앱이 열려 있는 동안에도 재확인이 필요하다. 그렇다고 설정된 간격(매일/매주)
// 그대로 setInterval을 걸면 앱을 그 간격보다 짧게 켰다 껐다 하는 사용자는
// 영영 체크가 안 도는 문제가 생기므로, 웹의 maybeAutoCheckForUpdate와 동일한
// 방식을 쓴다 - 짧은 주기(1시간)로 깨어나 "마지막 확인 이후 설정된 간격이
// 지났는지"만 가볍게 확인하고, 지났을 때만 실제 업데이트 체크를 수행한다.
// checkAuthentication()이 (재로그인 등으로) 여러 번 실행될 수 있으므로
// 타이머가 중복 생성되지 않도록 항상 기존 것을 먼저 정리한다.
const TAURI_UPDATE_DUE_CHECK_TICK_MS = 60 * 60 * 1000 // 1시간
let tauriUpdatePollingTimer = null

async function maybeCheckTauriUpdateIfDue() {
  const interval = getTauriUpdateCheckInterval()
  if (interval === 'never') return
  const intervalMs = UPDATE_CHECK_INTERVAL_MS[interval] || UPDATE_CHECK_INTERVAL_MS.weekly
  const lastCheckedAt = Number(localStorage.getItem(TAURI_UPDATE_LAST_CHECKED_STORAGE_KEY) || 0)
  const dueNow = !lastCheckedAt || (Date.now() - lastCheckedAt) >= intervalMs
  if (!dueNow) return
  await checkTauriUpdate({ silent: true })
}

function startTauriUpdatePolling() {
  if (tauriUpdatePollingTimer) clearInterval(tauriUpdatePollingTimer)
  tauriUpdatePollingTimer = setInterval(maybeCheckTauriUpdateIfDue, TAURI_UPDATE_DUE_CHECK_TICK_MS)
}

if (isTauriDesktop && tauriUpdateSection) {
  tauriUpdateSection.classList.remove('hidden')
}

async function loadTauriAppVersion() {
  if (!isTauriDesktop || !tauriCurrentVersionLabel) return
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    const version = await getVersion()
    tauriCurrentVersionLabel.textContent = `현재 버전: v${version}`
  } catch (err) {
    console.warn('데스크탑 앱 버전 조회 실패:', err)
  }
}

function resetTauriUpdateState() {
  pendingTauriUpdate = null
  if (tauriUpdateInstallBtn) tauriUpdateInstallBtn.disabled = true
  if (tauriUpdateNotesBox) tauriUpdateNotesBox.classList.add('hidden')
}

async function checkTauriUpdate({ silent = false } = {}) {
  if (!isTauriDesktop) return
  localStorage.setItem(TAURI_UPDATE_LAST_CHECKED_STORAGE_KEY, String(Date.now()))
  resetTauriUpdateState()
  if (!silent && tauriUpdateCheckBtn) {
    tauriUpdateCheckBtn.disabled = true
    tauriUpdateCheckBtn.innerHTML = icon('refreshCw', 13, 'style="vertical-align:-2px;margin-right:4px"') + '확인 중...'
  }
  if (!silent && tauriUpdateStatus) {
    tauriUpdateStatus.style.color = 'var(--text-secondary)'
    tauriUpdateStatus.textContent = ''
  }

  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) {
      pendingTauriUpdate = update
      if (tauriUpdateVersionLine) {
        tauriUpdateVersionLine.textContent = `v${update.currentVersion} → v${update.version}`
      }
      if (tauriUpdateNotes) {
        tauriUpdateNotes.textContent = update.body || '세부 변경 내역이 제공되지 않았습니다.'
      }
      if (tauriUpdateNotesBox) tauriUpdateNotesBox.classList.remove('hidden')
      if (tauriUpdateInstallBtn) tauriUpdateInstallBtn.disabled = false
      if (tauriUpdateStatus) {
        tauriUpdateStatus.style.color = '#10b981'
        tauriUpdateStatus.textContent = '새 업데이트가 있습니다.'
      }
      // 백그라운드(로그인 직후/주기적 재확인) 체크일 때만 팝업으로 알림 -
      // 사용자가 설정 화면에서 직접 확인 버튼을 눌렀을 때는 이미 결과가
      // 그 자리에 보이므로 팝업까지 겹쳐 띄우지 않는다.
      if (silent && update.version !== lastNotifiedTauriUpdateVersion) {
        lastNotifiedTauriUpdateVersion = update.version
        showTauriUpdateAvailableModal(update)
      }
    } else if (tauriUpdateStatus) {
      tauriUpdateStatus.style.color = 'var(--text-secondary)'
      tauriUpdateStatus.textContent = '이미 최신 버전입니다.'
    }
  } catch (err) {
    if (tauriUpdateStatus) {
      tauriUpdateStatus.style.color = '#ef4444'
      tauriUpdateStatus.textContent = '업데이트 확인 실패: ' + (err.message || err)
    }
  } finally {
    if (tauriUpdateCheckBtn) {
      tauriUpdateCheckBtn.disabled = false
      tauriUpdateCheckBtn.innerHTML = icon('checkCircle', 13, 'style="vertical-align:-2px;margin-right:4px"') + '업데이트 확인'
    }
  }
}

// 설정 화면과 "업데이트 발견" 팝업 양쪽에서 이 함수를 호출할 수 있으므로,
// 진행 상태를 두 위치의 상태 텍스트에 동시에 반영한다 (없는 쪽은 무시).
function setTauriUpdateStatusText(text, color = 'var(--text-secondary)') {
  ;[tauriUpdateStatus, updateAvailableStatus].forEach(el => {
    if (!el) return
    el.style.color = color
    el.textContent = text
  })
}

async function installTauriUpdate() {
  if (!pendingTauriUpdate) return
  const ok = await showCustomConfirm(
    `새 버전(v${pendingTauriUpdate.version})을 다운로드하고 설치한 뒤 앱을 재시작하시겠습니까?`,
    { title: '앱 업데이트', confirmText: '설치 후 재시작', danger: false }
  )
  if (!ok) return

  if (tauriUpdateInstallBtn) tauriUpdateInstallBtn.disabled = true
  if (tauriUpdateCheckBtn) tauriUpdateCheckBtn.disabled = true
  if (updateAvailableNowBtn) updateAvailableNowBtn.disabled = true
  if (updateAvailableLaterBtn) updateAvailableLaterBtn.disabled = true
  if (updateAvailableProgressArea) updateAvailableProgressArea.classList.remove('hidden')
  if (updateAvailableActions) updateAvailableActions.style.display = 'none'

  try {
    // 이 페이지 자체가 로컬 백엔드 sidecar(127.0.0.1:*)가 서빙하는 정적
    // 파일이라, 아래에서 sidecar를 죽이고 나면 그 시점까지 한 번도 로드된
    // 적 없는 청크(dynamic import)는 더 이상 네트워크로 가져올 수 없다.
    // relaunch()에 필요한 plugin-process는 지금까지 쓰인 적이 없으므로
    // sidecar를 죽이기 전에 미리 import해 브라우저가 청크를 확보해 두게
    // 한다 - 순서를 바꾸지 않으면 "Importing a module script failed" 오류로
    // 설치가 실패한다.
    const { relaunch } = await import('@tauri-apps/plugin-process')

    // Windows 설치 프로그램이 파일을 덮어쓰기 전에 백엔드 sidecar를 먼저
    // 종료해야 한다 - 계속 떠 있으면 PyInstaller 런타임이 로드한 DLL(예:
    // MSVCP140.dll)을 OS가 잠그고 있어서 "Error opening file for writing"
    // 오류로 설치가 멈춘다. downloadAndInstall의 진행 콜백은 await하지
    // 않고 그냥 호출되므로, 'Finished' 이벤트 시점에 죽이면 설치 시작과
    // 경쟁 상태가 생길 수 있다 - 다운로드 시작 전에 미리 종료해 둔다
    // (다운로드 자체는 sidecar 없이도 문제없이 동작한다).
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('kill_backend_sidecar')
    } catch (killErr) {
      console.warn('sidecar 종료 실패(무시하고 설치 계속):', killErr)
    }

    let downloadedBytes = 0
    let totalBytes = 0
    await pendingTauriUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          totalBytes = event.data.contentLength || 0
          setTauriUpdateStatusText('다운로드 시작...')
          break
        case 'Progress':
          downloadedBytes += event.data.chunkLength
          setTauriUpdateStatusText(totalBytes
            ? `다운로드 중... ${Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))}%`
            : '다운로드 중...')
          break
        case 'Finished':
          setTauriUpdateStatusText('설치 중... 곧 앱이 재시작됩니다.')
          break
      }
    })

    await relaunch()
  } catch (err) {
    setTauriUpdateStatusText('설치 실패: ' + (err.message || err), '#ef4444')
    if (tauriUpdateInstallBtn) tauriUpdateInstallBtn.disabled = false
    if (tauriUpdateCheckBtn) tauriUpdateCheckBtn.disabled = false
    if (updateAvailableNowBtn) updateAvailableNowBtn.disabled = false
    if (updateAvailableLaterBtn) updateAvailableLaterBtn.disabled = false
    if (updateAvailableActions) updateAvailableActions.style.display = 'flex'
  }
}

// 로그인 직후/주기적 백그라운드 체크에서 새 버전을 찾았을 때, 설정 화면까지
// 들어가지 않아도 알 수 있도록 "업데이트 발견" 팝업(update-available-modal)을
// 띄운다. 이 팝업은 원래 웹(git 기반) 배포판 전용이었는데, "지금 업데이트"
// 버튼 핸들러를 데스크탑 분기로 나눠 재사용한다.
function showTauriUpdateAvailableModal(update) {
  if (!updateAvailableModal) return
  pendingTauriUpdate = update
  if (updateAvailableVersionLine) {
    updateAvailableVersionLine.textContent = `v${update.currentVersion} → v${update.version}`
  }
  if (updateAvailableChangelog) {
    updateAvailableChangelog.innerHTML = update.body
      ? `<li style="font-size: 12.5px; color: var(--text-primary); line-height: 1.6; white-space: pre-wrap;">${escapeHtml(update.body)}</li>`
      : `<li style="font-size: 12.5px; color: var(--text-muted);">세부 변경 내역이 제공되지 않았습니다.</li>`
  }
  if (updateAvailableProgressArea) updateAvailableProgressArea.classList.add('hidden')
  if (updateAvailableActions) updateAvailableActions.style.display = 'flex'
  if (updateAvailableNowBtn) updateAvailableNowBtn.disabled = false
  if (updateAvailableLaterBtn) updateAvailableLaterBtn.disabled = false
  openOverlayModal(updateAvailableModal)
}

if (tauriUpdateCheckBtn) {
  tauriUpdateCheckBtn.addEventListener('click', () => checkTauriUpdate())
}
if (tauriUpdateInstallBtn) {
  tauriUpdateInstallBtn.addEventListener('click', installTauriUpdate)
}

if (systemUpdateCheckBtn && !isTauriDesktop) {
  systemUpdateCheckBtn.addEventListener('click', async () => {
    systemUpdateCheckBtn.disabled = true
    systemUpdateCheckBtn.innerHTML = icon('refreshCw', 13, 'style="vertical-align:-2px;margin-right:4px"') + '확인 중...'
    resetSystemUpdateCheckState()
    if (systemUpdateStatus) { systemUpdateStatus.style.color = 'var(--text-secondary)'; systemUpdateStatus.textContent = '' }

    try {
      const result = await checkForUpdateAPI()
      if (currentVersionLabel && result.current_version) {
        currentVersionLabel.textContent = `현재 버전: ${formatVersionLabel(result.current_version, result.current_version_date)}`
      }
      if (!result.ok) {
        systemUpdateStatus.style.color = '#ef4444'
        systemUpdateStatus.textContent = result.error || '업데이트 확인 실패'
      } else if (result.update_available) {
        pendingSystemUpdateAvailable = true
        if (systemUpdateVersionLine) {
          systemUpdateVersionLine.textContent = `${formatVersionLabel(result.current_version, result.current_version_date)} → ${formatVersionLabel(result.latest_version, result.latest_version_date)}`
        }
        renderChangelogList(systemUpdateChangelogList, result.changelog)
        if (systemUpdateChangelogBox) systemUpdateChangelogBox.classList.remove('hidden')
        if (systemUpdateRunBtn) systemUpdateRunBtn.disabled = false
        systemUpdateStatus.style.color = '#10b981'
        systemUpdateStatus.textContent = '새 업데이트가 있습니다.'
      } else {
        systemUpdateStatus.style.color = 'var(--text-secondary)'
        systemUpdateStatus.textContent = '이미 최신 버전입니다.'
      }
    } catch (err) {
      systemUpdateStatus.style.color = '#ef4444'
      systemUpdateStatus.textContent = err.message || '업데이트 확인 실패'
    } finally {
      systemUpdateCheckBtn.disabled = false
      systemUpdateCheckBtn.innerHTML = icon('checkCircle', 13, 'style="vertical-align:-2px;margin-right:4px"') + '업데이트 확인'
    }
  })
}

if (systemUpdateRunBtn && !isTauriDesktop) {
  systemUpdateRunBtn.addEventListener('click', async () => {
    if (!pendingSystemUpdateAvailable) return
    const ok = await showCustomConfirm('정말 깃허브 최신 코드로 자동 업데이트를 실행하시겠습니까?\n업데이트가 완료되면 서비스 데몬이 자동으로 재기동되며 약 3~5초간 접속이 중단될 수 있습니다.', { title: '시스템 업데이트', confirmText: '업데이트', danger: true })
    if (!ok) return

    systemUpdateRunBtn.disabled = true
    if (systemUpdateCheckBtn) systemUpdateCheckBtn.disabled = true
    systemUpdateRunBtn.innerHTML = icon('refreshCw', 13, 'style="vertical-align:-2px;margin-right:4px"') + '업데이트 진행 중...'
    systemUpdateStatus.style.color = 'var(--text-secondary)'
    systemUpdateStatus.textContent = 'GitHub 코드 가져오는 중...'

    try {
      const res = await triggerSystemUpdateAPI()
      if (res.ok) {
        systemUpdateStatus.style.color = '#10b981' // 초록색
        systemUpdateStatus.textContent = '업데이트 성공! 서버 재시작을 기다리는 중...'
        showToast(res.message, 'success')
        await waitForServerRestartAndReload()
      } else {
        systemUpdateRunBtn.disabled = false
        if (systemUpdateCheckBtn) systemUpdateCheckBtn.disabled = false
        systemUpdateRunBtn.innerHTML = icon('download', 13, 'style="vertical-align:-2px;margin-right:4px"') + '최신 업데이트 실행'
        systemUpdateStatus.style.color = '#ef4444' // 빨간색
        systemUpdateStatus.textContent = res.message
        showToast(res.message, 'error')
      }
    } catch (err) {
      systemUpdateStatus.style.color = '#ef4444'
      systemUpdateStatus.textContent = '서버 재시작을 감지했습니다. 잠시 후 새로고침합니다...'
      showToast('서버 재기동을 감지했습니다. 잠시 후 새로고침합니다.', 'info')
      await waitForServerRestartAndReload()
    }
  })
}

// ── 자동 업데이트 확인 / 새 버전 안내 / 업데이트 완료 안내 ──────────────
const settingUpdateCheckInterval = $('setting-update-check-interval')
const currentVersionLabel = $('current-version-label')

const updateAvailableModal = $('update-available-modal')
const updateAvailableCloseBtn = $('update-available-close-btn')
const updateAvailableVersionLine = $('update-available-version-line')
const updateAvailableChangelog = $('update-available-changelog')
const updateAvailableProgressArea = $('update-available-progress-area')
const updateAvailableStatus = $('update-available-status')
const updateAvailableActions = $('update-available-actions')
const updateAvailableLaterBtn = $('update-available-later-btn')
const updateAvailableNowBtn = $('update-available-now-btn')

const updateCompleteModal = $('update-complete-modal')
const updateCompleteCloseBtn = $('update-complete-close-btn')
const updateCompleteVersionLine = $('update-complete-version-line')
const updateCompleteChangelog = $('update-complete-changelog')
const updateCompleteConfirmBtn = $('update-complete-confirm-btn')

const fullChangelogModal   = $('full-changelog-modal')
const fullChangelogCloseBtn = $('full-changelog-close-btn')
const fullChangelogLoading = $('full-changelog-loading')
const fullChangelogContent = $('full-changelog-content')

function closeFullChangelogModal() {
  if (fullChangelogModal) closeOverlayModal(fullChangelogModal)
}

if (fullChangelogCloseBtn) fullChangelogCloseBtn.addEventListener('click', closeFullChangelogModal)
if (fullChangelogModal) {
  fullChangelogModal.addEventListener('click', (e) => {
    if (e.target === fullChangelogModal) closeFullChangelogModal()
  })
}

if (currentVersionLabel) {
  currentVersionLabel.addEventListener('click', async () => {
    if (!fullChangelogModal) return
    openOverlayModal(fullChangelogModal)
    fullChangelogLoading.classList.remove('hidden')
    fullChangelogContent.classList.add('hidden')
    fullChangelogContent.innerHTML = ''

    try {
      const res = await getFullChangelogAPI()
      fullChangelogContent.innerHTML = res.content
        ? sanitizeMarkedHtml(marked.parse(res.content))
        : '<p>변경 이력을 찾을 수 없습니다.</p>'
    } catch (err) {
      fullChangelogContent.innerHTML = `<p>변경 이력을 불러오지 못했습니다: ${escapeHtml(err.message || '')}</p>`
    } finally {
      fullChangelogLoading.classList.add('hidden')
      fullChangelogContent.classList.remove('hidden')
    }
  })
}

const UPDATE_CHECK_INTERVAL_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

// 버전 해시 자체는 그대로 두고, 화면에는 날짜를 함께 보여줘 더 읽기 쉽게 함
function formatVersionLabel(sha, date) {
  if (!sha) return ''
  return date ? `${date} · ${sha}` : sha
}

function renderChangelogList(ulEl, changelog) {
  if (!ulEl) return
  if (!changelog || changelog.length === 0) {
    ulEl.innerHTML = `<li style="font-size: 12.5px; color: var(--text-muted);">세부 변경 내역이 없습니다.</li>`
    return
  }
  ulEl.innerHTML = changelog.map(c => `
    <li style="display: flex; gap: 8px; font-size: 12.5px; color: var(--text-primary); line-height: 1.5;">
      <span style="color: var(--control-accent); flex-shrink: 0;">•</span>
      <span>${escapeHtml(c.subject)}</span>
    </li>
  `).join('')
}

// 설정 화면에서 자동 업데이트 확인 주기를 로드/저장
async function initUpdateCheckSettingUI() {
  if (!settingUpdateCheckInterval) return
  try {
    const cfg = await getUpdateCheckConfigAPI()
    settingUpdateCheckInterval.value = cfg.interval || 'weekly'
  } catch (err) {
    console.warn('업데이트 확인 설정 로드 실패:', err)
  }
}
globalSettingsBtn.addEventListener('click', initUpdateCheckSettingUI)

if (settingUpdateCheckInterval) {
  settingUpdateCheckInterval.addEventListener('change', async () => {
    try {
      await setUpdateCheckConfigAPI(settingUpdateCheckInterval.value)
      showToast('자동 업데이트 확인 설정이 저장되었습니다.', 'success')
    } catch (err) {
      showToast(err.message || '설정 저장 실패', 'error')
    }
  })
}

function closeUpdateAvailableModal() {
  if (updateAvailableModal) closeOverlayModal(updateAvailableModal)
}

function closeUpdateCompleteModal() {
  if (updateCompleteModal) closeOverlayModal(updateCompleteModal)
}

if (updateAvailableCloseBtn) updateAvailableCloseBtn.addEventListener('click', closeUpdateAvailableModal)
if (updateAvailableLaterBtn) updateAvailableLaterBtn.addEventListener('click', closeUpdateAvailableModal)
if (updateAvailableModal) {
  updateAvailableModal.addEventListener('click', (e) => {
    if (e.target === updateAvailableModal) closeUpdateAvailableModal()
  })
}
if (updateCompleteCloseBtn) updateCompleteCloseBtn.addEventListener('click', closeUpdateCompleteModal)
if (updateCompleteConfirmBtn) updateCompleteConfirmBtn.addEventListener('click', closeUpdateCompleteModal)
if (updateCompleteModal) {
  updateCompleteModal.addEventListener('click', (e) => {
    if (e.target === updateCompleteModal) closeUpdateCompleteModal()
  })
}

// 서버가 재시작할 시간을 준 뒤, 응답이 돌아올 때까지 짧게 폴링하고 새로고침한다.
// (git pull 직후 서버가 스스로 프로세스를 내렸다 올리는 구간이라, 그 사이의
// 연결 실패는 실패가 아니라 재시작 중이라는 정상 신호로 취급해야 한다)
async function waitForServerRestartAndReload() {
  await new Promise(resolve => setTimeout(resolve, 2000))
  const maxAttempts = 24 // 약 2초 + 24 * 1.5초 = 최대 약 38초 대기
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const auth = await checkAuthAPI()
      if (auth) {
        location.reload()
        return
      }
    } catch (err) {
      // 아직 재시작 중 - 계속 폴링
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  // 시간이 오래 걸려도 일단 새로고침을 시도해본다
  location.reload()
}

if (updateAvailableNowBtn) {
  updateAvailableNowBtn.addEventListener('click', async () => {
    // 데스크탑에서는 git pull이 아니라 tauri-plugin-updater 다운로드/설치/
    // 재시작 플로우를 그대로 재사용한다 (installTauriUpdate가 이 팝업의
    // 상태 표시도 함께 갱신함 - setTauriUpdateStatusText 참고).
    if (isTauriDesktop) {
      await installTauriUpdate()
      return
    }
    updateAvailableNowBtn.disabled = true
    if (updateAvailableLaterBtn) updateAvailableLaterBtn.disabled = true
    if (updateAvailableProgressArea) updateAvailableProgressArea.classList.remove('hidden')
    if (updateAvailableActions) updateAvailableActions.style.display = 'none'
    if (updateAvailableStatus) updateAvailableStatus.textContent = 'GitHub 코드 가져오는 중...'

    try {
      const res = await triggerSystemUpdateAPI()
      if (res.ok) {
        if (updateAvailableStatus) updateAvailableStatus.textContent = '업데이트 성공! 서버 재시작을 기다리는 중...'
        await waitForServerRestartAndReload()
      } else {
        if (updateAvailableStatus) updateAvailableStatus.textContent = res.message || '업데이트 실패'
        showToast(res.message || '업데이트 실패', 'error')
        updateAvailableNowBtn.disabled = false
        if (updateAvailableLaterBtn) updateAvailableLaterBtn.disabled = false
        if (updateAvailableActions) updateAvailableActions.style.display = 'flex'
      }
    } catch (err) {
      // 요청 도중 서버가 이미 재시작을 시작해 연결이 끊겼을 가능성이 높다
      if (updateAvailableStatus) updateAvailableStatus.textContent = '서버 재시작을 감지했습니다. 잠시 후 새로고침합니다...'
      await waitForServerRestartAndReload()
    }
  })
}

// 설정된 주기(매일/매주)가 지났으면 원격 저장소를 확인해 새 버전이 있는지 확인하고,
// 있으면 변경 로그와 함께 안내 팝업을 띄운다. "사용 안 함"이면 절대 확인하지 않는다.
async function maybeAutoCheckForUpdate() {
  try {
    const cfg = await getUpdateCheckConfigAPI()
    if (settingUpdateCheckInterval) settingUpdateCheckInterval.value = cfg.interval || 'weekly'
    if (cfg.interval === 'never') return

    const intervalMs = UPDATE_CHECK_INTERVAL_MS[cfg.interval] || UPDATE_CHECK_INTERVAL_MS.weekly
    const lastCheckedAt = cfg.last_checked_at ? new Date(cfg.last_checked_at).getTime() : 0
    const dueNow = !lastCheckedAt || (Date.now() - lastCheckedAt) >= intervalMs
    if (!dueNow) return

    const result = await checkForUpdateAPI()
    if (currentVersionLabel && result.current_version) {
      currentVersionLabel.textContent = `현재 버전: ${formatVersionLabel(result.current_version, result.current_version_date)}`
    }
    if (!result.ok || !result.update_available) return

    if (updateAvailableVersionLine) {
      updateAvailableVersionLine.textContent = `${formatVersionLabel(result.current_version, result.current_version_date)} → ${formatVersionLabel(result.latest_version, result.latest_version_date)}`
    }
    renderChangelogList(updateAvailableChangelog, result.changelog)
    if (updateAvailableProgressArea) updateAvailableProgressArea.classList.add('hidden')
    if (updateAvailableActions) updateAvailableActions.style.display = 'flex'
    if (updateAvailableNowBtn) updateAvailableNowBtn.disabled = false
    if (updateAvailableLaterBtn) updateAvailableLaterBtn.disabled = false
    if (updateAvailableModal) openOverlayModal(updateAvailableModal)
  } catch (err) {
    console.warn('자동 업데이트 확인 실패:', err)
  }
}

// 직전 재시작으로 버전이 바뀌었다면(=방금 업데이트 적용됨) 변경 로그와 함께
// "업데이트 완료" 안내를 1회만 보여준다. 팝업을 실제로 띄웠는지(true/false)를
// 반환해, 호출부가 "새 업데이트 확인" 팝업과 동시에 겹쳐 뜨지 않게 조율한다.
async function checkPostUpdateNoticeOnce() {
  try {
    const notice = await getPostUpdateNoticeAPI()
    if (currentVersionLabel && notice.version) {
      currentVersionLabel.textContent = `현재 버전: ${formatVersionLabel(notice.version, notice.version_date)}`
    }
    if (!notice.show) return false

    if (updateCompleteVersionLine) {
      updateCompleteVersionLine.textContent = `버전 ${formatVersionLabel(notice.version, notice.version_date)}로 업데이트되었습니다.`
    }
    renderChangelogList(updateCompleteChangelog, notice.changelog)
    if (updateCompleteModal) openOverlayModal(updateCompleteModal)
    return true
  } catch (err) {
    console.warn('업데이트 완료 안내 조회 실패:', err)
    return false
  }
}

// 로컬 캐시 비우기
clearCacheBtn.addEventListener('click', async () => {
  const ok = await showCustomConfirm('브라우저에 저장된 PDF 어노테이션(밑줄, 하이라이트) 정보 및 설정을 모두 초기화하시겠습니까?', { title: '캐시 및 설정 초기화', confirmText: '초기화', danger: true })
  if (ok) {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('easypaper_')) {
        localStorage.removeItem(key)
      }
    })
    showToast('캐시가 초기화되었습니다.', 'success')
    closeOverlayModal(settingsModal)
    location.reload()
  }
})

// 서버 측 PDF 텍스트 추출 결과 캐시 비우기 (재시작 후 첫 열람 가속용 - 지워도
// 다음 열람 시 자동으로 다시 채워지므로 데이터 손실 없음)
if (clearPagesCacheBtn) {
  clearPagesCacheBtn.addEventListener('click', async () => {
    const ok = await showCustomConfirm('서버에 저장된 PDF 텍스트 추출 캐시를 모두 삭제하시겠습니까?\n(문서를 다시 열면 그때 자동으로 다시 생성되므로 안전합니다.)', { title: '서버 캐시 비우기', confirmText: '삭제', danger: true })
    if (!ok) return
    try {
      const result = await clearPagesCacheAPI()
      const freedMb = ((result.freed_bytes || 0) / (1024 * 1024)).toFixed(1)
      showToast(`캐시 파일 ${result.cleared_files || 0}개를 삭제했습니다. (${freedMb}MB 확보)`, 'success')
    } catch (err) {
      showToast(err.message || '캐시 삭제에 실패했습니다.', 'error')
    }
  })
}

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
    closeOverlayModal(settingsModal)
  } catch (err) {
    showToast(err.message, 'error')
  }
})

// 로그인 생략 설정 토글 - 켤 때만 보안 영향(네트워크로 접근 가능한 누구나
// 인증 없이 쓸 수 있게 됨)을 다시 한번 확인받는다. 끌 때는 원래대로
// 로그인이 필요해지는 방향이라 별도 확인 없이 바로 적용한다.
if (settingSkipLoginCheckbox) {
  settingSkipLoginCheckbox.addEventListener('change', async () => {
    const wantsEnabled = settingSkipLoginCheckbox.checked
    if (wantsEnabled) {
      const ok = await showCustomConfirm(
        '이 서버에 네트워크로 접근 가능한 모든 사람이 로그인 없이 전체 기능을 쓸 수 있게 됩니다.\n여기에는 시스템 업데이트(서버 재시작)와 Ollama/CLI 원격 설치처럼 서버에 소프트웨어를 설치·재시작시킬 수 있는 관리 기능도 포함됩니다.\n다른 사람이 접근할 수 없는 개인 PC/로컬 환경에서만 켜세요.\n계속하시겠습니까?',
        { title: '로그인 생략 켜기', confirmText: '켜기', danger: true }
      )
      if (!ok) {
        settingSkipLoginCheckbox.checked = false
        return
      }
    }
    try {
      await setSkipLoginAPI(wantsEnabled)
      showToast(wantsEnabled ? '로그인 생략이 켜졌습니다.' : '로그인 생략이 꺼졌습니다.', 'success')
    } catch (err) {
      settingSkipLoginCheckbox.checked = !wantsEnabled
      showToast(err.message, 'error')
    }
  })
}

// ── 읽기 시간 하트비트 (Reading History의 "읽은 시간" 실측) ──────────────
// 뷰어/비교 화면이 화면에 보이고(Page Visibility) 창이 포커스된 동안만 5초
// 간격으로 "현재 컨텍스트"(문서 id + reading/chat/compare 카테고리)에 초를
// 적립하고, 20초마다 적립분을 서버로 보낸다. 단일 논문 뷰어에서는 사이드바의
// 열림 여부가 아니라 PDF/채팅 영역 중 사용자가 마지막으로 상호작용한 영역으로
// 분류하며, 60초 동안 상호작용이 없으면 유휴 상태로 보고 적립하지 않는다.
const READING_HEARTBEAT_TICK_SECONDS = 5
const READING_HEARTBEAT_FLUSH_MS = 20000
let readingHeartbeatBuffers = {} // `${docId}|${category}` -> 적립된 초
let readingHeartbeatContextKey = null
const readingTimeActivityTracker = globalReadingTimeActivityTracker

function recordReadingTimeInteraction(event) {
  if (!viewerScreen?.classList.contains('active')) return
  const target = event.target
  const isChatInteraction = chatSidebar
    && !chatSidebar.classList.contains('hidden')
    && chatSidebar.contains(target)
    && !target.closest?.('#chat-close-btn')
  readingTimeActivityTracker.record(isChatInteraction ? 'chat' : 'reading')
}

// pointerdown은 클릭·선택·스크롤바 드래그·터치를, wheel/keydown/input은 각각
// 휠 스크롤·키보드 탐색·채팅 입력을 포착한다. scroll 이벤트는 답변 렌더링이나
// 페이지 복원 코드가 일으킨 자동 스크롤도 포함하므로 활동 근거로 사용하지 않는다.
for (const eventName of ['pointerdown', 'wheel', 'keydown', 'input']) {
  viewerScreen?.addEventListener(eventName, recordReadingTimeInteraction, { capture: true, passive: eventName === 'wheel' })
}

function isReadingTimeActive() {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false
  if (viewerScreen && viewerScreen.classList.contains('active') && state.sessionId) return true
  if (compareScreen && compareScreen.classList.contains('active') && compareChatState.docIds.length > 0) return true
  return false
}

function currentReadingContext() {
  if (viewerScreen && viewerScreen.classList.contains('active') && state.sessionId) {
    const contextKey = `viewer|${state.sessionId}`
    if (readingHeartbeatContextKey !== contextKey) {
      readingHeartbeatContextKey = contextKey
      readingTimeActivityTracker.reset('reading')
    }
    const category = readingTimeActivityTracker.getCategory({
      chatAvailable: Boolean(chatSidebar && !chatSidebar.classList.contains('hidden')),
    })
    if (!category) return null
    return { docIds: [state.sessionId], category }
  }
  if (compareScreen && compareScreen.classList.contains('active') && compareChatState.docIds.length > 0) {
    readingHeartbeatContextKey = `compare|${compareChatState.docIds.join(',')}`
    return { docIds: compareChatState.docIds, category: 'compare' }
  }
  return null
}

function tickReadingHeartbeat() {
  if (!isReadingTimeActive()) {
    readingHeartbeatContextKey = null
    return
  }
  const ctx = currentReadingContext()
  if (!ctx) return
  for (const docId of ctx.docIds) {
    const key = `${docId}|${ctx.category}`
    readingHeartbeatBuffers[key] = (readingHeartbeatBuffers[key] || 0) + READING_HEARTBEAT_TICK_SECONDS
  }
}

async function flushReadingHeartbeat({ keepalive = false } = {}) {
  const buffers = readingHeartbeatBuffers
  readingHeartbeatBuffers = {}
  const entries = Object.entries(buffers).filter(([, seconds]) => seconds > 0)
  if (entries.length === 0) return

  const results = await Promise.all(entries.map(async ([key, seconds]) => {
    const sep = key.lastIndexOf('|')
    const docId = key.slice(0, sep)
    const category = key.slice(sep + 1)
    const sent = await sendReadingHeartbeat(docId, seconds, category, { keepalive })
    return { key, seconds, sent }
  }))

  for (const { key, seconds, sent } of results) {
    if (!sent) readingHeartbeatBuffers[key] = (readingHeartbeatBuffers[key] || 0) + seconds
  }
}

setInterval(tickReadingHeartbeat, READING_HEARTBEAT_TICK_SECONDS * 1000)
setInterval(flushReadingHeartbeat, READING_HEARTBEAT_FLUSH_MS)
window.addEventListener('beforeunload', () => { flushReadingHeartbeat({ keepalive: true }); globalAnalyticsTracker.stopSession() })

// ── 초기화 ────────────────────────────────────────
i18nReady.then(() => checkAuthentication()).catch(console.error)
checkAIStatus()
setInterval(checkAIStatus, 30000)

// ── 라이브러리 화면 ────────────────────────────────
// 이미 어딘가에서 fetchLibrary()로 받아온 문서 목록이 있을 때 그 결과로
// 배지만 갱신한다(추가 네트워크 요청 없음). renderLibrary()와
// loadLibraryCount() 양쪽에서 공유해서 쓰기 위해 분리했다 - 예전에는 이
// 배지 갱신 로직이 양쪽에 중복 구현되어 있어서, "보관함 표시/삭제/복원"
// 등 문서 하나를 조작할 때마다 renderLibrary()가 이미 새로 받아온 목록이
// 있는데도 loadLibraryCount()가 GET /api/library를 한 번 더(+휴지통까지)
// 쏴서 화면 갱신이 체감상 두 배로 느려졌었다.
function updateUnreadBadge(docs) {
  const unreadCount = docs.filter(doc => doc.metadata?.read !== true).length
  if (unreadCount > 0 && libraryCountBadge && state.currentLibraryTab !== 'trash') {
    libraryCountBadge.textContent = unreadCount
    libraryCountBadge.classList.remove('hidden')
  } else if (libraryCountBadge) {
    libraryCountBadge.classList.add('hidden')
  }
}

function updateTrashTabVisibility(trashDocs) {
  if (!libTabTrash) return
  const trashCount = trashDocs ? trashDocs.length : 0
  const countBadge = $('lib-tab-trash-count')
  if (countBadge) {
    if (trashCount > 0) {
      countBadge.textContent = trashCount
      countBadge.classList.remove('hidden')
    } else {
      countBadge.textContent = ''
      countBadge.classList.add('hidden')
    }
  }
  libTabTrash.title = `휴지통${trashCount > 0 ? ` (${trashCount}개 문서)` : ''}`
  if (trashCount > 0 || state.currentLibraryTab === 'trash') {
    libTabTrash.classList.remove('hidden')
  } else {
    libTabTrash.classList.add('hidden')
  }
}

// 휴지통 탭 노출 여부/배지는 현재 보고 있는 탭이 무엇이든 항상 최신이어야
// 하는데, 그러려면 archive/history 탭을 보고 있을 때도 휴지통 목록을 별도로
// 조회해야 한다(현재 탭의 목록과는 다른 데이터라 재사용 불가). 화면
// 갱신을 막지 않도록 호출부에서 await 없이 백그라운드로 실행한다.
async function refreshTrashTabVisibility() {
  try {
    const trashData = await fetchLibraryTrash({ ...getTranslationOptions(workspaceModeController.getMode()), documentMode: workspaceModeController.getMode() })
    updateTrashTabVisibility(trashData.documents || [])
  } catch (err) {
    console.error('휴지통 개수 조회 실패:', err)
  }
}

// 라이브러리 화면이 아직 렌더링되지 않은 상태(예: 뷰어 화면)에서 배지만
// 갱신해야 할 때 쓰는, 처음부터 새로 fetch하는 버전. 라이브러리 화면이 이미
// 최신 목록을 렌더링해둔 상태라면 이 함수 대신 updateUnreadBadge()+
// refreshTrashTabVisibility()를 직접 쓰는 쪽이 중복 요청을 피할 수 있다.
async function loadLibraryCount() {
  try {
    const data = await fetchLibrary({ ...getTranslationOptions(workspaceModeController.getMode()), documentMode: workspaceModeController.getMode() })
    updateUnreadBadge(data.documents || [])
  } catch {}
  await refreshTrashTabVisibility()
}

// 탭 클릭 이벤트 리스너 등록
// Library 페이지 내부 탭(archive: 전체 / trash: 휴지통) 전환. 채팅/주석/그래프/히스토리는
// 더 이상 Library의 내부 탭이 아니라 사이드바의 독립된 최상위 페이지다 - showWorkspacePage() 참고.
function syncLibraryTabUI(activeTab, { resetFilters = true } = {}) {
  state.currentLibraryTab = activeTab
  if (resetFilters) {
    activeCategoryFilter = 'ALL'
    activeStatusFilter = 'all'
  }
  closeLibraryDetailPanel()

  const subtitleEl = document.querySelector('.library-header-subtitle')
  if (subtitleEl) {
    const subtitles = {
      research: { archive: t('library:subtitle.research.archive'), trash: t('library:subtitle.research.trash') },
      general: { archive: t('library:subtitle.general.archive'), trash: t('library:subtitle.general.trash') },
    }
    const mode = workspaceModeController.getMode() === 'general' ? 'general' : 'research'
    subtitleEl.textContent = subtitles[mode][activeTab === 'trash' ? 'trash' : 'archive']
  }

  if (libTabTrash) libTabTrash.classList.toggle('active', activeTab === 'trash')
  if (libEmptyTrashBtn) libEmptyTrashBtn.classList.toggle('hidden', activeTab !== 'trash')
  if (libUploadBtn) libUploadBtn.classList.toggle('hidden', activeTab === 'trash')
  if (libCompareToggleBtn) libCompareToggleBtn.classList.toggle('hidden', activeTab === 'trash')
  clearDocSelection()
}

function updateTabUI(activeTab) {
  syncLibraryTabUI(activeTab)
  renderLibrary()
}

if (libTabTrash) {
  libTabTrash.addEventListener('click', () => {
    if (state.currentLibraryTab === 'trash') {
      updateTabUI(state.previousLibraryTab || 'archive')
    } else {
      state.previousLibraryTab = state.currentLibraryTab
      updateTabUI('trash')
    }
  })
}

// 라이브러리 큰 카드/작은 카드/리스트 보기 전환 - 마지막 선택을 기억해 다음 방문에도 유지
const savedLibraryViewMode = localStorage.getItem('easypaper_library_view')
let libraryViewMode = ['card', 'compact', 'list'].includes(savedLibraryViewMode) ? savedLibraryViewMode : 'card'
function updateViewToggleUI() {
  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    const isActive = btn.dataset.view === libraryViewMode
    btn.classList.toggle('active', isActive)
    btn.setAttribute('aria-pressed', String(isActive))
  })
}
document.querySelectorAll('.view-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === libraryViewMode) return
    libraryViewMode = btn.dataset.view
    localStorage.setItem('easypaper_library_view', libraryViewMode)
    updateViewToggleUI()
    filterLibraryCards(currentLibraryDocs)
  })
})
updateViewToggleUI()

async function showLibraryScreen(shouldPushState = true, targetPage) {
  await loadFeatureNamespaces(targetPage === 'dashboard' ? 'dashboard' : targetPage === 'chats' ? 'chat' : 'library')
  // 뷰어에서 나가는 시점이므로, 아직 디바운스 대기 중인 "마지막으로 읽은
  // 페이지" 저장이 있으면 Dashboard/Library가 새 데이터를 가져오기 전에
  // 먼저 끝마친다 (스크롤 직후 바로 뒤로가기를 눌렀을 때 최근 읽은 논문
  // 카드가 갱신되지 않던 문제 수정).
  await flushSaveLastReadPage()
  hasLibraryStateInHistory = true
  loginScreen.classList.remove('active')
  viewerScreen.classList.remove('active')
  if (compareScreen) compareScreen.classList.remove('active')
  libraryScreen.classList.add('active')
  // 워크스페이스 화면(사이드바+탑네비)에서는 테마 토글/Settings/로그아웃이 전부
  // 사이드바 푸터에 있으므로, 로그인/비교 화면 전용인 플로팅 버튼 묶음은 통째로 숨긴다
  // (안 그러면 우측 상단에 뜬금없이 떠서 페이지 콘텐츠와 겹친다).
  const globalToggle = $('global-theme-toggle')
  if (globalToggle) globalToggle.classList.add('hidden')
  globalLogoutBtn.classList.add('hidden')
  globalSettingsBtn.classList.add('hidden')
  resetState()
  await showWorkspacePage(targetPage || state.currentWorkspacePage || 'dashboard', { pushState: shouldPushState })
  startLibraryPolling()
}

// ── 워크스페이스 셸: 사이드바 / 탑네비 / 최상위 페이지 라우팅 ──────────────
// 6개 페이지(Dashboard/Library/Reading History/AI Chats/Notes/Research Graph)는
// 각각 #page-<id> 섹션으로 존재하며, 사이드바 클릭이나 해시 변경 시 이 함수 하나로 전환한다.
const WORKSPACE_PAGES = ['dashboard', 'library', 'history', 'chats', 'notes', 'graph']
async function showWorkspacePage(pageId, { pushState = true } = {}) {
  if (!WORKSPACE_PAGES.includes(pageId)) pageId = 'dashboard'
  if (state.currentWorkspacePage === 'library' && pageId !== 'library') {
    const saved = workspaceLibraryState[workspaceModeController.getMode()]
    saved.tab = state.currentLibraryTab
    saved.category = activeCategoryFilter
    saved.status = activeStatusFilter
    saved.search = librarySearchInput?.value || ''
  }
  if (workspaceModeController.getMode() === "general" && pageId === "graph") pageId = "dashboard"
  // 채팅 드로어가 열린 채로 다른 워크스페이스 페이지로 이동하면(사이드바 클릭 등)
  // 드로어를 닫아준다. '#chat?id=' 라우팅 분기가 이 함수 호출 직후 다시
  // openChatDrawer()를 부르는 경우엔 그냥 무해한 no-op이다.
  if (pageId !== 'chats' || state.currentWorkspacePage !== 'chats') closeChatDrawer()
  state.currentWorkspacePage = pageId
  await loadFeatureNamespaces(pageId === 'chats' ? 'chat' : pageId)

  if (sidebarNav) {
    sidebarNav.querySelectorAll('.sidebar-nav-item[data-page]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === pageId)
    })
  }
  if (pageOutlet) {
    pageOutlet.querySelectorAll('.workspace-page').forEach(sec => {
      sec.classList.toggle('active', sec.id === `page-${pageId}`)
    })
  }
  if (workspacePageTitle) {
    workspacePageTitle.textContent = workspaceModeController.getPageLabel(pageId)
  }

  if (pushState) {
    history.pushState({ screen: 'library', page: pageId }, '', `#${pageId}`)
  }

  if (pageId === 'library') {
    const saved = workspaceLibraryState[workspaceModeController.getMode()]
    state.currentLibraryTab = saved.tab
    activeCategoryFilter = saved.category
    activeStatusFilter = saved.status
    syncLibraryTabUI(saved.tab, { resetFilters: false })
    await renderLibrary()
    if (librarySearchInput && saved.search) {
      librarySearchInput.value = saved.search
      librarySearchInput.dispatchEvent(new Event('input'))
    }
  } else if (pageId === 'chats') {
    const { renderAiChatsPage } = await import('./pages/aiChatsPage.js')
    await renderAiChatsPage(workspaceModeController.getMode())
  } else if (pageId === 'notes') {
    const { renderNotesPage } = await import('./pages/notesPage.js')
    await renderNotesPage(workspaceModeController.getMode())
  } else if (pageId === 'graph') {
    await renderLibraryGraphTab()
  } else if (pageId === 'dashboard') {
    if (workspaceModeController.getMode() === "general") {
      const { renderGeneralDocumentHomePage } = await import("./pages/generalDocumentHomePage.js")
      await renderGeneralDocumentHomePage()
      return
    }
    const { renderDashboardPage } = await import('./pages/dashboardPage.js')
    await renderDashboardPage()
  } else if (pageId === 'history') {
    const { renderReadingHistoryPage } = await import('./pages/readingHistoryPage.js')
    await renderReadingHistoryPage(workspaceModeController.getMode())
  }
}

// 사이드바 접기/펼치기 - 마지막 상태를 기억해 다음 방문에도 유지
const SIDEBAR_COLLAPSED_KEY = 'easypaper_sidebar_collapsed'
function setSidebarCollapsed(collapsed) {
  if (!appSidebar) return
  appSidebar.classList.toggle('collapsed', collapsed)
  // chat-drawer는 DOM상 사이드바 밖(body 레벨)에 있어 폭을 알 수 없으므로
  // body에도 미러링해 드로어의 좌측 오프셋(style.css)이 따라오게 한다.
  document.body.classList.toggle('sidebar-collapsed', collapsed)
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false')
}
if (appSidebar) {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true')
}
if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', () => {
    setSidebarCollapsed(!appSidebar.classList.contains('collapsed'))
  })
}

// 사이드바 네비게이션 아이콘을 icons.js 아이콘 라이브러리로 채운다 (이모지 사용 금지 원칙).
document.querySelectorAll('[data-icon]').forEach(el => {
  el.innerHTML = icon(el.dataset.icon, 18)
})

if (sidebarNav) {
  sidebarNav.querySelectorAll('.sidebar-nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      // library 탭 클릭 시 archive 탭으로 초기화는 showWorkspacePage 내부의
      // syncLibraryTabUI가 담당하므로 여기서 updateTabUI를 별도로 호출하지 않는다.
      // (updateTabUI → renderLibrary 가 fire-and-forget으로 실행되어
      //  showWorkspacePage → renderLibrary 와 동시에 돌면 태그 필터가 2배로 렌더링되는 Race Condition 발생)
      if (state.currentWorkspacePage === btn.dataset.page) return
      showWorkspacePage(btn.dataset.page)
    })
  })
}

// 사이드바 Settings/로그아웃은 기존 로직(비밀번호 변경 모달 / 로그아웃)을 그대로
// 재사용한다 - 새 UI 진입점만 추가하고 동작 자체는 기존 global-settings-btn/
// global-logout-btn 클릭 핸들러에 위임한다.
if (sidebarSettingsBtn) sidebarSettingsBtn.addEventListener('click', () => globalSettingsBtn?.click())
if (sidebarLogoutBtn) sidebarLogoutBtn.addEventListener('click', () => globalLogoutBtn?.click())

// 탑네비 검색창은 새 검색 기능이 아니라 기존 라이브러리 검색으로 그대로 위임한다
// (Global Search는 기존 검색 기능을 그대로 사용 - 동작 변경 금지 원칙).
if (workspaceSearchInput) {
  workspaceSearchInput.addEventListener('input', () => {
    if (state.currentWorkspacePage !== 'library') {
      showWorkspacePage('library')
    }
    if (librarySearchInput) {
      librarySearchInput.value = workspaceSearchInput.value
      librarySearchInput.dispatchEvent(new Event('input'))
    }
  })
}

let activeCategoryFilter = 'ALL'
const LIBRARY_FILTERS_COLLAPSED_KEY = 'easypaper_library_category_filters_collapsed'
let libraryCategoryFiltersCollapsed = localStorage.getItem(LIBRARY_FILTERS_COLLAPSED_KEY) === 'true'

function updateLibraryCategoryFilterVisibility(hasCategories = libraryCategoryFilters?.childElementCount > 0) {
  if (!libraryCategoryFilters || !libraryCategoryFilterToggle) return
  libraryCategoryFilterToggle.classList.toggle('hidden', !hasCategories)
  libraryCategoryFilters.classList.toggle('hidden', hasCategories && libraryCategoryFiltersCollapsed)
  libraryCategoryFilterToggle.setAttribute('aria-expanded', String(!libraryCategoryFiltersCollapsed))
  libraryCategoryFilterToggle.setAttribute('aria-label', libraryCategoryFiltersCollapsed ? '카테고리 필터 펼치기' : '카테고리 필터 접기')
  libraryCategoryFilterToggle.title = libraryCategoryFiltersCollapsed ? '카테고리 필터 펼치기' : '카테고리 필터 접기'
  libraryCategoryFilterToggle.innerHTML = `${icon(libraryCategoryFiltersCollapsed ? 'chevronDown' : 'chevronUp', 13)}<span>${libraryCategoryFiltersCollapsed ? '필터 펼치기' : '필터 접기'}</span>`
}

// ── 여러 논문 비교 채팅: 라이브러리 선택 모드 ──────────────
// ── 라이브러리 논문 선택 모드 & 하단 플로팅 알약 툴바 ──
const selectedDocIds = new Set()

function getVisibleDocIds() {
  if (!libraryGrid) return []
  return Array.from(libraryGrid.querySelectorAll('.doc-card[data-id], .doc-list-row[data-id]'), el => el.dataset.id)
}

function toggleDocSelection(docId) {
  if (selectedDocIds.has(docId)) {
    selectedDocIds.delete(docId)
  } else {
    selectedDocIds.add(docId)
  }
  updateDocCardSelectionVisuals(docId)
  updateSelectToolbarUI()
}

function updateDocCardSelectionVisuals(docId) {
  const isSelected = selectedDocIds.has(docId)
  const els = document.querySelectorAll(`.doc-card[data-id="${CSS.escape(docId)}"], .doc-list-row[data-id="${CSS.escape(docId)}"]`)
  els.forEach(el => {
    el.classList.toggle('doc-card-selected', isSelected)
    const checkBtn = el.querySelector('.doc-card-check-btn')
    if (checkBtn) {
      checkBtn.classList.toggle('checked', isSelected)
      checkBtn.title = isSelected ? '선택 해제' : '선택'
    }
  })
}

function clearDocSelection() {
  selectedDocIds.clear()
  document.querySelectorAll('.doc-card-selected').forEach(el => el.classList.remove('doc-card-selected'))
  document.querySelectorAll('.doc-card-check-btn.checked').forEach(el => {
    el.classList.remove('checked')
    el.title = '선택'
  })
  updateSelectToolbarUI()
}

function replaceDocSelection(nextIds) {
  const affectedIds = new Set([...selectedDocIds, ...nextIds])
  selectedDocIds.clear()
  nextIds.forEach(id => selectedDocIds.add(id))
  affectedIds.forEach(id => updateDocCardSelectionVisuals(id))
  updateSelectToolbarUI()
}

function updateSelectToolbarUI() {
  const count = selectedDocIds.size
  const toolbar = $('lib-select-toolbar')
  if (!toolbar) return

  if (count > 0 && state.currentLibraryTab !== 'trash') {
    toolbar.classList.remove('hidden')
    const countEl = $('lib-select-count')
    if (countEl) countEl.textContent = `${count}개 선택됨`

    const compareBtn = $('lib-select-compare-btn')
    if (compareBtn) compareBtn.disabled = (count < 2 || count > 5)

    const visibleIds = getVisibleDocIds()
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedDocIds.has(id))
    const selectAllBtn = $('lib-select-all-btn')
    if (selectAllBtn) selectAllBtn.textContent = allSelected ? '선택 해제' : '전체 선택'
  } else {
    toolbar.classList.add('hidden')
  }
}

function initSelectToolbarEvents() {
  $('lib-select-all-btn')?.addEventListener('click', () => {
    const visibleIds = getVisibleDocIds()
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedDocIds.has(id))
    if (allSelected) {
      clearDocSelection()
    } else {
      visibleIds.forEach(id => selectedDocIds.add(id))
      visibleIds.forEach(id => updateDocCardSelectionVisuals(id))
      updateSelectToolbarUI()
    }
  })

  $('lib-select-read-btn')?.addEventListener('click', async () => {
    if (selectedDocIds.size === 0) return
    const selectedDocsList = currentLibraryDocs.filter(d => selectedDocIds.has(d.id))
    const allRead = selectedDocsList.length > 0 && selectedDocsList.every(d => d.metadata?.read === true)
    const nextReadState = !allRead
    const payload = { read: nextReadState, read_at: nextReadState ? new Date().toISOString() : null }

    try {
      await Promise.all(Array.from(selectedDocIds).map(id => updateLibraryDocMetadata(id, payload)))
      showToast(nextReadState ? `${selectedDocIds.size}개 논문을 읽음으로 표시했습니다.` : `${selectedDocIds.size}개 논문의 완독 상태를 해제했습니다.`, 'success')
      clearDocSelection()
      await renderLibrary()
    } catch (err) {
      showToast('상태 변경 실패: ' + err.message, 'error')
    }
  })

  $('lib-select-fav-btn')?.addEventListener('click', async () => {
    if (selectedDocIds.size === 0) return
    const count = selectedDocIds.size
    selectedDocIds.forEach(id => toggleFavoriteDoc(id))
    showToast(`${count}개 논문의 북마크 상태가 변경되었습니다.`, 'success')
    clearDocSelection()
    await renderLibrary()
  })

  $('lib-select-cache-btn')?.addEventListener('click', async () => {
    if (selectedDocIds.size === 0) return
    const count = selectedDocIds.size
    const ok = await showCustomConfirm(`선택한 ${count}개 논문의 PDF 추출 캐시를 삭제할까요?\n(다음 열람 시 PDF를 다시 파싱하게 됩니다.)`, { title: 'PDF 캐시 삭제', confirmText: '캐시 삭제' })
    if (!ok) return
    try {
      await Promise.allSettled(Array.from(selectedDocIds).map(id => clearSingleDocCacheAPI(id)))
      showToast(`선택한 ${count}개 논문의 PDF 추출 캐시가 삭제되었습니다.`, 'success')
      clearDocSelection()
    } catch (err) {
      showToast('캐시 삭제 실패: ' + err.message, 'error')
    }
  })

  $('lib-select-compare-btn')?.addEventListener('click', () => {
    const ids = Array.from(selectedDocIds)
    if (ids.length < 2 || ids.length > 5) {
      showToast('논문 비교는 2~5개 논문을 선택했을 때만 가능합니다.', 'warning')
      return
    }
    clearDocSelection()
    location.hash = `#compare?ids=${ids.map(encodeURIComponent).join(',')}`
  })

  $('lib-select-delete-btn')?.addEventListener('click', async () => {
    if (selectedDocIds.size === 0) return
    const count = selectedDocIds.size
    const ok = await showCustomConfirm(`선택한 ${count}개 논문을 삭제할까요? (휴지통으로 이동합니다)`, { title: '논문 삭제', confirmText: '삭제', danger: true })
    if (!ok) return
    try {
      await Promise.allSettled(Array.from(selectedDocIds).map(id => deleteLibraryDoc(id)))
      showToast(`${count}개 논문이 휴지통으로 이동되었습니다.`, 'success')
      clearDocSelection()
      await renderLibrary()
    } catch {
      showToast('삭제 실패', 'error')
    }
  })

  $('lib-select-close-btn')?.addEventListener('click', () => {
    clearDocSelection()
  })

  if (libCompareToggleBtn) {
    libCompareToggleBtn.addEventListener('click', () => {
      if (selectedDocIds.size === 0) {
        showToast('카드 우상단 체크 버튼을 눌러 비교할 논문을 선택하세요.', 'info')
      } else if (selectedDocIds.size >= 2 && selectedDocIds.size <= 5) {
        const ids = Array.from(selectedDocIds)
        clearDocSelection()
        location.hash = `#compare?ids=${ids.map(encodeURIComponent).join(',')}`
      } else {
        showToast('논문 비교는 2~5개 논문을 선택해야 합니다.', 'warning')
      }
    })
  }
}

function initLibraryDragSelection() {
  const dragSurface = $('page-outlet')
  const filterRow = $('library-filter-row')
  if (!libraryGrid || !dragSurface || !filterRow) return
  let dragState = null
  let marquee = null

  const removeMarquee = () => {
    marquee?.remove()
    marquee = null
    document.body.classList.remove('library-marquee-selecting')
  }

  const finishDragSelection = (event, cancelled = false) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    if (cancelled) replaceDocSelection(dragState.baseIds)
    if (dragSurface.hasPointerCapture?.(event.pointerId)) {
      dragSurface.releasePointerCapture(event.pointerId)
    }
    dragState = null
    removeMarquee()
  }

  dragSurface.addEventListener('pointerdown', event => {
    const selectionTop = filterRow.getBoundingClientRect().bottom
    if (
      event.button !== 0 ||
      event.isPrimary === false ||
      (event.pointerType && event.pointerType !== 'mouse') ||
      state.currentWorkspacePage !== 'library' ||
      state.currentLibraryTab === 'trash' ||
      event.clientY < selectionTop ||
      event.target.closest('.doc-card, .doc-list-row, .library-folder-card, button, a, input, textarea, select')
    ) return

    const toggle = event.ctrlKey || event.metaKey
    const baseIds = new Set(selectedDocIds)
    if (!toggle) replaceDocSelection(new Set())
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseIds,
      toggle,
      active: false,
    }
    dragSurface.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  })

  dragSurface.addEventListener('pointermove', event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY)
    if (!dragState.active && distance < 4) return
    if (!dragState.active) {
      dragState.active = true
      marquee = document.createElement('div')
      marquee.className = 'library-selection-marquee'
      marquee.setAttribute('aria-hidden', 'true')
      document.body.appendChild(marquee)
      document.body.classList.add('library-marquee-selecting')
    }

    const selectionRect = createSelectionRect(
      dragState.startX,
      dragState.startY,
      event.clientX,
      event.clientY,
    )
    Object.assign(marquee.style, {
      left: `${selectionRect.left}px`,
      top: `${selectionRect.top}px`,
      width: `${selectionRect.width}px`,
      height: `${selectionRect.height}px`,
    })

    const items = Array.from(
      libraryGrid.querySelectorAll('.doc-card[data-id], .doc-list-row[data-id]'),
      element => ({ id: element.dataset.id, rect: element.getBoundingClientRect() }),
    )
    replaceDocSelection(resolveDragSelection(
      dragState.baseIds,
      items,
      selectionRect,
      dragState.toggle,
    ))
    event.preventDefault()
  })

  dragSurface.addEventListener('pointerup', event => finishDragSelection(event))
  dragSurface.addEventListener('pointercancel', event => finishDragSelection(event, true))
  window.addEventListener('blur', () => {
    if (!dragState) return
    if (dragSurface.hasPointerCapture?.(dragState.pointerId)) {
      dragSurface.releasePointerCapture(dragState.pointerId)
    }
    replaceDocSelection(dragState.baseIds)
    dragState = null
    removeMarquee()
  })
}

initSelectToolbarEvents()
initLibraryDragSelection()


// ── 여러 논문 비교 채팅 화면 ────────────────────────────
let compareChatState = { docIds: [], docs: [], history: [], activeStream: null, currentText: '' }

function renderCompareChatMessage(role, content, isHtml = false) {
  const msgEl = document.createElement('div')
  msgEl.className = `chat-message ${role}`

  const bubbleEl = document.createElement('div')
  bubbleEl.className = 'message-bubble'
  if (isHtml) bubbleEl.innerHTML = content
  else bubbleEl.textContent = content
  msgEl.appendChild(bubbleEl)

  if (content) appendCompareActionButtons(msgEl, role, content)

  compareChatMessages.appendChild(msgEl)
  compareChatMessages.scrollTop = compareChatMessages.scrollHeight
  return msgEl
}

function appendCompareActionButtons(msgEl, role, content) {
  if (!content || content.includes('chat-error-text')) return
  const actionsEl = document.createElement('div')
  actionsEl.className = 'message-actions'
  actionsEl.style.display = 'flex'
  actionsEl.style.gap = '8px'
  actionsEl.style.marginTop = '4px'
  actionsEl.style.alignSelf = role === 'user' ? 'flex-end' : 'flex-start'

  const copyBtn = document.createElement('button')
  copyBtn.className = 'msg-action-btn'
  copyBtn.innerHTML = `${icon('clipboard', 12, 'style="vertical-align:-2px;margin-right:3px"')}복사`
  copyBtn.style.background = 'none'
  copyBtn.style.border = 'none'
  copyBtn.style.color = 'var(--text-muted)'
  copyBtn.style.fontSize = '11px'
  copyBtn.style.cursor = 'pointer'
  copyBtn.title = '텍스트 복사'
  copyBtn.addEventListener('click', () => {
    const text = msgEl.querySelector('.message-bubble').textContent
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('텍스트가 복사되었습니다.', 'success')
      }).catch(() => showToast('복사 실패', 'error'))
    }
  })
  actionsEl.appendChild(copyBtn)
  msgEl.appendChild(actionsEl)
}

function appendCompareTypingIndicator() {
  const msgEl = document.createElement('div')
  msgEl.className = 'chat-message assistant temp-typing'
  const bubbleEl = document.createElement('div')
  bubbleEl.className = 'message-bubble'
  bubbleEl.innerHTML = `<div class="typing-container" style="display: flex; align-items: center; gap: 8px;"><span class="typing-text" style="font-size: 12px; color: var(--text-secondary);">AI가 답변을 준비하고 있습니다</span><div class="typing-indicator" style="display: flex; gap: 3px; align-items: center;"><span></span><span></span><span></span></div></div>`
  msgEl.appendChild(bubbleEl)
  compareChatMessages.appendChild(msgEl)
  compareChatMessages.scrollTop = compareChatMessages.scrollHeight
  return msgEl
}

function removeCompareTypingIndicator() {
  compareChatMessages.querySelectorAll('.temp-typing').forEach(el => el.remove())
}

function updateCompareChatSendBtnIcon(isGenerating) {
  if (!compareChatSendBtn) return
  if (isGenerating) {
    compareChatSendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2" /></svg>`
    compareChatSendBtn.title = '답변 생성 중단'
  } else {
    compareChatSendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`
    compareChatSendBtn.title = '전송'
  }
}

function renderCompareGreeting() {
  const titles = compareChatState.docs
    .map((d, i) => `${i + 1}. ${escapeHtml((d.metadata && d.metadata.title) ? d.metadata.title : d.filename)}`)
    .join('<br>')
  renderCompareChatMessage('assistant',
    `선택하신 ${compareChatState.docs.length}편의 논문을 비교해서 답변해 드릴게요.<br><br>` +
    `<strong>비교 대상:</strong><br>${titles}<br><br>` +
    `<strong>${icon('info', 13, 'style="vertical-align:-2px;margin-right:3px"')}질문 예시:</strong>` +
    `<ul><li>두 논문의 핵심 방법론 차이가 뭐야?</li><li>실험 결과를 비교했을 때 어느 쪽이 더 우수해?</li><li>공통적으로 다루는 한계점이 있어?</li></ul>`,
    true)
}

// location.hash 대입은 브라우저에 따라 popstate와 hashchange를 둘 다 발생시켜,
// 두 리스너가 각각 handleRouting()을 호출하면서 openCompareScreen이 같은 문서
// 조합에 대해 중복 실행되는 경쟁 조건이 있었다(인사말 메시지가 두 번 렌더링됨).
// 첫 호출이 아직 비동기 작업 중일 때 같은 조합의 재진입 호출을 걸러낸다.
let compareOpeningIdsKey = null

async function openCompareScreen(docs, shouldPushState = true) {
  const docIds = docs.map(d => d.id)
  const idsKey = JSON.stringify([...docIds].sort())

  if (compareOpeningIdsKey === idsKey) return
  if (compareScreen.classList.contains('active') && JSON.stringify([...compareChatState.docIds].sort()) === idsKey) return
  compareOpeningIdsKey = idsKey

  if (compareChatState.activeStream) { compareChatState.activeStream(); compareChatState.activeStream = null }
  compareChatState = { docIds, docs, history: [], activeStream: null, currentText: '' }

  if (shouldPushState) {
    history.pushState({ screen: 'compare', ids: docIds }, '', `#compare?ids=${docIds.map(encodeURIComponent).join(',')}`)
  }

  if (compareDocChips) {
    compareDocChips.innerHTML = docs.map(d => {
      const title = (d.metadata && d.metadata.title) ? d.metadata.title : d.filename
      return `<span class="compare-doc-chip" title="${escapeHtml(title)}">${escapeHtml(title)}</span>`
    }).join('')
  }

  if (compareChatMessages) compareChatMessages.innerHTML = ''
  showCompareScreen()

  try {
    const res = await getCompareChatHistoryAPI(docIds)
    const savedHistory = res.history || []
    if (savedHistory.length === 0) {
      renderCompareGreeting()
    } else {
      savedHistory.forEach(msg => {
        renderCompareChatMessage(msg.role, msg.role === 'assistant' ? formatChatHtml(msg.content) : msg.content, msg.role === 'assistant')
        compareChatState.history.push({ role: msg.role, content: msg.content })
      })
    }
  } catch (err) {
    console.warn('비교 채팅 기록 로드 실패:', err)
    renderCompareGreeting()
  } finally {
    if (compareOpeningIdsKey === idsKey) compareOpeningIdsKey = null
  }
}

async function sendCompareChatMessage() {
  if (compareChatState.docIds.length < COMPARE_MIN_DOCS) return
  if (compareChatState.activeStream) return

  const text = compareChatInput.value.trim()
  if (!text) return

  compareChatInput.value = ''
  compareChatInput.style.height = 'auto'

  renderCompareChatMessage('user', text)
  compareChatState.history.push({ role: 'user', content: text })

  appendCompareTypingIndicator()
  compareChatInput.disabled = true
  updateCompareChatSendBtnIcon(true)

  let accumulatedText = ''
  let replyBubble = null
  let firstToken = true
  compareChatState.currentText = ''

  compareChatState.activeStream = streamCompareChatAPI(
    compareChatState.docIds,
    compareChatState.history,
    // onToken
    (token) => {
      if (firstToken) {
        if (!token.trim()) return
        removeCompareTypingIndicator()
        replyBubble = renderCompareChatMessage('assistant', '', true).querySelector('.message-bubble')
        firstToken = false
      }
      accumulatedText += token
      compareChatState.currentText = accumulatedText
      replyBubble.innerHTML = formatChatHtml(accumulatedText)
      compareChatMessages.scrollTop = compareChatMessages.scrollHeight
    },
    // onDone
    () => {
      compareChatState.activeStream = null
      compareChatState.history.push({ role: 'assistant', content: accumulatedText })
      if (replyBubble) {
        replyBubble.innerHTML = formatChatHtml(accumulatedText)
        if (replyBubble.parentElement) appendCompareActionButtons(replyBubble.parentElement, 'assistant', accumulatedText)
      }
      compareChatInput.disabled = false
      updateCompareChatSendBtnIcon(false)
      compareChatInput.focus()
    },
    // onError
    (err) => {
      removeCompareTypingIndicator()
      compareChatState.activeStream = null
      if (firstToken) {
        renderCompareChatMessage('assistant', `<span class="chat-error-text">${icon('alertTriangle', 13, 'style="vertical-align:-2px;margin-right:3px"')}답변 중 오류가 발생했습니다: ${escapeHtml(err.message)}</span>`, true)
      } else if (replyBubble) {
        replyBubble.innerHTML += `<br><br><span style="color: var(--error);">[오류: ${err.message}]</span>`
      }
      compareChatInput.disabled = false
      updateCompareChatSendBtnIcon(false)
      compareChatInput.focus()
    }
  )
}

if (compareChatSendBtn) {
  compareChatSendBtn.addEventListener('click', () => {
    if (compareChatState.activeStream) {
      compareChatState.activeStream()
      compareChatState.activeStream = null
      removeCompareTypingIndicator()
      if (compareChatState.currentText) {
        compareChatState.history.push({ role: 'assistant', content: compareChatState.currentText })
      } else {
        compareChatState.history.pop()
      }
      showToast('답변 생성이 중단되었습니다.', 'info')
      compareChatInput.disabled = false
      updateCompareChatSendBtnIcon(false)
      compareChatInput.focus()
    } else {
      sendCompareChatMessage()
    }
  })
}

if (compareChatInput) {
  compareChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendCompareChatMessage()
    }
  })
  compareChatInput.addEventListener('input', () => {
    compareChatInput.style.height = 'auto'
    compareChatInput.style.height = `${compareChatInput.scrollHeight}px`
  })
}

if (compareBackBtn) {
  compareBackBtn.addEventListener('click', () => {
    if (compareChatState.activeStream) { compareChatState.activeStream(); compareChatState.activeStream = null }
    showLibraryScreen()
  })
}

// ── 단일 논문 대화 화면 (뷰어 없이 채팅 메시지 + 입력창만) ──────────────
// AI Chats 페이지의 "대화 열기"는 기존에 뷰어를 열고 채팅 사이드바를 함께
// 펼치는 방식(#viewer?id=...&chat=1)이었는데, PDF 없이 대화만 보고 싶다는
// 요청에 따라 이 화면으로 대신 연다. 백엔드는 그대로 재사용한다 - streamChatAPI/
// getChatHistoryAPI는 이미 뷰어를 실제로 "연" 적이 없어도 동작한다
// (require_session_owner → ensure_session이 세션이 메모리에 없으면 DB 문서로부터
// 알아서 복구한다, backend/routers/upload.py). 채팅 렌더링/전송 로직은 바로 위
// compareChatState/openCompareScreen 패턴을 논문 1편짜리로 그대로 옮긴 것이다.
//
// 화면 자체는 처음에 뷰어 없는 전체화면(#chat-screen)으로 만들었었는데,
// 목록에서 다른 페이지로 완전히 이동해버려 사이드바/탑바가 사라지는 게
// 어색하다는 피드백을 받아 Library 상세 패널(openLibraryDetailPanel)과 동일한
// "우측 슬라이드 드로어" 패턴으로 바꿨다 - AI Chats 페이지는 그 자리에 계속
// 떠 있고, 드로어만 그 위에 열고 닫는다.
let chatDrawerState = { docId: null, doc: null, history: [], activeStream: null, currentText: '' }

function renderChatDrawerMessage(role, content, isHtml = false, showActions = true) {
  const msgEl = document.createElement('div')
  msgEl.className = `chat-message ${role}`

  const bubbleEl = document.createElement('div')
  bubbleEl.className = 'message-bubble'
  if (isHtml) bubbleEl.innerHTML = content
  else bubbleEl.textContent = content
  msgEl.appendChild(bubbleEl)

  if (content && showActions) appendChatDrawerActionButtons(msgEl, role, content)

  chatDrawerMessages.appendChild(msgEl)
  chatDrawerMessages.scrollTop = chatDrawerMessages.scrollHeight
  return msgEl
}

function appendChatDrawerActionButtons(msgEl, role, content) {
  if (!content || content.includes('chat-error-text')) return
  const actionsEl = document.createElement('div')
  actionsEl.className = 'message-actions'
  actionsEl.style.display = 'flex'
  actionsEl.style.gap = '8px'
  actionsEl.style.marginTop = '4px'
  actionsEl.style.alignSelf = role === 'user' ? 'flex-end' : 'flex-start'

  const copyBtn = document.createElement('button')
  copyBtn.className = 'msg-action-btn'
  copyBtn.innerHTML = `${icon('clipboard', 12, 'style="vertical-align:-2px;margin-right:3px"')}복사`
  copyBtn.style.background = 'none'
  copyBtn.style.border = 'none'
  copyBtn.style.color = 'var(--text-muted)'
  copyBtn.style.fontSize = '11px'
  copyBtn.style.cursor = 'pointer'
  copyBtn.title = '텍스트 복사'
  copyBtn.addEventListener('click', () => {
    const text = msgEl.querySelector('.message-bubble').textContent
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('텍스트가 복사되었습니다.', 'success')
      }).catch(() => showToast('복사 실패', 'error'))
    }
  })
  actionsEl.appendChild(copyBtn)

  if (role === 'assistant') {
    const verifyBtn = document.createElement('button')
    verifyBtn.type = 'button'
    verifyBtn.className = 'msg-action-btn'
    verifyBtn.innerHTML = icon('checkCircle', 12, 'style="vertical-align:-2px;margin-right:3px"') + escapeHtml(t('chat:evidence.verifyAction'))
    verifyBtn.style.background = 'none'
    verifyBtn.style.border = 'none'
    verifyBtn.style.color = 'var(--text-muted)'
    verifyBtn.style.fontSize = '11px'
    verifyBtn.style.cursor = 'pointer'
    verifyBtn.title = t('chat:evidence.verifyAction')
    verifyBtn.addEventListener('click', () => {
      if (chatDrawerState.activeStream) return
      chatDrawerInput.value = t('chat:evidence.verifyPrompt')
      sendChatDrawerMessage()
    })
    actionsEl.appendChild(verifyBtn)
  }
  msgEl.appendChild(actionsEl)
}

function appendChatDrawerTypingIndicator() {
  const msgEl = document.createElement('div')
  msgEl.className = 'chat-message assistant temp-typing'
  const bubbleEl = document.createElement('div')
  bubbleEl.className = 'message-bubble'
  bubbleEl.innerHTML = `<div class="typing-container" style="display: flex; align-items: center; gap: 8px;"><span class="typing-text" style="font-size: 12px; color: var(--text-secondary);">AI가 답변을 준비하고 있습니다</span><div class="typing-indicator" style="display: flex; gap: 3px; align-items: center;"><span></span><span></span><span></span></div></div>`
  msgEl.appendChild(bubbleEl)
  chatDrawerMessages.appendChild(msgEl)
  chatDrawerMessages.scrollTop = chatDrawerMessages.scrollHeight
  return msgEl
}

function removeChatDrawerTypingIndicator() {
  chatDrawerMessages.querySelectorAll('.temp-typing').forEach(el => el.remove())
}

function updateChatDrawerSendBtnIcon(isGenerating) {
  if (!chatDrawerSendBtn) return
  if (isGenerating) {
    chatDrawerSendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2" /></svg>`
    chatDrawerSendBtn.title = '답변 생성 중단'
  } else {
    chatDrawerSendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`
    chatDrawerSendBtn.title = '전송'
  }
}

function renderChatDrawerGreeting(doc) {
  const title = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
  renderChatDrawerMessage('assistant',
    `<strong>${escapeHtml(title)}</strong>에 대해 무엇이든 물어보세요.<br><br>` +
    `<strong>${icon('info', 13, 'style="vertical-align:-2px;margin-right:3px"')}질문 예시:</strong>` +
    `<ul><li>이 논문의 핵심 기여는 무엇인가요?</li><li>실험 설정을 요약해줄 수 있나요?</li><li>이 방법론의 한계점은 뭔가요?</li></ul>`,
    true, false)
}

// location.hash 대입은 popstate/hashchange를 둘 다 발생시킬 수 있어(openCompareScreen과
// 동일한 이유), 같은 문서에 대한 재진입 호출을 걸러낸다.
let chatDrawerOpeningDocId = null

// 드로어를 여는 유일한 경로는 handleRouting()의 '#chat?id=' 분기다(AI Chats
// 목록의 "대화" 버튼은 location.hash를 그 형태로 바꿀 뿐이라 hash 갱신은
// 호출부에서 이미 끝난 상태) - 그래서 여기서는 URL을 직접 건드리지 않는다.
async function openChatDrawer(doc) {
  if (chatDrawerOpeningDocId === doc.id) return
  if (chatDrawerEl.classList.contains('open') && chatDrawerState.docId === doc.id) return
  chatDrawerOpeningDocId = doc.id

  if (chatDrawerState.activeStream) { chatDrawerState.activeStream(); chatDrawerState.activeStream = null }
  chatDrawerState = { docId: doc.id, doc, history: [], activeStream: null, currentText: '' }

  const title = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
  if (chatDrawerTitle) chatDrawerTitle.textContent = title

  if (chatDrawerMessages) chatDrawerMessages.innerHTML = ''
  chatDrawerOverlayEl.classList.add('open')
  chatDrawerEl.classList.add('open')
  chatDrawerEl.setAttribute('aria-hidden', 'false')

  try {
    const res = await getChatHistoryAPI(doc.id)
    const savedHistory = res.history || []
    if (savedHistory.length === 0) {
      renderChatDrawerGreeting(doc)
    } else {
      savedHistory.forEach(msg => {
        const isAssistant = msg.role === 'assistant'
        let renderedContent = isAssistant ? formatChatHtml(msg.content, Number(doc.total_pages) || 0) : formatUserChatHtml(msg.content, doc.id)
        if (isAssistant && msg.stale) {
          renderedContent = `<span class="chat-stale-revision-badge">${t("chat:staleRevision")}</span>${renderedContent}`
        }
        const messageElement = renderChatDrawerMessage(msg.role, renderedContent, true)
        if (isAssistant && msg.evidence?.length) {
          attachEvidenceToBubble(messageElement.querySelector('.message-bubble'), msg.evidence)
        }
        if (isAssistant && msg.verification) renderVerificationBadge(messageElement, msg.verification)
        chatDrawerState.history.push({ role: msg.role, content: msg.content })
      })
    }
  } catch (err) {
    console.warn('논문 채팅 기록 로드 실패:', err)
    renderChatDrawerGreeting(doc)
  } finally {
    if (chatDrawerOpeningDocId === doc.id) chatDrawerOpeningDocId = null
  }
}

// UI만 닫는다(URL 정리는 호출부 책임) - showWorkspacePage()에서 다른 페이지로
// 넘어갈 때도 방어적으로 호출하므로, 여기서 훅 자체를 hash에 대입하면
// hashchange가 다시 발생해 라우팅이 두 번 도는 문제가 생긴다.
function closeChatDrawer() {
  if (!chatDrawerState.docId) return
  if (chatDrawerState.activeStream) { chatDrawerState.activeStream(); chatDrawerState.activeStream = null }
  chatDrawerState = { docId: null, doc: null, history: [], activeStream: null, currentText: '' }
  chatDrawerOverlayEl.classList.remove('open')
  chatDrawerEl.classList.remove('open')
  chatDrawerEl.setAttribute('aria-hidden', 'true')
}

// 닫기 버튼/오버레이 클릭/Esc처럼 "사용자가 직접 닫은" 경우에만 URL도
// 같이 정리한다(뒤로가기로 닫힌 경우는 popstate가 이미 hash를 바꿔놨음).
function requestCloseChatDrawer() {
  closeChatDrawer()
  if (location.hash.startsWith('#chat?id=')) {
    history.pushState(null, '', '#chats')
  }
}

async function sendChatDrawerMessage() {
  if (!chatDrawerState.docId) return
  if (chatDrawerState.activeStream) return

  const text = chatDrawerInput.value.trim()
  if (!text) return

  chatDrawerInput.value = ''
  chatDrawerInput.style.height = 'auto'

  renderChatDrawerMessage('user', text)
  chatDrawerState.history.push({ role: 'user', content: text })

  appendChatDrawerTypingIndicator()
  chatDrawerInput.disabled = true
  updateChatDrawerSendBtnIcon(true)

  let accumulatedText = ''
  let replyBubble = null
  let firstToken = true
  let responseEvidence = []
  let responseVerification = null
  chatDrawerState.currentText = ''

  chatDrawerState.activeStream = streamChatAPI(
    chatDrawerState.docId,
    chatDrawerState.history,
    // onToken
    (token) => {
      if (firstToken) {
        if (!token.trim()) return
        removeChatDrawerTypingIndicator()
        replyBubble = renderChatDrawerMessage('assistant', '', true).querySelector('.message-bubble')
        firstToken = false
      }
      accumulatedText += token
      chatDrawerState.currentText = accumulatedText
      replyBubble.innerHTML = formatChatHtml(accumulatedText, Number(chatDrawerState.doc?.total_pages) || 0)
      chatDrawerMessages.scrollTop = chatDrawerMessages.scrollHeight
    },
    // onDone
    () => {
      chatDrawerState.activeStream = null
      chatDrawerState.history.push({ role: 'assistant', content: accumulatedText })
      if (replyBubble) {
        replyBubble.innerHTML = formatChatHtml(accumulatedText, Number(chatDrawerState.doc?.total_pages) || 0)
        attachEvidenceToBubble(replyBubble, responseEvidence)
        if (replyBubble.parentElement) {
          renderVerificationBadge(replyBubble.parentElement, responseVerification)
          appendChatDrawerActionButtons(replyBubble.parentElement, 'assistant', accumulatedText)
        }
      }
      chatDrawerInput.disabled = false
      updateChatDrawerSendBtnIcon(false)
      chatDrawerInput.focus()
    },
    // onError
    (err) => {
      removeChatDrawerTypingIndicator()
      chatDrawerState.activeStream = null
      const retryButton = `<button type="button" class="chat-retry-message-btn" data-chat-drawer-retry="${encodeURIComponent(text)}">${t('chat:retrySameQuestion')}</button>`
      if (firstToken) {
        renderChatDrawerMessage('assistant', `<span class="chat-error-text">${icon('alertTriangle', 13, 'style="vertical-align:-2px;margin-right:3px"')}답변 중 오류가 발생했습니다: ${escapeHtml(err.message)}</span>${retryButton}`, true)
      } else if (replyBubble) {
        replyBubble.innerHTML += `<br><br><span style="color: var(--error);">[오류: ${escapeHtml(err.message)}]</span>${retryButton}`
      }
      chatDrawerInput.disabled = false
      updateChatDrawerSendBtnIcon(false)
      chatDrawerInput.focus()
    },
    null,
    {
      screenContext: { mode: 'standalone', include_visual: false },
      verifyEvidence: /근거\s*검증|verify\s+(?:the\s+)?evidence/i.test(text),
    },
    (eventName, payload) => {
      if (eventName === 'evidence') responseEvidence = payload?.items || []
      if (eventName === 'verification') responseVerification = payload
    }
  )
}

if (chatDrawerMessages) {
  chatDrawerMessages.addEventListener('click', event => {
    const retryButton = event.target.closest('[data-chat-drawer-retry]')
    if (retryButton) {
      const question = decodeURIComponent(retryButton.dataset.chatDrawerRetry || '')
      const errorMessage = retryButton.closest('.chat-message')
      const userMessage = errorMessage?.previousElementSibling
      const lastHistory = chatDrawerState.history.at(-1)
      if (lastHistory?.role === 'user' && lastHistory.content === question) {
        chatDrawerState.history.pop()
        if (userMessage?.classList.contains('user')) userMessage.remove()
      }
      errorMessage?.remove()
      chatDrawerInput.value = question
      sendChatDrawerMessage()
      return
    }
    const citation = event.target.closest('[data-page-citation]')
    if (!citation || !chatDrawerState.docId) return
    const page = Number(citation.dataset.pageCitation)
    if (!Number.isInteger(page) || page < 1) return
    const docId = chatDrawerState.docId
    const params = new URLSearchParams({ id: docId, page: String(page) })
    const quote = citation.dataset.evidenceQuote
    if (quote) params.set('quote', quote)
    params.set('occurrence', citation.dataset.evidenceOccurrence || '1')
    closeChatDrawer()
    location.hash = 'viewer?' + params.toString()
  })
}

if (chatDrawerSendBtn) {
  chatDrawerSendBtn.addEventListener('click', () => {
    if (chatDrawerState.activeStream) {
      chatDrawerState.activeStream()
      chatDrawerState.activeStream = null
      removeChatDrawerTypingIndicator()
      if (chatDrawerState.currentText) {
        chatDrawerState.history.push({ role: 'assistant', content: chatDrawerState.currentText })
      } else {
        chatDrawerState.history.pop()
      }
      showToast('답변 생성이 중단되었습니다.', 'info')
      chatDrawerInput.disabled = false
      updateChatDrawerSendBtnIcon(false)
      chatDrawerInput.focus()
    } else {
      sendChatDrawerMessage()
    }
  })
}

if (chatDrawerInput) {
  chatDrawerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendChatDrawerMessage()
    }
  })
  chatDrawerInput.addEventListener('input', () => {
    chatDrawerInput.style.height = 'auto'
    chatDrawerInput.style.height = `${chatDrawerInput.scrollHeight}px`
  })
}

if (chatDrawerCloseBtn) chatDrawerCloseBtn.addEventListener('click', requestCloseChatDrawer)
if (chatDrawerOverlayEl) chatDrawerOverlayEl.addEventListener('click', requestCloseChatDrawer)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatDrawerEl.classList.contains('open')) requestCloseChatDrawer()
})

if (chatDrawerViewerBtn) {
  chatDrawerViewerBtn.addEventListener('click', () => {
    if (chatDrawerState.docId) {
      const docId = chatDrawerState.docId
      closeChatDrawer()
      location.hash = `viewer?id=${encodeURIComponent(docId)}`
    }
  })
}

// 라이브러리 전용 키보드 단축키. 텍스트 입력 중에는 브라우저 기본 동작을 보존한다.
document.addEventListener('keydown', async e => {
  if (state.currentWorkspacePage !== 'library' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return
  const mod = e.ctrlKey || e.metaKey
  const focusedFolder = getFocusedLibraryFolder()
  if (mod && e.key === '[') {
    e.preventDefault()
    history.back()
  } else if (mod && e.key === ']') {
    e.preventDefault()
    history.forward()
  } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault()
    await undoLastLibraryAction()
  } else if (mod && e.key.toLowerCase() === 'x' && selectedDocIds.size) {
    e.preventDefault()
    libraryClipboard = { kind: 'documents', mode: 'cut', ids: Array.from(selectedDocIds) }
    showToast(`${selectedDocIds.size}개 논문을 잘라냈습니다.`, 'info')
  } else if (mod && e.key.toLowerCase() === 'c' && selectedDocIds.size) {
    e.preventDefault()
    libraryClipboard = null
    showToast('논문은 한 폴더에만 둘 수 있습니다. 이동하려면 Ctrl/Cmd+X를 사용하세요.', 'info')
  } else if (mod && e.key.toLowerCase() === 'x' && focusedFolder) {
    e.preventDefault()
    libraryClipboard = { kind: 'folder', mode: 'cut', id: focusedFolder.id }
    showToast(`“${focusedFolder.name}” 폴더를 잘라냈습니다.`, 'info')
  } else if (mod && e.key.toLowerCase() === 'v' && libraryClipboard) {
    e.preventDefault()
    try {
      if (libraryClipboard.mode === 'copy') throw new Error('논문 복사는 지원되지 않습니다. 이동하려면 잘라내기를 사용하세요.')
      if (libraryClipboard.kind === 'folder') {
        const folder = libraryFolders.find(candidate => candidate.id === libraryClipboard.id)
        if (!folder) throw new Error('잘라낸 폴더를 찾을 수 없습니다.')
        if (folder.id === activeLibraryFolderId || folderDescendants(folder.id).has(activeLibraryFolderId)) throw new Error('폴더를 자기 자신 또는 하위 폴더에 붙여넣을 수 없습니다.')
        await moveFolderWithUndo(folder, activeLibraryFolderId)
      } else if (libraryClipboard.ids?.length) {
        await moveDocumentsWithUndo(libraryClipboard.ids, activeLibraryFolderId)
      }
      showToast('현재 폴더로 이동했습니다.', 'success')
      if (libraryClipboard.mode === 'cut') libraryClipboard = null
      await renderLibrary()
    } catch (err) { showToast(err.message || '붙여넣기 실패', 'error') }
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDocIds.size) {
    e.preventDefault()
    document.querySelector('#lib-select-delete-btn')?.click()
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && focusedFolder) {
    e.preventDefault()
    await requestDeleteFolder(focusedFolder)
  } else if ((e.key === 'F2' || e.key === 'Enter') && focusedFolder) {
    e.preventDefault()
    await requestRenameFolder(focusedFolder)
  } else if (e.key === 'Escape') {
    clearDocSelection()
    libraryClipboard = null
    setLibraryAddMenuOpen(false)
  }
})

// ── Library 재설계: 상태 필터 탭(전체/읽지 않음/읽는 중/완료/즐겨찾기) + 정렬 + 즐겨찾기 ──
// 즐겨찾기는 documents.metadata에 아직 star/favorite 개념이 없어(백엔드 스키마에
// 없음) 새 필드를 추가하지 않고 로컬 전용 편의 기능으로만 제공한다 - localStorage에만
// 저장되며 기기 간 동기화되거나 서버에 반영되지 않는다.
let activeStatusFilter = 'all' // 'all' | 'unread' | 'reading' | 'finished' | 'favorites'
let librarySortMode = localStorage.getItem('easypaper_library_sort') || 'recent' // 'recent' | 'last-read' | 'title' | 'progress'

const LIBRARY_FAVORITES_KEY = 'easypaper_library_favorites'
function getFavoriteIds() {
  try { return new Set(JSON.parse(localStorage.getItem(LIBRARY_FAVORITES_KEY) || '[]')) } catch { return new Set() }
}
function isFavoriteDoc(docId) { return getFavoriteIds().has(docId) }
function toggleFavoriteDoc(docId) {
  const ids = getFavoriteIds()
  if (ids.has(docId)) ids.delete(docId); else ids.add(docId)
  localStorage.setItem(LIBRARY_FAVORITES_KEY, JSON.stringify(Array.from(ids)))
  return ids.has(docId)
}

// 읽은 페이지(뷰어가 스크롤 위치를 저장하는 metadata.last_page - 책갈피 기능과
// 동일한 필드) 기준 진행률. 번역 진행률(translated_pages)은 "얼마나 번역했는지"일
// 뿐 "얼마나 읽었는지"가 아니라서 카드/대시보드의 기본 퍼센트로는 쓰지 않는다
// (번역 진행률은 뷰어 안의 번역 진행 표시에서만 쓴다).
function getLibraryReadProgress(doc) {
  if (doc.metadata?.read === true) return 100
  const lastPage = doc.metadata?.last_page
  const total = doc.total_pages || 1
  if (!Number.isInteger(lastPage) || lastPage <= 0) return 0
  return Math.min(100, Math.round((lastPage / total) * 100))
}

// 읽기 진행 상태 기준 분류: Unread=읽은 기록이 아예 없음, Reading=일부 페이지까지
// 읽었지만 아직 "읽음" 처리 전, Finished=완독 표시(metadata.read===true)됨.
function getLibraryDocStatus(doc) {
  const isRead = doc.metadata?.read === true
  if (isRead) return 'finished'
  if (getLibraryReadProgress(doc) <= 0) return 'unread'
  return 'reading'
}

const LIBRARY_STATUS_TABS = [
  { key: 'all', label: '전체' },
  { key: 'unread', label: '읽지 않음' },
  { key: 'reading', label: '읽는 중' },
  { key: 'finished', label: '완료' },
  { key: 'favorites', label: '즐겨찾기' },
]

function renderLibraryStatusTabs(docs) {
  const el = $('library-status-tabs')
  if (!el) return
  if (state.currentLibraryTab === 'trash') { el.innerHTML = ''; el.classList.add('hidden'); return }
  el.classList.remove('hidden')

  const favIds = getFavoriteIds()
  const counts = { all: docs.length, unread: 0, reading: 0, finished: 0, favorites: 0 }
  docs.forEach(doc => {
    counts[getLibraryDocStatus(doc)]++
    if (favIds.has(doc.id)) counts.favorites++
  })

  el.innerHTML = LIBRARY_STATUS_TABS.map(t => `
    <button type="button" class="lib-status-tab ${activeStatusFilter === t.key ? 'active' : ''}" data-status="${t.key}">
      <span>${t.label}</span><span class="lib-status-tab-count">${counts[t.key]}</span>
    </button>
  `).join('')
  el.querySelectorAll('.lib-status-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (activeStatusFilter === btn.dataset.status) return
      activeStatusFilter = btn.dataset.status
      filterLibraryCards(currentLibraryDocs)
      renderLibraryStatusTabs(currentLibraryDocs)
    })
  })
}

function sortDocsByMode(docs) {
  const sorted = docs.slice()
  if (librarySortMode === 'title') {
    sorted.sort((a, b) => {
      const ta = (a.metadata?.title || a.filename || '').toLowerCase()
      const tb = (b.metadata?.title || b.filename || '').toLowerCase()
      return ta.localeCompare(tb)
    })
  } else if (librarySortMode === 'progress') {
    sorted.sort((a, b) => getLibraryReadProgress(b) - getLibraryReadProgress(a))
  } else if (librarySortMode === 'last-read') {
    sorted.sort(compareDocsByLastRead)
  } else {
    sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }
  return sorted
}

// 전체 탭(activeStatusFilter === 'all')에서는 완료(읽음 표시) 논문을 정렬 기준과
// 무관하게 항상 맨 뒤로 보낸다 - "다 읽은 논문"이 최신순/진행률순 목록 사이에
// 섞여 새로 봐야 할 논문을 찾기 번거롭다는 피드백에 따른 것. 완료 탭을 직접 볼
// 때(activeStatusFilter === 'finished')는 원래 정렬 순서를 그대로 유지한다.
function sortLibraryDocs(docs) {
  if (state.currentLibraryTab === 'trash' || activeStatusFilter !== 'all') {
    return sortDocsByMode(docs)
  }
  const unfinished = docs.filter(d => getLibraryDocStatus(d) !== 'finished')
  const finished = docs.filter(d => getLibraryDocStatus(d) === 'finished')
  return [...sortDocsByMode(unfinished), ...sortDocsByMode(finished)]
}

// Library 페이지의 새 UI 조각(상태 탭 / 정렬 드롭다운 / 상세 패널)은 index.html을
// 건드리지 않고 여기서 필요할 때 한 번만 삽입한다. renderLibrary()가 탭 전환/새로고침마다
// 다시 호출되므로 반드시 멱등이어야 한다(이미 삽입돼 있으면 아무것도 하지 않음).
// ── 폴더 트리 / Breadcrumb ───────────────────────────────────────────────────
let libraryFolders = []
let activeLibraryFolderId = null
let libraryClipboard = null
const libraryUndoStack = []
const FOLDER_COLORS = ['#6b7280', '#4f8ef7', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981']


function pushLibraryUndo(action) {
  libraryUndoStack.push(action)
  if (libraryUndoStack.length > 30) libraryUndoStack.shift()
}

function discardUndoActionsForDeletedItems(folderIds, paperIds) {
  for (let index = libraryUndoStack.length - 1; index >= 0; index--) {
    const action = libraryUndoStack[index]
    if (action.kind === 'documents') {
      action.entries = action.entries.filter(entry => (
        !paperIds.has(entry.id) && !folderIds.has(entry.folderId)
      ))
      if (action.entries.length === 0) libraryUndoStack.splice(index, 1)
    } else if (
      (action.kind === 'folderMove' && (folderIds.has(action.id) || folderIds.has(action.parentId))) ||
      (action.kind === 'folderUpdate' && folderIds.has(action.id))
    ) {
      libraryUndoStack.splice(index, 1)
    }
  }
}

async function moveDocumentsWithUndo(docIds, folderId) {
  const entries = docIds.map(id => ({ id, folderId: currentLibraryDocs.find(doc => doc.id === id)?.folder_id || null }))
  await moveLibraryDocuments(docIds, folderId)
  if (entries.some(entry => entry.folderId !== folderId)) pushLibraryUndo({ kind: 'documents', entries })
  clearDocSelection()
}
async function moveFolderWithUndo(folder, parentId) {
  await updateLibraryFolder(folder.id, { parent_id: parentId, move: true })
  if ((folder.parent_id || null) !== parentId) pushLibraryUndo({ kind: 'folderMove', id: folder.id, parentId: folder.parent_id || null })
}
async function updateFolderWithUndo(folder, payload) {
  await updateLibraryFolder(folder.id, payload)
  const previous = {}
  if (payload.name !== undefined) previous.name = folder.name
  if (payload.color !== undefined) previous.color = folder.color
  pushLibraryUndo({ kind: 'folderUpdate', id: folder.id, payload: previous })
}
async function undoLastLibraryAction() {
  const action = libraryUndoStack.pop()
  if (!action) { showToast('되돌릴 작업이 없습니다.', 'info'); return }
  try {
    if (action.kind === 'documents') {
      const groups = new Map()
      action.entries.forEach(entry => { const key = entry.folderId || ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry.id) })
      for (const [folderId, ids] of groups) await moveLibraryDocuments(ids, folderId || null)
    } else if (action.kind === 'folderMove') await updateLibraryFolder(action.id, { parent_id: action.parentId, move: true })
    else if (action.kind === 'folderUpdate') await updateLibraryFolder(action.id, action.payload)
    showToast('마지막 작업을 되돌렸습니다.', 'success')
    await renderLibrary()
  } catch (err) {
    const message = err.message || '실행 취소 실패'
    if (/찾을 수 없습니다/.test(message)) {
      showToast('삭제된 항목을 참조하는 실행 취소 기록을 건너뛰었습니다.', 'warning')
    } else {
      libraryUndoStack.push(action)
      showToast(message, 'error')
    }
  }
}

function folderPath(folderId) {
  const byId = new Map(libraryFolders.map(f => [f.id, f]))
  const path = []
  let current = folderId ? byId.get(folderId) : null
  while (current) { path.unshift(current); current = current.parent_id ? byId.get(current.parent_id) : null }
  return path
}
function folderDescendants(folderId) {
  const result = new Set([folderId]); let changed = true
  while (changed) { changed = false; for (const f of libraryFolders) if (f.parent_id && result.has(f.parent_id) && !result.has(f.id)) { result.add(f.id); changed = true } }
  return result
}
function setFolderDropTarget(el, folderId) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('folder-drop-target') })
  el.addEventListener('dragleave', () => el.classList.remove('folder-drop-target'))
  el.addEventListener('drop', async e => {
    e.preventDefault(); el.classList.remove('folder-drop-target')
    try {
      const raw = e.dataTransfer.getData('application/x-easypaper-item')
      if (!raw) {
        if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files, folderId)
        return
      }
      const item = JSON.parse(raw)
      if (item.kind === 'document') await moveDocumentsWithUndo(item.ids, folderId)
      if (item.kind === 'folder') {
        if (item.id === folderId || folderDescendants(item.id).has(folderId)) throw new Error('폴더를 자기 자신 또는 하위 폴더로 옮길 수 없습니다.')
        const folder = libraryFolders.find(candidate => candidate.id === item.id)
        if (!folder) throw new Error('폴더를 찾을 수 없습니다.')
        await moveFolderWithUndo(folder, folderId)
      }
      showToast('이동했습니다.', 'success'); await renderLibrary()
    } catch (err) { showToast(err.message || '이동 실패', 'error') }
  })
}
function showCustomTextDialog({ title, label, value = '', confirmText = '확인' }) {
  return new Promise(resolve => {
    const modal = document.createElement('div')
    modal.className = 'custom-confirm-modal-wrapper'
    modal.innerHTML = `<div class="custom-confirm-modal"><div class="custom-confirm-modal-header"><span class="custom-confirm-modal-title">${escapeHtml(title)}</span></div><div class="custom-confirm-modal-body"><label class="folder-dialog-label">${escapeHtml(label)}<input class="folder-dialog-input" value="${escapeHtml(value)}" maxlength="120" /></label></div><div class="custom-confirm-modal-footer"><button class="custom-confirm-btn cancel-btn">취소</button><button class="custom-confirm-btn confirm-btn primary-btn">${escapeHtml(confirmText)}</button></div></div>`
    document.body.appendChild(modal)
    const input = modal.querySelector('.folder-dialog-input')
    const close = result => { modal.classList.remove('active'); setTimeout(() => { modal.remove(); resolve(result) }, 200) }
    modal.querySelector('.cancel-btn').addEventListener('click', () => close(null))
    modal.querySelector('.confirm-btn').addEventListener('click', () => close(input.value.trim() || null))
    input.addEventListener('keydown', e => { if (e.key === 'Enter') close(input.value.trim() || null); if (e.key === 'Escape') close(null) })
    modal.addEventListener('click', e => { if (e.target === modal) close(null) })
    setTimeout(() => { modal.classList.add('active'); input.focus(); input.select() }, 10)
  })
}

function navigateLibraryFolder(folderId, { pushHistory = true } = {}) {
  const nextFolderId = folderId || null
  if (nextFolderId === activeLibraryFolderId && activeCategoryFilter === 'ALL') return
  clearDocSelection()
  activeLibraryFolderId = nextFolderId
  activeCategoryFilter = 'ALL'
  if (pushHistory) {
    history.pushState(
      { ...(history.state || {}), screen: 'library', page: 'library', libraryFolderId: nextFolderId },
      '',
      location.href,
    )
  }
  filterLibraryCards(currentLibraryDocs)
  renderFolderNavigation(currentLibraryDocs)
}

function renderFolderNavigation(docs) {
  const crumb = $('library-breadcrumb')
  if (!crumb) return
  const path = folderPath(activeLibraryFolderId)
  crumb.innerHTML = `<button data-folder-id="" class="library-breadcrumb-root">${icon('home', 14)}<span>전체 논문</span></button>${path.map((f, index) => `<span class="library-breadcrumb-separator">›</span><button data-folder-id="${escapeHtml(f.id)}" ${index === path.length - 1 ? 'aria-current="page"' : ''}>${icon('folder', 14)}<span>${escapeHtml(f.name)}</span></button>`).join('')}`
  crumb.querySelectorAll('button').forEach(el => {
    const id = el.dataset.folderId || null
    el.addEventListener('click', () => navigateLibraryFolder(id))
    setFolderDropTarget(el, id)
  })
}
async function openCreateFolderDialog(parentId = activeLibraryFolderId) {
  const name = await showCustomTextDialog({ title: '새 폴더', label: '폴더 이름', confirmText: '추가' })
  if (!name) return
  try { await createLibraryFolder({ name, parent_id: parentId, color: FOLDER_COLORS[0] }); await renderLibrary() } catch (err) { showToast(err.message || '폴더 생성 실패', 'error') }
}
function showFolderColorDialog(currentColor) {
  return new Promise(resolve => {
    const modal = document.createElement('div')
    modal.className = 'custom-confirm-modal-wrapper'
    modal.innerHTML = `<div class="custom-confirm-modal"><div class="custom-confirm-modal-header"><span class="custom-confirm-modal-title">폴더 색상</span></div><div class="custom-confirm-modal-body"><div class="folder-color-picker">${FOLDER_COLORS.map(color => `<button class="color-dot ${color === currentColor ? 'selected' : ''}" data-color="${color}" style="background:${color}" title="${color}"></button>`).join('')}<label class="folder-native-color" title="직접 색상 선택"><input type="color" value="${currentColor}"><span>+</span></label></div></div><div class="custom-confirm-modal-footer"><button class="custom-confirm-btn cancel-btn">취소</button></div></div>`
    document.body.appendChild(modal)
    const close = value => { modal.classList.remove('active'); setTimeout(() => { modal.remove(); resolve(value) }, 200) }
    modal.querySelector('.cancel-btn').addEventListener('click', () => close(null))
    modal.querySelectorAll('[data-color]').forEach(btn => btn.addEventListener('click', () => close(btn.dataset.color)))
    modal.querySelector('input[type="color"]').addEventListener('change', e => close(e.target.value))
    modal.addEventListener('click', e => { if (e.target === modal) close(null) })
    setTimeout(() => modal.classList.add('active'), 10)
  })
}

function showFolderContentsDeleteDialog(paperCount) {
  return new Promise(resolve => {
    const modal = document.createElement('div')
    modal.className = 'custom-confirm-modal-wrapper'
    modal.innerHTML = `<div class="custom-confirm-modal"><div class="custom-confirm-modal-header"><span class="custom-confirm-modal-title">폴더 안 논문 처리</span></div><div class="custom-confirm-modal-body">이 폴더와 하위 폴더에 논문 ${paperCount}개가 있습니다.<br>폴더 트리 삭제 후 논문을 어떻게 처리할까요?</div><div class="custom-confirm-modal-footer"><button class="custom-confirm-btn cancel-btn">취소</button><button class="custom-confirm-btn keep-btn">루트에 유지</button><button class="custom-confirm-btn confirm-btn">함께 휴지통으로 이동</button></div></div>`
    document.body.appendChild(modal)
    const close = value => { modal.classList.remove('active'); setTimeout(() => { modal.remove(); resolve(value) }, 200) }
    modal.querySelector('.cancel-btn').addEventListener('click', () => close(null))
    modal.querySelector('.keep-btn').addEventListener('click', () => close(false))
    modal.querySelector('.confirm-btn').addEventListener('click', () => close(true))
    modal.addEventListener('click', e => { if (e.target === modal) close(null) })
    setTimeout(() => modal.classList.add('active'), 10)
  })
}


function getFocusedLibraryFolder() {
  const card = document.activeElement
  if (!card?.classList?.contains('library-folder-card')) return null
  return libraryFolders.find(folder => folder.id === card.dataset.folderId) || null
}
async function requestRenameFolder(folder) {
  const name = await showCustomTextDialog({ title: '폴더 이름 변경', label: '폴더 이름', value: folder.name, confirmText: '저장' })
  if (name && name !== folder.name) { await updateFolderWithUndo(folder, { name }); await renderLibrary() }
}
async function requestDeleteFolder(folder) {
  const folderIds = folderDescendants(folder.id)
  const papersInTree = currentLibraryDocs.filter(doc => folderIds.has(doc.folder_id))
  const childFolderCount = folderIds.size - 1
  const paperCount = papersInTree.length
  const childFolderNotice = childFolderCount > 0 ? `\n하위 폴더 ${childFolderCount}개도 함께 삭제됩니다.` : ''
  const paperNotice = paperCount ? '' : '\n포함된 논문은 없으며 논문에는 영향이 없습니다.'
  const ok = await showCustomConfirm(`“${folder.name}” 폴더를 삭제할까요?${childFolderNotice}${paperNotice}`, { title: '폴더 삭제', confirmText: '삭제', danger: true })
  if (!ok) return
  let deletePapers = false
  if (paperCount > 0) {
    const choice = await showFolderContentsDeleteDialog(paperCount)
    if (choice === null) return
    deletePapers = choice
  }
  await deleteLibraryFolder(folder.id, deletePapers)
  discardUndoActionsForDeletedItems(folderIds, deletePapers ? new Set(papersInTree.map(doc => doc.id)) : new Set())
  await renderLibrary()
}

function closeFolderCardMenus() {
  document.querySelectorAll('.folder-card-actions').forEach(menu => {
    menu.classList.add('hidden')
    const folderId = menu.dataset.folderId
    const ownerCard = folderId ? document.querySelector(`.library-folder-card[data-folder-id="${CSS.escape(folderId)}"]`) : null
    const actionGroup = ownerCard?.querySelector('.folder-card-cta')
    if (actionGroup && menu.parentElement !== actionGroup) {
      const openButton = actionGroup.querySelector('.folder-card-open-btn')
      actionGroup.insertBefore(menu, openButton)
    }
    menu.removeAttribute('style')
  })
}

function positionFolderCardMenu(menu, trigger) {
  document.body.appendChild(menu)
  menu.classList.remove('hidden')
  const triggerRect = trigger.getBoundingClientRect()
  const menuWidth = menu.offsetWidth
  const menuHeight = menu.offsetHeight
  const left = Math.max(8, Math.min(triggerRect.right - menuWidth, window.innerWidth - menuWidth - 8))
  const belowTop = triggerRect.bottom + 6
  const top = belowTop + menuHeight <= window.innerHeight - 8 ? belowTop : Math.max(8, triggerRect.top - menuHeight - 6)
  menu.style.position = 'fixed'
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.right = 'auto'
  menu.style.zIndex = '100001'
}

function createFolderCard(folder) {
  const card = document.createElement('article')
  card.className = 'library-folder-card'
  card.draggable = true
  card.tabIndex = 0
  card.setAttribute('aria-label', `${folder.name} 폴더`)
  card.title = 'Enter/F2: 이름 변경 · Delete/Backspace: 삭제 · Ctrl/Cmd+X: 잘라내기'
  card.dataset.folderId = folder.id
  card.style.setProperty('--folder-color', folder.color)
  const isListView = libraryViewMode === 'list'
  const paperCount = currentLibraryDocs.filter(doc => (doc.folder_id || null) === folder.id).length
  const childFolderCount = libraryFolders.filter(candidate => (candidate.parent_id || null) === folder.id).length
  const menuHtml = `<button class="folder-card-menu" title="폴더 관리">${icon('moreVertical', 16)}</button><div class="folder-card-actions hidden"><button data-action="rename">이름 변경</button><button data-action="color">폴더 색상</button><button data-action="delete">폴더 삭제</button></div>`

  card.innerHTML = isListView
    ? `<div class="folder-card-icon">${icon('folder', 18, 'fill="currentColor" stroke="none"')}</div>
      <div class="folder-card-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</div>
      <div class="folder-card-meta">
        <span>${icon('fileText', 12)}${t('library:document.count', { count: paperCount })}</span>
        <span class="meta-dot"></span>
        <span>${icon('folder', 12)}하위 폴더 ${childFolderCount}개</span>
      </div>
      <div class="folder-card-cta">
        <button class="folder-card-rename-btn" title="이름 변경">${icon('edit3', 14)}</button>
        ${menuHtml}
        <button class="folder-card-open-btn" title="폴더 열기">${icon('externalLink', 14)}</button>
      </div>`
    : `<div class="folder-card-icon">${icon('folder', 32, 'fill="currentColor" stroke="none"')}</div><div class="folder-card-name">${escapeHtml(folder.name)}</div><div class="folder-card-meta">폴더 열기</div>${menuHtml}`
  card.addEventListener('click', e => {
    if (e.target.closest('.folder-card-menu, .folder-card-rename-btn, .folder-card-open-btn')) return
    navigateLibraryFolder(folder.id)
  })
  card.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-easypaper-item', JSON.stringify({ kind: 'folder', id: folder.id })); e.dataTransfer.effectAllowed = 'move' })
  setFolderDropTarget(card, folder.id)
  const menu = card.querySelector('.folder-card-actions')
  menu.dataset.folderId = folder.id
  const menuTrigger = card.querySelector('.folder-card-menu')
  menuTrigger.addEventListener('click', e => {
    e.stopPropagation()
    const shouldOpen = menu.classList.contains('hidden')
    closeFolderCardMenus()
    if (!shouldOpen) return
    if (isListView) positionFolderCardMenu(menu, menuTrigger)
    else menu.classList.remove('hidden')
  })
  card.querySelector('.folder-card-rename-btn')?.addEventListener('click', async e => {
    e.stopPropagation()
    try { await requestRenameFolder(folder) } catch (err) { showToast(err.message || '폴더 이름 변경 실패', 'error') }
  })
  card.querySelector('.folder-card-open-btn')?.addEventListener('click', e => {
    e.stopPropagation()
    navigateLibraryFolder(folder.id)
  })
  menu.addEventListener('click', async e => {
    e.stopPropagation()
    const action = e.target.dataset.action
    if (!action) return
    closeFolderCardMenus()
    try {
      if (action === 'rename') await requestRenameFolder(folder)
      if (action === 'color') { const color = await showFolderColorDialog(folder.color); if (color && color !== folder.color) { await updateFolderWithUndo(folder, { color }); await renderLibrary() } }
      if (action === 'delete') await requestDeleteFolder(folder)
    } catch (err) { showToast(err.message || '폴더 변경 실패', 'error') }
  })
  return card
}
// ── 라이브러리 우클릭 메뉴 ────────────────────────────────────────────────
let libraryContextMenu = null

function closeLibraryContextMenu() {
  libraryContextMenu?.remove()
  libraryContextMenu = null
}

function libraryContextMenuItem(action, label, iconName, { danger = false } = {}) {
  return `<button type="button" class="library-context-menu-item${danger ? ' danger' : ''}" role="menuitem" data-action="${action}">${icon(iconName, 15)}<span>${label}</span></button>`
}

function positionLibraryContextMenu(menu, clientX, clientY) {
  const margin = 8
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin))}px`
  menu.style.top = `${Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin))}px`
}

async function deleteDocFromContextMenu(doc) {
  const displayTitle = doc.metadata?.title || doc.filename
  const ok = await showCustomConfirm(`"${displayTitle}"을 삭제할까요? (휴지통으로 이동합니다)`, { title: '논문 삭제', confirmText: '삭제', danger: true })
  if (!ok) return
  await deleteLibraryDoc(doc.id)
  showToast('휴지통으로 이동되었습니다.', 'success')
  await renderLibrary()
}

async function clearDocCacheFromContextMenu(doc) {
  const displayTitle = doc.metadata?.title || doc.filename
  const ok = await showCustomConfirm(`"${displayTitle}"의 PDF 추출 캐시를 삭제할까요?\n(다음 열람 시 PDF를 다시 파싱하게 됩니다.)`, { title: 'PDF 캐시 삭제', confirmText: '캐시 삭제' })
  if (!ok) return
  await clearSingleDocCacheAPI(doc.id)
  showToast('PDF 추출 캐시가 삭제되었습니다.', 'success')
}

function showLibraryContextMenu(event, { doc = null, folder = null } = {}) {
  closeLibraryContextMenu()
  const menu = document.createElement('div')
  menu.className = 'library-context-menu'
  menu.setAttribute('role', 'menu')

  if (doc && state.currentLibraryTab === 'trash') {
    menu.innerHTML = [
      libraryContextMenuItem('restore', '복원', 'refreshCw'),
      '<div class="library-context-menu-separator" role="separator"></div>',
      libraryContextMenuItem('permanent-delete', '영구 삭제', 'trash2', { danger: true }),
    ].join('')
  } else if (doc) {
    menu.innerHTML = [
      libraryContextMenuItem('open', '논문 열기', 'externalLink'),
      libraryContextMenuItem('details', '상세 정보', 'info'),
      '<div class="library-context-menu-separator" role="separator"></div>',
      libraryContextMenuItem('select', selectedDocIds.has(doc.id) ? '선택 해제' : '선택', 'checkCircle'),
      libraryContextMenuItem('read', doc.metadata?.read === true ? '읽음 표시 해제' : '읽음으로 표시', 'bookOpen'),
      libraryContextMenuItem('favorite', isFavoriteDoc(doc.id) ? '즐겨찾기 해제' : '즐겨찾기', 'star'),
      '<div class="library-context-menu-separator" role="separator"></div>',
      libraryContextMenuItem('clear-cache', 'PDF 캐시 삭제', 'refreshCw'),
      libraryContextMenuItem('delete', '휴지통으로 이동', 'trash2', { danger: true }),
    ].join('')
  } else if (folder) {
    menu.innerHTML = [
      libraryContextMenuItem('open-folder', '폴더 열기', 'folder'),
      '<div class="library-context-menu-separator" role="separator"></div>',
      libraryContextMenuItem('rename-folder', '이름 변경', 'edit3'),
      libraryContextMenuItem('color-folder', '폴더 색상', 'edit3'),
      libraryContextMenuItem('delete-folder', '폴더 삭제', 'trash2', { danger: true }),
    ].join('')
  } else if (state.currentLibraryTab === 'trash') {
    menu.innerHTML = libraryContextMenuItem('empty-trash', '휴지통 비우기', 'trash2', { danger: true })
  } else {
    menu.innerHTML = [
      libraryContextMenuItem('add-paper', '논문 추가', 'fileText'),
      libraryContextMenuItem('add-folder', '폴더 추가', 'folder'),
      '<div class="library-context-menu-separator" role="separator"></div>',
      libraryContextMenuItem('select-all', '전체 선택', 'checkCircle'),
    ].join('')
  }

  document.body.appendChild(menu)
  libraryContextMenu = menu
  positionLibraryContextMenu(menu, event.clientX, event.clientY)
  menu.querySelector('[role="menuitem"]')?.focus()

  menu.addEventListener('click', async clickEvent => {
    const action = clickEvent.target.closest('[data-action]')?.dataset.action
    if (!action) return
    closeLibraryContextMenu()
    try {
      if (action === 'open') await openFromLibrary(doc)
      else if (action === 'details') openLibraryDetailPanel(doc)
      else if (action === 'select') toggleDocSelection(doc.id)
      else if (action === 'read') {
        const nextRead = doc.metadata?.read !== true
        await updateLibraryDocMetadata(doc.id, { read: nextRead, read_at: nextRead ? new Date().toISOString() : null })
        await renderLibrary()
      } else if (action === 'favorite') {
        toggleFavoriteDoc(doc.id)
        await renderLibrary()
      } else if (action === 'clear-cache') await clearDocCacheFromContextMenu(doc)
      else if (action === 'delete') await deleteDocFromContextMenu(doc)
      else if (action === 'restore') {
        await restoreLibraryDoc(doc.id)
        showToast('논문을 복원했습니다.', 'success')
        await renderLibrary()
      } else if (action === 'permanent-delete') {
        const ok = await showCustomConfirm('이 논문을 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.', { title: '논문 영구 삭제', confirmText: '영구 삭제', danger: true })
        if (ok) {
          await deleteLibraryDocPermanently(doc.id)
          await renderLibrary()
        }
      } else if (action === 'open-folder') navigateLibraryFolder(folder.id)
      else if (action === 'rename-folder') await requestRenameFolder(folder)
      else if (action === 'color-folder') {
        const color = await showFolderColorDialog(folder.color)
        if (color && color !== folder.color) {
          await updateFolderWithUndo(folder, { color })
          await renderLibrary()
        }
      } else if (action === 'delete-folder') await requestDeleteFolder(folder)
      else if (action === 'add-paper') fileInput.click()
      else if (action === 'add-folder') await openCreateFolderDialog()
      else if (action === 'select-all') {
        const visibleIds = getVisibleDocIds()
        visibleIds.forEach(id => selectedDocIds.add(id))
        visibleIds.forEach(id => updateDocCardSelectionVisuals(id))
        updateSelectToolbarUI()
      } else if (action === 'empty-trash') $('lib-empty-trash-btn')?.click()
    } catch (err) {
      showToast(err.message || '작업에 실패했습니다.', 'error')
    }
  })
}

function initLibraryContextMenu() {
  const surface = $('page-outlet')
  if (!surface) return
  surface.addEventListener('contextmenu', event => {
    if (state.currentWorkspacePage !== 'library') return
    const docElement = event.target.closest('.doc-card[data-id], .doc-list-row[data-id]')
    const folderElement = event.target.closest('.library-folder-card[data-folder-id]')
    const isLibraryArea = event.target === surface || event.target.closest('#page-library')
    if (!docElement && !folderElement && (!isLibraryArea || event.target.closest('input, textarea, select'))) return

    const doc = docElement ? currentLibraryDocs.find(item => item.id === docElement.dataset.id) : null
    const folder = folderElement ? libraryFolders.find(item => item.id === folderElement.dataset.folderId) : null
    event.preventDefault()
    showLibraryContextMenu(event, { doc, folder })
  })
  document.addEventListener('pointerdown', event => {
    if (libraryContextMenu && !event.target.closest('.library-context-menu')) closeLibraryContextMenu()
    if (!event.target.closest('.folder-card-menu, .folder-card-actions')) closeFolderCardMenus()
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeLibraryContextMenu()
      closeFolderCardMenus()
    }
  })
  surface.addEventListener('scroll', closeLibraryContextMenu)
  document.addEventListener('scroll', closeFolderCardMenus, true)
  window.addEventListener('resize', closeLibraryContextMenu)
  window.addEventListener('resize', closeFolderCardMenus)
}

initLibraryContextMenu()

function ensureLibraryFolderUI() {
  if ($('library-breadcrumb')) return
  librarySearchBox?.insertAdjacentHTML('beforebegin', `<div class="library-folder-header"><nav id="library-breadcrumb" class="library-breadcrumb" aria-label="폴더 경로"></nav></div>`)
}
let libraryChromeReady = false
function ensureLibraryChrome() {
  if (libraryChromeReady) return
  libraryChromeReady = true

  libraryCategoryFilterToggle?.addEventListener('click', () => {
    libraryCategoryFiltersCollapsed = !libraryCategoryFiltersCollapsed
    localStorage.setItem(LIBRARY_FILTERS_COLLAPSED_KEY, String(libraryCategoryFiltersCollapsed))
    updateLibraryCategoryFilterVisibility()
  })

  if (librarySearchBox && !$('library-status-tabs')) {
    librarySearchBox.insertAdjacentHTML('beforebegin', `
      <div class="library-toolbar-row">
        <div id="library-status-tabs" class="lib-status-tabs"></div>
      </div>
    `)
  }

  const viewToggleEl = $('library-view-toggle')
  if (viewToggleEl && !$('library-sort-select')) {
    viewToggleEl.insertAdjacentHTML('beforebegin', `
      <div class="lib-sort-dropdown">
        <select id="library-sort-select" class="lib-sort-select" title="정렬 기준">
          <option value="recent">최근 추가순</option>
          <option value="last-read">최근 읽은 순</option>
          <option value="title">제목순</option>
          <option value="progress">번역 진행률순</option>
        </select>
        <span class="lib-sort-dropdown-icon">${icon('chevronDown', 12)}</span>
      </div>
    `)
    const sortSelect = $('library-sort-select')
    if (sortSelect) {
      sortSelect.value = librarySortMode
      sortSelect.addEventListener('change', () => {
        librarySortMode = sortSelect.value
        localStorage.setItem('easypaper_library_sort', librarySortMode)
        filterLibraryCards(currentLibraryDocs)
      })
    }
  }

  ensureLibraryDetailPanel()
}

async function renderLibrary() {
  // Library 페이지의 새 UI 조각(상태 탭/정렬 드롭다운/상세 패널)이 아직 없으면 삽입한다.
  ensureLibraryChrome()
  ensureLibraryFolderUI()
  closeLibraryDetailPanel()
  // 상세 패널의 "관련 자료" 탭이 쓰는 지식 그래프 캐시도 목록을 새로 불러올 때 함께 무효화한다.
  libraryGraphCacheForDetail = null

  // 탭 전환 등으로 목록을 새로 불러올 때는 검색 상태를 초기화한다 - 검색
  // 결과가 다른 탭의 목록과 뒤섞여 보이는 것을 방지
  if (librarySearchInput) librarySearchInput.value = ''
  if (librarySearchClearBtn) librarySearchClearBtn.classList.add('hidden')
  if (librarySearchStatus) librarySearchStatus.classList.add('hidden')
  // #library-filter-row의 display:flex는 CSS 클래스가 아닌 인라인 스타일로만
  // 선언되어 있어서, ''로 지우면(인라인 속성 제거) flex가 아니라 div의 기본값인
  // block으로 되돌아가 카테고리 태그/보기 전환 버튼이 옆으로 나란히 배치되지
  // 못하고 세로로 붙어버린다. 반드시 'flex'로 명시적으로 되돌려야 한다.
  if (libraryFilterRow) libraryFilterRow.style.display = 'flex'
  isLibrarySearchActive = false

  libraryGrid.innerHTML = ''
  libraryCategoryFilters.innerHTML = ''
  updateLibraryCategoryFilterVisibility(false)
  try {
    let data
    if (state.currentLibraryTab === 'trash') {
      data = await fetchLibraryTrash({ ...getTranslationOptions(workspaceModeController.getMode()), documentMode: workspaceModeController.getMode() })
    } else {
      data = await fetchLibrary({ ...getTranslationOptions(workspaceModeController.getMode()), documentMode: workspaceModeController.getMode() })
    }
    const allDocs = data.documents || []
    if (state.currentLibraryTab !== 'trash') {
      const foldersData = await fetchLibraryFolders()
      libraryFolders = foldersData.folders || []
      if (activeLibraryFolderId && !libraryFolders.some(f => f.id === activeLibraryFolderId)) {
        activeLibraryFolderId = null
        if (history.state?.screen === 'library' && history.state?.page === 'library') {
          history.replaceState({ ...history.state, libraryFolderId: null }, '', location.href)
        }
      }
      renderFolderNavigation(allDocs)
    }

    // 보관함 뱃지에는 안읽은 논문 개수 표시 (휴지통이 아닐 때만 적용하거나, archive 기준 개수 표시)
    updateUnreadBadge(allDocs)

    // 휴지통 탭 노출 여부/배지도 여기서 함께 최신화한다 - 문서 하나를
    // 조작한 뒤(읽음 표시/삭제/복원 등) 호출부가 매번 loadLibraryCount()를
    // 별도로 또 호출해 GET /api/library(+trash)를 중복으로 쏘지 않도록.
    // 지금 보고 있는 탭이 마침 휴지통이면 이미 받아온 목록을 그대로 쓰고,
    // 아니면 화면 갱신을 막지 않게 백그라운드로 별도 조회한다.
    if (state.currentLibraryTab === 'trash') {
      updateTrashTabVisibility(allDocs)
    } else {
      refreshTrashTabVisibility()
    }

    // data는 위에서 이미 currentLibraryTab(archive: 전체 / trash: 휴지통)에 맞춰 조회됨
    const docs = allDocs

    // 상태 필터 탭(전체/읽지 않음/읽는 중/완료/즐겨찾기)은 카드가 하나도 없어도
    // 항상 최신 개수로 갱신한다(휴지통 탭에서는 renderLibraryStatusTabs 내부에서 숨김).
    renderLibraryStatusTabs(docs)

    if (docs.length === 0) {
      libraryGrid.appendChild(createEmptyState(state.currentLibraryTab === 'trash' ? 'trash' : 'library')); return
    }

    // 연구 모드는 기존 학술 카테고리, 일반 모드는 문서 종류를 필터로 쓴다.
    const isGeneralLibrary = workspaceModeController.getMode() === 'general'
    let filterDefs
    if (isGeneralLibrary) {
      const types = Array.from(new Set(docs.map(doc => doc.document_type || 'other'))).sort()
      filterDefs = types.map(type => ({
        value: `type:${type}`,
        label: workspaceModeController.getTypeLabel('general', type),
        count: docs.filter(doc => (doc.document_type || 'other') === type).length,
      }))
    } else {
      const categoriesSet = new Set()
      docs.forEach(doc => (doc.metadata?.categories || []).forEach(cat => categoriesSet.add(cat.trim())))
      filterDefs = Array.from(categoriesSet).sort().map(category => ({
        value: category,
        label: category,
        count: docs.filter(doc => (doc.metadata?.categories || []).includes(category)).length,
      }))
    }

    if (activeCategoryFilter !== 'ALL' && !filterDefs.some(item => item.value === activeCategoryFilter)) {
      activeCategoryFilter = 'ALL'
    }
    if (filterDefs.length > 0) {
      const allBtn = document.createElement('button')
      allBtn.className = `category-filter-btn ${activeCategoryFilter === 'ALL' ? 'active' : ''}`
      allBtn.dataset.category = 'ALL'
      allBtn.innerHTML = `${icon('book', 13, 'style="vertical-align:-2px;margin-right:3px"')}전체 (${docs.length})`
      allBtn.addEventListener('click', () => {
        activeCategoryFilter = 'ALL'
        filterLibraryCards(docs)
      })
      libraryCategoryFilters.appendChild(allBtn)

      filterDefs.forEach(item => {
        const btn = document.createElement('button')
        btn.className = `category-filter-btn ${activeCategoryFilter === item.value ? 'active' : ''}`
        btn.dataset.category = item.value
        btn.innerHTML = `${icon(isGeneralLibrary ? 'fileText' : 'tag', 13, 'style="vertical-align:-2px;margin-right:3px"')}${escapeHtml(item.label)} (${item.count})`
        btn.addEventListener('click', () => {
          activeCategoryFilter = item.value
          filterLibraryCards(docs)
        })
        libraryCategoryFilters.appendChild(btn)
      })
    }
    updateLibraryCategoryFilterVisibility(filterDefs.length > 0)

    // Initial card rendering
    filterLibraryCards(docs)
  } catch (err) {
    console.error(err)
    libraryGrid.innerHTML = `<div class="lib-empty"><p style="color:var(--error)">라이브러리 불러오기 실패</p></div>`
  }
}

// AI Chats/Notes 페이지(pages/aiChatsPage.js, pages/notesPage.js)와 Library 상세 패널이
// 공유해서 쓰는 시간 포맷 헬퍼. 예전에는 이 근처에 라이브러리 탭용 채팅/주석 목록
// 렌더링 함수들이 있었지만 각 페이지 전용 모듈로 옮겨졌다.
function formatChatSessionTime(isoString) {
  if (!isoString) return ''
  return new Date(isoString).toLocaleString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── 주석 조회 (메모 / 하이라이트 / 언더라인 목록) ───────────────────────
// 메모와 하이라이트/언더라인은 서버 DB가 아니라 문서(세션)별 localStorage에만
// 저장되므로(easypaper_memos_*, easypaper_annotations_*), 라이브러리 전체
// 문서 목록을 한 번 불러온 뒤 각 문서의 localStorage를 순회해 모아 보여준다.
// Notes 페이지(pages/notesPage.js)와 Library 상세 패널/Research Graph 노드 상세 패널이
// 공유해서 쓰는 텍스트 축약 헬퍼. 예전에는 이 근처에 라이브러리 탭용 주석 브라우저
// 렌더링 함수가 있었지만 Notes 전용 페이지 모듈로 옮겨졌다.
function truncateForList(text, maxLen) {
  if (!text) return ''
  const trimmed = text.trim()
  return trimmed.length > maxLen ? trimmed.substring(0, maxLen) + '...' : trimmed
}

// 지식 그래프 탭: Cytoscape 인스턴스는 탭을 재방문할 때마다 새로 만들면
// 이전 인스턴스가 DOM/이벤트 리스너를 계속 붙들고 있으므로 반드시 destroy 후 재생성한다.
let libraryGraphCyInstance = null
let libraryGraphPollTimeout = null

// 그래프 탭 안의 "그래프/히트맵" 서브뷰 전환. 완전히 새 최상위 탭을 만드는
// 대신 같은 섹션 안에서 뷰만 바꾼다(기획서의 "Research Dashboard"가 이
// 뷰들을 한 화면의 다른 뷰로 묶어 다루는 것과 일치). 표 기반으로 짜서
// 서브뷰가 늘어나도 분기를 추가하지 않고 항목만 추가하면 된다.
const GRAPH_SUBVIEWS = {
  graph:     { btn: () => libraryGraphViewToggleGraph,     el: () => libraryGraphView },
  heatmap:   { btn: () => libraryGraphViewToggleHeatmap,   el: () => libraryHeatmapView,   onShow: () => renderLibraryHeatmapView() },
}

function switchGraphSubView(view) {
  for (const [key, cfg] of Object.entries(GRAPH_SUBVIEWS)) {
    const btn = cfg.btn()
    const el = cfg.el()
    if (btn) btn.classList.toggle('active', key === view)
    if (el) el.classList.toggle('hidden', key !== view)
  }
  if (libraryGraphPendingBanner && view !== 'graph') libraryGraphPendingBanner.classList.add('hidden')
  const cfg = GRAPH_SUBVIEWS[view]
  if (cfg && cfg.onShow) cfg.onShow()
}

for (const [view, cfg] of Object.entries(GRAPH_SUBVIEWS)) {
  const btn = cfg.btn()
  if (btn) btn.addEventListener('click', () => switchGraphSubView(view))
}

// 개념 히트맵: 논문(행) x 개념(열) 2D 매트릭스(seaborn류 히트맵 참고). 셀 값은
// 서버가 논문 텍스트를 근거로 LLM으로 직접 채점한 0.0~1.0 관련도 점수라(하루
// 단위로 캐싱됨) 이미 그 자체로 비교 가능한 절대 스케일이다 - 과거의
// "등장 여부+질문 수" 근사치와 달리 행/열/전체 기준으로 다시 정규화하면 오히려
// 절대값의 의미를 왜곡하므로, 점수를 그대로 색 진하기(accent 색 sequential
// 램프, color-mix가 --control-accent 기준이라 테마/다크모드에 자동으로
// 맞춰짐)와 셀 텍스트에 쓴다.
function renderHeatmapMatrix(data) {
  const { concepts, papers, cells } = data
  const cellByKey = {}
  for (const c of cells) cellByKey[`${c.doc_id}:${c.concept_id}`] = c

  const headerCells = concepts.map(c => `<th class="rg-heatmap-col-head"><span>${escapeHtml(c.name)}</span></th>`).join('')
  const bodyRows = papers.map(p => {
    const rowCells = concepts.map(c => {
      const cell = cellByKey[`${p.doc_id}:${c.concept_id}`]
      const val = cell ? cell.score : 0
      const pct = Math.round(val * 100)
      const detail = cell
        ? `${escapeHtml(p.title)} · ${escapeHtml(c.name)} · 관련도 ${val.toFixed(2)} · ${cell.present ? '개념 등장' : '개념 미등장'} · 관련 질문 ${cell.question_count}개`
        : `${escapeHtml(p.title)} · ${escapeHtml(c.name)} · 연관 없음`
      return `<td class="rg-heatmap-cell${val >= 0.55 ? ' rg-heatmap-cell-dark' : ''}" style="background:color-mix(in srgb, var(--control-accent) ${pct}%, var(--bg-elevated))" title="${detail}">${val.toFixed(2)}</td>`
    }).join('')
    return `
      <tr>
        <th class="rg-heatmap-row-head" data-doc-id="${escapeHtml(p.doc_id)}" title="클릭하면 이 논문을 엽니다">
          <span class="rg-heatmap-row-title">${escapeHtml(truncateForList(p.title, 28))}</span>
          ${p.category ? `<span class="rg-heatmap-row-tag">${escapeHtml(p.category)}</span>` : ''}
        </th>
        ${rowCells}
      </tr>
    `
  }).join('')

  return `
    <div class="rg-heatmap">
      <div class="rg-heatmap-toolbar">
        <div class="rg-heatmap-heading">
          <h4>개념 히트맵</h4>
          <p>선택된 논문의 본문을 AI가 읽고, 각 개념을 얼마나 깊이 다루는지 0~1 관련도로 채점한 값입니다.</p>
        </div>
        <button type="button" id="rg-heatmap-refresh-btn" class="rg-refresh-btn">${icon('refreshCw', 13)}<span>다시 계산</span></button>
      </div>
      <div class="rg-heatmap-body">
        <div class="rg-heatmap-main">
          <div class="rg-heatmap-legend">
            <span>낮음</span>
            <div class="rg-heatmap-legend-bar"></div>
            <span>높음</span>
          </div>
          <div class="rg-heatmap-scroll">
            <table class="rg-heatmap-table">
              <thead><tr><th class="rg-heatmap-corner"></th>${headerCells}</tr></thead>
              <tbody>${bodyRows}</tbody>
            </table>
          </div>
          <p class="rg-heatmap-caption">${papers.length}개 논문 × ${concepts.length}개 개념 · 칸에 마우스를 올리면 자세한 값을 볼 수 있습니다.</p>
        </div>
        <div class="rg-heatmap-side">
          <h4>표시 중인 개념 (${concepts.length})</h4>
          <div class="rg-heatmap-concept-chips">
            ${concepts.map(c => `<span class="rg-heatmap-chip">${escapeHtml(c.name)}</span>`).join('')}
          </div>
          <h4>표시 중인 논문 (${papers.length})</h4>
          <ul class="rg-heatmap-paper-list">
            ${papers.map(p => `<li data-doc-id="${escapeHtml(p.doc_id)}" title="클릭하면 이 논문을 엽니다">${escapeHtml(truncateForList(p.title, 40))}</li>`).join('')}
          </ul>
        </div>
      </div>
    </div>
  `
}

// force=true는 "다시 계산" 버튼용 - 서버 캐시(하루 단위)를 무시하고 LLM을
// 다시 호출하므로, 첫 로드보다 오래 걸릴 수 있다는 걸 로딩 문구로 알려준다.
async function renderLibraryHeatmapView(force = false) {
  if (!libraryHeatmapList) return
  libraryHeatmapList.innerHTML = force
    ? '<div class="lib-empty"><p>AI가 논문을 다시 읽고 채점하는 중입니다... (다소 시간이 걸릴 수 있어요)</p></div>'
    : '<div class="lib-empty"><p>불러오는 중...</p></div>'
  try {
    const data = await fetchLibraryHeatmapMatrix({ force })
    if (state.currentWorkspacePage !== 'graph') return
    if (!data.concepts?.length || !data.papers?.length) {
      libraryHeatmapList.innerHTML = '<div class="lib-empty"><p>아직 히트맵을 그릴 만큼 개념/논문 데이터가 쌓이지 않았습니다.</p></div>'
      return
    }
    libraryHeatmapList.innerHTML = renderHeatmapMatrix(data)
  } catch (err) {
    console.error('개념 히트맵 로드 실패:', err)
    libraryHeatmapList.innerHTML = '<div class="lib-empty"><p style="color:var(--error)">히트맵을 불러오지 못했습니다</p></div>'
  }
}

// "다시 계산" 버튼과 행 헤더/사이드 패널의 논문 클릭은 매번 innerHTML로 새로
// 그려지는 요소라, 항목마다 리스너를 다는 대신 컨테이너에 위임 리스너를
// 한 번만 건다.
if (libraryHeatmapList) {
  libraryHeatmapList.addEventListener('click', async (event) => {
    if (event.target.closest('#rg-heatmap-refresh-btn')) {
      renderLibraryHeatmapView(true)
      return
    }
    const target = event.target.closest('[data-doc-id]')
    const docId = target?.dataset.docId
    if (!docId) return
    try {
      const doc = await fetchLibraryDoc(docId)
      await openFromLibrary(doc)
    } catch (err) {
      console.error('히트맵에서 논문 열기 실패:', err)
      showToast('논문을 불러오지 못했습니다.', 'error')
    }
  })
}

// ============================================================
// Research Graph 페이지 재설계 - 노드 타입 메타(범례/상세 패널 공용)
// 색상은 knowledgeGraph.js의 cytoscape 스타일(off-limits, 직접 수정하지
// 않음)과 반드시 같은 값을 유지해야 하므로 그쪽 파일이 바뀌면 여기도
// 맞춰 갱신해야 한다.
// ============================================================
const GRAPH_NODE_TYPE_META = {
  paper:   { label: '논문',          color: '#4f8ef7', icon: 'fileText' },
  concept: { label: '개념',          color: '#f7b34f', icon: 'lightbulb' },
  note:    { label: '메모',          color: '#8b5cf6', icon: 'edit3' },
  figure:  { label: 'Figure/Table',  color: '#10b981', icon: 'image' },
  tag:     { label: '연구 태그',       color: '#ec4899', icon: 'tag' },
}

const RG_ZOOM_IN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
const RG_ZOOM_OUT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>'
const RG_MORE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>'

// 왼쪽 "노드 타입" 범례 + "Graph Overview" 통계 카드. 전부 fetchLibraryGraph()가
// 이미 내려준 nodes/edges 배열을 클라이언트에서 집계한 값이다 - 별도 API 호출이나
// 데이터 모델 변경 없음. "Clusters"는 mockup처럼 별도 클러스터링 알고리즘이 있는
// 게 아니라, 논문끼리 공유 태그로 연결된(category 엣지) 서로 다른 태그 수를
// 쓴다 - "2편 이상의 논문이 실제로 공유하는 주제"라는 점에서 정직한 근사치.
// "업데이트"는 서버가 그래프를 마지막으로 재계산한 시각이 아니라(그런 타임스탬프가
// 없음), 지금 이 화면이 데이터를 마지막으로 불러온 시각이다 - 그렇게 라벨을 붙여
// 오해가 없게 한다.
let rgGraphLoadedAt = null
function relativeTimeShortKo(date) {
  if (!date) return ''
  const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (diffSec < 60) return '방금 전'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}분 전`
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return `${diffHour}시간 전`
  return `${Math.round(diffHour / 24)}일 전`
}

function renderGraphLegend(nodes, edges) {
  const legendEl = $('rg-legend-panel')
  if (!legendEl) return
  const counts = { paper: 0, concept: 0, note: 0, figure: 0, tag: 0 }
  for (const n of nodes || []) {
    if (counts[n.type] !== undefined) counts[n.type]++
  }
  const connectionCount = (edges || []).length
  const clusterTags = new Set()
  for (const e of edges || []) {
    if (e.type === 'category' && e.category) clusterTags.add(e.category)
  }

  legendEl.innerHTML = `
    <div class="rg-legend-card">
      <h4 class="rg-legend-title">노드 타입</h4>
      <ul class="rg-legend-list">
        ${Object.entries(GRAPH_NODE_TYPE_META).map(([type, meta]) => `
          <li class="rg-legend-item">
            <span class="rg-legend-dot" style="background:${meta.color}"></span>
            <span class="rg-legend-label">${escapeHtml(meta.label)}</span>
            <span class="rg-legend-count">${counts[type] || 0}</span>
          </li>
        `).join('')}
      </ul>
    </div>
    <div class="rg-overview-card">
      <h4 class="rg-legend-title">Graph Overview</h4>
      <ul class="rg-overview-list">
        <li class="rg-overview-row"><span>${icon('fileText', 13)}Papers</span><b>${counts.paper}</b></li>
        <li class="rg-overview-row"><span>${icon('network', 13)}Connections</span><b>${connectionCount}</b></li>
        <li class="rg-overview-row"><span>${icon('layers', 13)}Clusters</span><b>${clusterTags.size}</b></li>
        <li class="rg-overview-row"><span>${icon('clock', 13)}Updated</span><b id="rg-overview-updated">${escapeHtml(relativeTimeShortKo(rgGraphLoadedAt))}</b></li>
      </ul>
      <button type="button" id="rg-refresh-btn" class="rg-refresh-btn">${icon('refreshCw', 13)}<span>Refresh Graph</span></button>
    </div>
  `
  const refreshBtn = $('rg-refresh-btn')
  if (refreshBtn) refreshBtn.addEventListener('click', () => renderLibraryGraphTab())
}

// 그래프 탭의 DOM 뼈대(범례/툴바/캔버스 래퍼/줌 컨트롤)를 한 번만 구성한다.
// index.html은 건드리지 않는다는 제약 때문에, 기존 요소(id 보유 - 검색창/
// 추천 버튼/상세 패널/캔버스 등)는 그대로 재사용하고 위치와 스타일만
// 재배치한다. library-graph-row는 리사이저(showLibraryScreen 근처 초기화
// 코드, off-limits)가 rowRect.right 기준으로 상세 패널 폭을 계산하므로
// display:flex 구조를 그대로 유지해야 한다 - 왼쪽에 범례를 끼워 넣는 것은
// 그 계산에 영향을 주지 않는다.
let cachedGraphRecommendations = null
let isGraphRecommendationsExpanded = false

function renderGraphRecItemsHtml(recommendations) {
  if (!recommendations || recommendations.length === 0) {
    return `<p class="rg-recommend-status">추천할 만한 논문을 찾지 못했습니다.</p>`
  }
  return recommendations.map(r => `
    <div class="rg-recommend-item">
      <a href="${escapeHtml(r.url || '#')}" target="_blank" rel="noopener noreferrer" class="rg-recommend-item-title">${escapeHtml(r.title || '')}</a>
      ${r.reason ? `<div class="rg-recommend-item-reason">${escapeHtml(r.reason)}</div>` : ''}
    </div>
  `).join('')
}

function updateGraphRecommendationsUI() {
  if (!libraryRecommendationsBtn) return
  const refreshBtn = $('rg-recommend-refresh-btn')
  const hasCached = Array.isArray(cachedGraphRecommendations) && cachedGraphRecommendations.length > 0

  if (hasCached) {
    if (refreshBtn) refreshBtn.classList.remove('hidden')
    const count = cachedGraphRecommendations.length
    const chevronIcon = isGraphRecommendationsExpanded ? icon('chevronUp', 13) : icon('chevronDown', 13)
    libraryRecommendationsBtn.innerHTML = `${icon('sparkles', 13)}<span>AI 추천 논문 (${count}개)</span>${chevronIcon}`
    libraryRecommendationsBtn.title = isGraphRecommendationsExpanded ? '클릭하여 접기' : '클릭하여 추천 논문 펼치기'

    if (libraryRecommendationsList) {
      if (isGraphRecommendationsExpanded) {
        libraryRecommendationsList.innerHTML = renderGraphRecItemsHtml(cachedGraphRecommendations)
        libraryRecommendationsList.classList.remove('hidden')
      } else {
        libraryRecommendationsList.classList.add('hidden')
      }
    }
  } else {
    if (refreshBtn) refreshBtn.classList.add('hidden')
    libraryRecommendationsBtn.innerHTML = `${icon('zap', 13)}<span>다음에 읽을 논문 추천받기</span>`
    libraryRecommendationsBtn.title = '다음에 읽을 논문 추천받기'
    if (libraryRecommendationsList) {
      if (!isGraphRecommendationsExpanded && (!libraryRecommendationsList.innerHTML || libraryRecommendationsList.children.length === 0)) {
        libraryRecommendationsList.classList.add('hidden')
      }
    }
  }
}

async function loadCachedGraphRecommendations() {
  try {
    const res = await fetchCachedReadingRecommendations()
    if (res && Array.isArray(res.recommendations) && res.recommendations.length > 0) {
      cachedGraphRecommendations = res.recommendations
      isGraphRecommendationsExpanded = false
    } else {
      cachedGraphRecommendations = null
    }
  } catch (err) {
    console.error('추천 논문 캐시 조회 실패:', err)
    cachedGraphRecommendations = null
  }
  updateGraphRecommendationsUI()
}

async function runGraphRecommendationsFetch({ force = false } = {}) {
  if (!libraryRecommendationsBtn || !libraryRecommendationsList) return
  const refreshBtn = $('rg-recommend-refresh-btn')

  libraryRecommendationsBtn.disabled = true
  if (refreshBtn) refreshBtn.disabled = true

  isGraphRecommendationsExpanded = true
  libraryRecommendationsList.classList.remove('hidden')
  const statusText = force ? '추천 논문을 다시 찾는 중... (시간이 걸릴 수 있습니다)' : '추천 논문을 찾는 중... (시간이 걸릴 수 있습니다)'
  libraryRecommendationsList.innerHTML = `<p class="rg-recommend-status">${statusText}</p>`

  try {
    const { recommendations } = await fetchReadingRecommendations({ force })
    if (!recommendations || recommendations.length === 0) {
      libraryRecommendationsList.innerHTML = `<p class="rg-recommend-status">추천할 만한 논문을 찾지 못했습니다.</p>`
      cachedGraphRecommendations = null
    } else {
      cachedGraphRecommendations = recommendations
      libraryRecommendationsList.innerHTML = renderGraphRecItemsHtml(recommendations)
    }
  } catch (err) {
    console.error('추천 논문 조회 실패:', err)
    libraryRecommendationsList.innerHTML = `<p class="rg-recommend-status rg-recommend-error">추천 논문을 불러오지 못했습니다.</p>`
  } finally {
    libraryRecommendationsBtn.disabled = false
    if (refreshBtn) refreshBtn.disabled = false
    updateGraphRecommendationsUI()
  }
}

let graphLayoutReady = false
function ensureGraphLayout() {
  if (graphLayoutReady) return
  if (!libraryGraphView || !libraryGraphRow || !libraryGraphCanvas || !libraryGraphDetailPanel || !libraryGraphSearchInput) return
  graphLayoutReady = true

  // 상단 그래프/히트맵 토글에 아이콘을 붙인다.
  ;[[libraryGraphViewToggleGraph, 'network'], [libraryGraphViewToggleHeatmap, 'grid']].forEach(([btn, iconName]) => {
    if (btn) btn.innerHTML = `${icon(iconName, 13)}<span>${btn.textContent}</span>`
  })
  const tabsRow = libraryGraphViewToggleGraph?.parentElement
  if (tabsRow) tabsRow.classList.add('rg-view-tabs')

  // 기존 추천 박스(안내 문구용 테두리 박스)를 해체하고, 그 안의 버튼/목록
  // (id 보유, 리스너가 이미 달려 있음)만 새 툴바로 옮긴다.
  const recoWrapEl = libraryRecommendationsBtn ? libraryRecommendationsBtn.parentElement : null

  // 검색창 자리에 툴바를 만들고 검색창을 그 안으로 옮긴다.
  const toolbar = document.createElement('div')
  toolbar.className = 'rg-toolbar'
  libraryGraphSearchInput.parentElement.insertBefore(toolbar, libraryGraphSearchInput)
  libraryGraphSearchInput.removeAttribute('style')
  libraryGraphSearchInput.classList.add('rg-search-input')
  const searchWrap = document.createElement('div')
  searchWrap.className = 'rg-search-wrap'
  searchWrap.innerHTML = icon('search', 15)
  searchWrap.appendChild(libraryGraphSearchInput)
  toolbar.appendChild(searchWrap)

  const typeSelect = document.createElement('select')
  typeSelect.id = 'rg-filter-type'
  typeSelect.className = 'rg-filter-select'
  typeSelect.innerHTML = `<option value="all">모든 타입</option>` +
    Object.entries(GRAPH_NODE_TYPE_META).map(([t, m]) => `<option value="${t}">${escapeHtml(m.label)}</option>`).join('')
  toolbar.appendChild(typeSelect)

  const tagSelect = document.createElement('select')
  tagSelect.id = 'rg-filter-tag'
  tagSelect.className = 'rg-filter-select'
  tagSelect.innerHTML = `<option value="all">모든 태그</option>`
  toolbar.appendChild(tagSelect)

  const toolbarRight = document.createElement('div')
  toolbarRight.className = 'rg-toolbar-right'
  toolbar.appendChild(toolbarRight)
  if (libraryRecommendationsBtn) {
    libraryRecommendationsBtn.removeAttribute('style')
    libraryRecommendationsBtn.className = 'rg-recommend-btn'
    libraryRecommendationsBtn.innerHTML = `${icon('zap', 13)}<span>다음에 읽을 논문 추천받기</span>`
    toolbarRight.appendChild(libraryRecommendationsBtn)

    let refreshRecoBtn = $('rg-recommend-refresh-btn')
    if (!refreshRecoBtn) {
      refreshRecoBtn = document.createElement('button')
      refreshRecoBtn.id = 'rg-recommend-refresh-btn'
      refreshRecoBtn.type = 'button'
      refreshRecoBtn.className = 'rg-recommend-refresh-btn hidden'
      refreshRecoBtn.title = '새로운 추천을 다시 받아옵니다'
      refreshRecoBtn.innerHTML = `${icon('refreshCw', 12)}<span>다시받기</span>`
      refreshRecoBtn.addEventListener('click', () => runGraphRecommendationsFetch({ force: true }))
      toolbarRight.appendChild(refreshRecoBtn)
    }
  }

  const recoPanel = document.createElement('div')
  recoPanel.className = 'rg-recommend-panel'
  if (libraryRecommendationsList) {
    libraryRecommendationsList.removeAttribute('style')
    recoPanel.appendChild(libraryRecommendationsList)
  }
  toolbar.insertAdjacentElement('afterend', recoPanel)
  if (recoWrapEl && recoWrapEl.parentElement) recoWrapEl.remove()

  typeSelect.addEventListener('change', applyGraphFilters)
  tagSelect.addEventListener('change', applyGraphFilters)

  // 3열 레이아웃: 범례(신규) / 캔버스 래퍼(신규, 기존 canvas를 감쌈) / 상세
  // 패널(기존 요소 재사용). library-graph-row의 flex 자식 순서만 바뀐다.
  const legendPanel = document.createElement('div')
  legendPanel.id = 'rg-legend-panel'
  legendPanel.className = 'rg-legend-col'
  libraryGraphRow.insertBefore(legendPanel, libraryGraphCanvas)

  const canvasWrap = document.createElement('div')
  canvasWrap.className = 'rg-canvas-wrap'
  libraryGraphRow.insertBefore(canvasWrap, libraryGraphCanvas)
  libraryGraphCanvas.removeAttribute('style')
  libraryGraphCanvas.classList.add('rg-canvas')
  canvasWrap.appendChild(libraryGraphCanvas)

  const zoomControls = document.createElement('div')
  zoomControls.className = 'rg-zoom-controls'
  zoomControls.innerHTML = `
    <button type="button" id="rg-zoom-in-btn" class="rg-zoom-btn" title="확대">${RG_ZOOM_IN_SVG}</button>
    <button type="button" id="rg-zoom-out-btn" class="rg-zoom-btn" title="축소">${RG_ZOOM_OUT_SVG}</button>
    <button type="button" id="rg-zoom-fit-btn" class="rg-zoom-btn" title="화면에 맞추기">${icon('expand', 14)}</button>
    <button type="button" id="rg-relayout-btn" class="rg-zoom-btn" title="다시 정렬">${icon('refreshCw', 14)}</button>
  `
  canvasWrap.appendChild(zoomControls)
  $('rg-zoom-in-btn').addEventListener('click', () => { if (libraryGraphCyInstance) libraryGraphCyInstance.zoom(libraryGraphCyInstance.zoom() * 1.25) })
  $('rg-zoom-out-btn').addEventListener('click', () => { if (libraryGraphCyInstance) libraryGraphCyInstance.zoom(libraryGraphCyInstance.zoom() / 1.25) })
  $('rg-zoom-fit-btn').addEventListener('click', () => { if (libraryGraphCyInstance) libraryGraphCyInstance.fit(undefined, 40) })
  $('rg-relayout-btn').addEventListener('click', () => {
    if (libraryGraphCyInstance) libraryGraphCyInstance.layout({ name: 'fcose', quality: 'proof', animate: true }).run()
  })

  const savedWidth = libraryGraphDetailPanel.style.width
  libraryGraphDetailPanel.removeAttribute('style')
  libraryGraphDetailPanel.classList.add('rg-detail-panel')
  libraryGraphDetailPanel.style.width = savedWidth || '300px'

  // 상세 패널 안에서 열리는 "더보기" 드롭다운은 매 클릭마다 innerHTML로
  // 새로 그려지므로(showGraphDetailPanel), 여기서는 위임 방식으로 한 번만
  // 바깥 클릭 시 닫히는 리스너를 건다(lib-detail-more-menu와 동일한 패턴).
  document.addEventListener('click', () => {
    document.querySelectorAll('.rg-detail-more-menu').forEach(m => m.classList.add('hidden'))
  })
}

// 타입/태그 드롭다운을 조합해 cytoscape 노드의 표시 여부를 결정한다.
// 노드/엣지 데이터 자체는 건드리지 않고 화면 표시(style('display', ...))만
// 바꾸므로 "데이터 모델은 그대로" 제약을 지킨다. 태그는 논문 노드의
// categories 필드에만 있으므로, 논문이 아닌 노드는 태그 필터의 영향을
// 받지 않는다(타입 필터로만 걸러진다).
function applyGraphFilters() {
  if (!libraryGraphCyInstance) return
  const typeVal = $('rg-filter-type')?.value || 'all'
  const tagVal = $('rg-filter-tag')?.value || 'all'
  libraryGraphCyInstance.nodes().forEach(n => {
    const data = n.data()
    const typeOk = typeVal === 'all' || data.type === typeVal
    const tagOk = tagVal === 'all' || data.type !== 'paper' || (data.categories || []).includes(tagVal)
    n.style('display', (typeOk && tagOk) ? 'element' : 'none')
  })
}

function renderGraphDetailEmptyState() {
  return `
    <div class="rg-detail-empty-state">
      ${icon('network', 26)}
      <p>노드를 클릭하면 상세 정보가 여기에 표시됩니다.</p>
    </div>
  `
}

function renderGraphDetailHeader(nodeData, titleOverride) {
  const meta = GRAPH_NODE_TYPE_META[nodeData.type] || { label: '노드', color: 'var(--text-tertiary)', icon: 'fileText' }
  return `
    <div class="rg-detail-header">
      <div class="rg-detail-icon" style="background:color-mix(in srgb, ${meta.color} 16%, transparent); color:${meta.color}">${icon(meta.icon, 20)}</div>
      <div class="rg-detail-header-text">
        <h4 class="rg-detail-title">${escapeHtml(titleOverride || nodeData.label || '')}</h4>
        <span class="rg-detail-type-badge" style="color:${meta.color}">${escapeHtml(meta.label)}</span>
      </div>
    </div>
  `
}

// 1촌 이웃 노드를 타입별로 집계한 "연결 관계" 요약. 실제 엣지 타입(인용/
// 카테고리/개념 보유 등)은 knowledgeGraph.js의 tap 핸들러가 이웃 "노드"만
// 넘겨주고 엣지 자체는 넘기지 않아 여기서는 알 수 없다 - 그 파일은 손대지
// 않기로 했으므로, 대신 이웃 노드의 타입(논문/개념/메모/Figure)별 개수로
// 보여준다.
function renderGraphConnectionsSummary(neighborNodes) {
  const counts = { paper: 0, concept: 0, note: 0, figure: 0, tag: 0 }
  for (const n of neighborNodes || []) {
    if (counts[n.type] !== undefined) counts[n.type]++
  }
  const rows = Object.entries(GRAPH_NODE_TYPE_META).filter(([type]) => counts[type] > 0)
  if (rows.length === 0) return `<p class="rg-detail-empty">연결된 노드가 없습니다.</p>`
  return `
    <ul class="rg-connections-list">
      ${rows.map(([type, meta]) => `
        <li class="rg-connections-item">
          <span class="rg-connections-dot" style="background:${meta.color}"></span>
          <span class="rg-connections-label">${escapeHtml(meta.label)}</span>
          <span class="rg-connections-count">${counts[type]}</span>
        </li>
      `).join('')}
    </ul>
  `
}

function renderGraphRelatedNodesList(neighborNodes, emptyText = '관련 노드가 없습니다.', limit = 6) {
  const list = neighborNodes || []
  if (list.length === 0) return `<p class="rg-detail-empty">${escapeHtml(emptyText)}</p>`
  const shown = list.slice(0, limit)
  return `
    <ul class="rg-related-list">
      ${shown.map(n => {
        const meta = GRAPH_NODE_TYPE_META[n.type] || { label: n.type, color: 'var(--text-tertiary)' }
        return `
          <li class="rg-related-item">
            <span class="rg-related-dot" style="background:${meta.color}"></span>
            <span class="rg-related-label">${escapeHtml(n.label || '')}</span>
            <span class="rg-related-type-tag" style="color:${meta.color}">${escapeHtml(meta.label)}</span>
          </li>
        `
      }).join('')}
    </ul>
    ${list.length > limit ? `<p class="rg-related-more">외 ${list.length - limit}개</p>` : ''}
  `
}

// "내 활동" 미니 통계 - 논문 노드 전용. 서버 API를 새로 호출하지 않고,
// 이미 뷰어/메모 기능이 쓰고 있는 로컬 캐시(loadMemos/loadAnnotations)를
// 그대로 읽어 동기적으로 집계한다.
function renderGraphMyActivityStats(docId) {
  let noteCount = 0, highlightCount = 0, underlineCount = 0
  try {
    const memos = loadMemos(docId) || {}
    Object.values(memos).forEach(arr => { noteCount += (arr || []).length })
  } catch { /* 로컬 캐시 파싱 실패는 0건으로 취급 */ }
  try {
    const annotations = loadAnnotations(docId) || {}
    Object.values(annotations).forEach(arr => {
      (arr || []).forEach(a => {
        if (a.type === 'highlight') highlightCount++
        else if (a.type === 'underline') underlineCount++
      })
    })
  } catch { /* 로컬 캐시 파싱 실패는 0건으로 취급 */ }
  return `
    <div class="rg-activity-stats">
      <div class="rg-activity-stat">${icon('edit3', 13)}<span class="rg-activity-stat-value">${noteCount}</span><span class="rg-activity-stat-label">메모</span></div>
      <div class="rg-activity-stat">${icon('highlighter', 13)}<span class="rg-activity-stat-value">${highlightCount}</span><span class="rg-activity-stat-label">하이라이트</span></div>
      <div class="rg-activity-stat">${icon('underline', 13)}<span class="rg-activity-stat-value">${underlineCount}</span><span class="rg-activity-stat-label">언더라인</span></div>
    </div>
  `
}

async function renderLibraryGraphTab() {
  if (libraryGraphPollTimeout) {
    clearTimeout(libraryGraphPollTimeout)
    libraryGraphPollTimeout = null
  }
  if (!libraryGraphCanvas) return
  ensureGraphLayout()
  loadCachedGraphRecommendations()
  if (libraryGraphDetailPanel) {
    libraryGraphDetailPanel.innerHTML = renderGraphDetailEmptyState()
  }
  if (libraryGraphSearchInput) libraryGraphSearchInput.value = ''
  const typeFilterEl = $('rg-filter-type')
  const tagFilterEl = $('rg-filter-tag')
  if (typeFilterEl) typeFilterEl.value = 'all'
  const targetSubView = sessionStorage.getItem('easypaper_graph_subview') || 'graph'
  sessionStorage.removeItem('easypaper_graph_subview')
  switchGraphSubView(targetSubView)

  try {
    const data = await fetchLibraryGraph()
    // 응답을 기다리는 사이 사용자가 다른 탭으로 이동했다면 그리지 않는다.
    if (state.currentWorkspacePage !== 'graph') return

    if (libraryGraphCyInstance) {
      libraryGraphCyInstance.destroy()
      libraryGraphCyInstance = null
    }
    libraryGraphCanvas.innerHTML = ''
    const { renderKnowledgeGraph } = await import('./knowledgeGraph.js')
    libraryGraphCyInstance = renderKnowledgeGraph(libraryGraphCanvas, data, { onNodeClick: showGraphDetailPanel })

    rgGraphLoadedAt = new Date()
    renderGraphLegend(data.nodes, data.edges)

    // Dashboard(개념 히트맵/연구 그래프 미리보기)에서 특정 노드를 보려고 넘어온
    // 경우, sessionStorage로 넘겨받은 노드 id를 실제 클릭과 동일하게 처리한다
    // (cy.trigger('tap')이 renderKnowledgeGraph의 tap 핸들러를 그대로 태워
    // 하이라이트/상세 패널 표시까지 한 번에 재사용한다). fcose 레이아웃
    // 애니메이션이 자리를 잡을 시간을 잠깐 준 뒤 실행한다.
    const focusNodeId = sessionStorage.getItem('easypaper_graph_focus_node')
    if (focusNodeId) {
      sessionStorage.removeItem('easypaper_graph_focus_node')
      setTimeout(() => {
        if (!libraryGraphCyInstance) return
        const node = libraryGraphCyInstance.getElementById(focusNodeId)
        if (node && node.length) {
          node.trigger('tap')
          libraryGraphCyInstance.animate({ center: { eles: node }, zoom: 1.3 }, { duration: 400 })
        }
      }, 450)
    }

    // 태그 필터 옵션 = 논문 노드들의 categories 값 전체(중복 제거, 가나다순).
    if (tagFilterEl) {
      const cats = new Set()
      for (const n of data.nodes || []) {
        if (n.type === 'paper') (n.categories || []).forEach(c => c && cats.add(c))
      }
      const sorted = [...cats].sort((a, b) => a.localeCompare(b))
      tagFilterEl.innerHTML = `<option value="all">모든 태그</option>` +
        sorted.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
    }

    const pending = [...new Set([...(data.pending_docs || []), ...(data.pending_tag_docs || [])])]
    if (libraryGraphPendingBanner) {
      libraryGraphPendingBanner.classList.toggle('hidden', pending.length === 0)
    }
    // 아직 개념/인용 동기화가 안 된 문서가 있으면 5초 뒤 다시 조회해
    // 백그라운드 백필 결과가 반영되는지 확인한다(비어질 때까지 반복).
    if (pending.length > 0) {
      libraryGraphPollTimeout = setTimeout(() => {
        if (state.currentWorkspacePage === 'graph') renderLibraryGraphTab()
      }, 5000)
    }
  } catch (err) {
    console.error('지식 그래프 로드 실패:', err)
    libraryGraphCanvas.innerHTML = '<div class="lib-empty"><p style="color:var(--error)">지식 그래프를 불러오지 못했습니다</p></div>'
  }
}

function renderRelatedQuestionsList(questions) {
  if (!questions || questions.length === 0) {
    return `<p class="rg-detail-empty">관련 질문이 없습니다.</p>`
  }
  return `
    <ul class="rg-questions-list">
      ${questions.map(q => `
        <li class="rg-questions-item">
          <div class="rg-questions-item-text">${escapeHtml(q.content || '')}</div>
          ${q.doc_title ? `<div class="rg-questions-item-doc">${escapeHtml(q.doc_title)}</div>` : ''}
        </li>
      `).join('')}
    </ul>
  `
}

// 상세 패널: 클릭된 노드 종류(논문/개념/메모/Figure)에 따라 다른 카드를
// 그린다. neighborNodes는 knowledgeGraph.js의 tap 핸들러가 closedNeighborhood()
// 로 이미 계산해 넘겨준 1촌 이웃 노드 목록(별도 API 조회 불필요)이다.
function showGraphDetailPanel(nodeData, neighborNodes = []) {
  if (!libraryGraphDetailPanel) return
  if (nodeData.type === 'paper') {
    const categories = nodeData.categories || []
    libraryGraphDetailPanel.innerHTML = `
      ${renderGraphDetailHeader(nodeData)}
      ${categories.length ? `<div class="rg-detail-tags">${categories.map(c => `<span class="rg-detail-tag">${escapeHtml(c)}</span>`).join('')}</div>` : ''}
      <div class="rg-detail-actions">
        <button id="rg-open-paper-btn" class="rg-detail-open-btn">${icon('externalLink', 14)}<span>논문 열기</span></button>
        <button id="rg-fav-paper-btn" class="rg-detail-icon-btn" title="즐겨찾기">${icon('star', 15)}</button>
        <button id="rg-more-paper-btn" class="rg-detail-icon-btn" title="더보기">${RG_MORE_SVG}</button>
        <div id="rg-more-paper-menu" class="rg-detail-more-menu hidden">
          <button id="rg-more-paper-library-btn" class="rg-detail-more-item">${icon('bookOpen', 13)}<span>라이브러리에서 자세히 보기</span></button>
        </div>
      </div>
      <div class="rg-detail-section">
        <h5 class="rg-detail-section-title">AI 요약</h5>
        <div id="rg-detail-summary-text" class="rg-detail-summary-text"><p class="rg-detail-loading">불러오는 중...</p></div>
      </div>
      <div class="rg-detail-section">
        <h5 class="rg-detail-section-title">연결 관계 (${(neighborNodes || []).length})</h5>
        ${renderGraphConnectionsSummary(neighborNodes)}
      </div>
      <div class="rg-detail-section">
        <h5 class="rg-detail-section-title">관련 노드</h5>
        ${renderGraphRelatedNodesList(neighborNodes)}
      </div>
      <div class="rg-detail-section">
        <h5 class="rg-detail-section-title">내 활동</h5>
        ${renderGraphMyActivityStats(nodeData.doc_id)}
      </div>
      <div class="rg-detail-section">
        <button id="kg-related-questions-btn" class="rg-detail-question-btn">${icon('messageCircle', 13)}<span>관련 질문 보기</span></button>
        <div id="kg-related-questions-list"></div>
      </div>
    `
    $('rg-fav-paper-btn')?.classList.toggle('active', isFavoriteDoc(nodeData.doc_id))
    $('rg-fav-paper-btn')?.addEventListener('click', () => {
      const nowFav = toggleFavoriteDoc(nodeData.doc_id)
      $('rg-fav-paper-btn')?.classList.toggle('active', nowFav)
    })
    $('rg-open-paper-btn')?.addEventListener('click', async () => {
      try {
        const doc = await fetchLibraryDoc(nodeData.doc_id)
        await openFromLibrary(doc)
      } catch (err) {
        console.error('논문 열기 실패:', err)
        showToast('논문을 불러오지 못했습니다.', 'error')
      }
    })
    $('rg-more-paper-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      $('rg-more-paper-menu')?.classList.toggle('hidden')
    })
    $('rg-more-paper-library-btn')?.addEventListener('click', async () => {
      $('rg-more-paper-menu')?.classList.add('hidden')
      try {
        const doc = await fetchLibraryDoc(nodeData.doc_id)
        openLibraryDetailPanel(doc)
      } catch (err) {
        console.error('상세 정보 열기 실패:', err)
        showToast('상세 정보를 불러오지 못했습니다.', 'error')
      }
    })
    ;(async () => {
      const summaryEl = $('rg-detail-summary-text')
      if (!summaryEl) return
      try {
        const targetLang = getTranslationOptions().targetLang
        const primer = await fetchPrimer(nodeData.doc_id, targetLang)
        const text = primer.hook || primer.feynman || primer.lineage || ''
        summaryEl.innerHTML = text
          ? escapeHtml(text).replace(/\n/g, '<br>')
          : `<p class="rg-detail-loading">아직 생성된 요약이 없습니다.</p>`
      } catch (err) {
        console.error('AI 요약 로드 실패:', err)
        summaryEl.innerHTML = `<p class="rg-detail-error">AI 요약을 불러오지 못했습니다.</p>`
      }
    })()
  } else if (nodeData.type === 'tag') {
    const roleLabel = { primary_topic: '핵심 주제', domain: '적용 분야', method: '방법', legacy: '이전 태그' }[nodeData.role] || nodeData.role
    libraryGraphDetailPanel.innerHTML = `
      ${renderGraphDetailHeader(nodeData)}
      <p class="rg-detail-subtitle">역할: ${escapeHtml(roleLabel || '미상')}</p>
      <div class="rg-detail-section"><h5 class="rg-detail-section-title">이 태그가 지정된 논문</h5>${renderGraphRelatedNodesList((neighborNodes || []).filter(n => n.type === 'paper'), '연결된 논문이 없습니다.')}</div>
    `
  } else if (nodeData.type === 'concept') {
    const questionCount = nodeData.question_count || 0
    libraryGraphDetailPanel.innerHTML = `
      ${renderGraphDetailHeader(nodeData)}
      <p class="rg-detail-subtitle">분류: ${escapeHtml(nodeData.kind || '미상')}</p>
      <div class="rg-detail-section">
        <h5 class="rg-detail-section-title">연결 관계 (${(neighborNodes || []).length})</h5>
        ${renderGraphConnectionsSummary(neighborNodes)}
      </div>
      <div class="rg-detail-section">
        <h5 class="rg-detail-section-title">이 개념을 다루는 논문</h5>
        ${renderGraphRelatedNodesList((neighborNodes || []).filter(n => n.type === 'paper'), '연결된 논문이 없습니다.')}
      </div>
      <div class="rg-detail-section">
        <h5 class="rg-detail-section-title">유사 개념</h5>
        ${renderGraphRelatedNodesList((neighborNodes || []).filter(n => n.type === 'concept'), '유사한 개념이 없습니다.')}
      </div>
      <div class="rg-detail-section">
        <button id="kg-related-questions-btn" class="rg-detail-question-btn">${icon('messageCircle', 13)}<span>관련 질문 ${questionCount}개 보기</span></button>
        <div id="kg-related-questions-list"></div>
      </div>
    `
  } else if (nodeData.type === 'note') {
    libraryGraphDetailPanel.innerHTML = `
      ${renderGraphDetailHeader(nodeData, '메모')}
      <p class="rg-detail-note-text">${escapeHtml(nodeData.label || '')}</p>
      ${nodeData.doc_id ? `<button id="rg-note-open-paper-btn" class="rg-detail-open-btn">${icon('externalLink', 14)}<span>논문에서 보기</span></button>` : ''}
    `
    $('rg-note-open-paper-btn')?.addEventListener('click', async () => {
      try {
        const doc = await fetchLibraryDoc(nodeData.doc_id)
        await openFromLibrary(doc)
      } catch (err) {
        console.error('논문 열기 실패:', err)
        showToast('논문을 불러오지 못했습니다.', 'error')
      }
    })
  } else if (nodeData.type === 'figure') {
    // 캡션은 backend(_spans_to_bold_markdown)가 **볼드**만 마크다운으로 감싸
    // 넘겨준다 - Figure/Table 오버레이 툴팁(renderBoldText 최초 도입 지점)과
    // 동일한 방식으로 렌더링해야 캡션 안의 볼드 서식이 살아난다.
    const captionHtml = nodeData.caption
      ? `<p class="rg-detail-figure-caption">${renderBoldText(nodeData.caption)}</p>`
      : ''
    const hasCrop = nodeData.doc_id != null && nodeData.index != null
    libraryGraphDetailPanel.innerHTML = `
      ${renderGraphDetailHeader(nodeData)}
      ${hasCrop ? `<img id="kg-figure-img" class="rg-detail-figure-img primer-figure-img" alt="${escapeHtml(nodeData.label || '')}" title="클릭하면 논문의 해당 페이지로 이동합니다">` : ''}
      ${captionHtml}
    `
    const figureImg = $('kg-figure-img')
    if (figureImg) {
      figureImg.addEventListener('error', () => {
        figureImg.replaceWith(Object.assign(document.createElement('p'), {
          textContent: '이미지를 불러올 수 없습니다.',
          className: 'rg-detail-empty',
        }))
      })
      figureImg.src = `/api/library/${encodeURIComponent(nodeData.doc_id)}/figure-image/${encodeURIComponent(nodeData.index)}`
      // 이미지(그림/표/수식 캡처 전부 포함)를 클릭하면 실제 논문의 해당 페이지로
      // 이동한다 - annotation 목록 항목 클릭과 동일한 경로(openAnnotationTarget).
      if (nodeData.page != null) {
        figureImg.addEventListener('click', () => {
          openAnnotationTarget({ id: nodeData.doc_id }, nodeData.page)
        })
      }
    }
  } else {
    libraryGraphDetailPanel.innerHTML = `<p class="rg-detail-empty">알 수 없는 노드입니다.</p>`
  }

  const questionsBtn = $('kg-related-questions-btn')
  if (questionsBtn) {
    questionsBtn.addEventListener('click', async () => {
      const listEl = $('kg-related-questions-list')
      if (!listEl) return
      listEl.innerHTML = `<p class="rg-detail-loading">불러오는 중...</p>`
      try {
        const { questions } = await fetchGraphNodeQuestions(nodeData.id)
        listEl.innerHTML = renderRelatedQuestionsList(questions)
      } catch (err) {
        listEl.innerHTML = `<p class="rg-detail-error">질문을 불러오지 못했습니다.</p>`
      }
    })
  }
}

// 지식 그래프 Node Search - 기존 라이브러리 검색창(librarySearchInput)과
// 동일한 디바운스 패턴을 그대로 따른다. 매칭된 노드는 highlightSearchMatches로
// 강조하고 화면에 맞춘다(knowledgeGraph.js).
let libraryGraphSearchTimer = null
if (libraryGraphSearchInput) {
  libraryGraphSearchInput.addEventListener('input', () => {
    clearTimeout(libraryGraphSearchTimer)
    const query = libraryGraphSearchInput.value.trim()
    libraryGraphSearchTimer = setTimeout(async () => {
      if (!libraryGraphCyInstance) return
      const { highlightSearchMatches } = await import('./knowledgeGraph.js')
      if (!query) {
        highlightSearchMatches(libraryGraphCyInstance, [])
        return
      }
      try {
        const result = await searchGraphNodes(query)
        const nodeIds = [...(result.paper || []), ...(result.concept || []), ...(result.note || [])]
        highlightSearchMatches(libraryGraphCyInstance, nodeIds)
      } catch (err) {
        console.error('지식 그래프 검색 실패:', err)
      }
    }, 300)
  })
  libraryGraphSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !libraryGraphCyInstance) return
    const firstMatch = libraryGraphCyInstance.nodes(".kg-search-match").first()
    if (!firstMatch || firstMatch.length === 0) return
    event.preventDefault()
    firstMatch.trigger("tap")
    libraryGraphCyInstance.animate({ center: { eles: firstMatch }, zoom: 1.3 }, { duration: 300 })
  })
}

// 추천 논문: 캐시가 있는 경우 버튼 클릭 시 접힘/펼침 토글, 없는 경우 새로 추천 요청.
if (libraryRecommendationsBtn) {
  libraryRecommendationsBtn.addEventListener('click', async () => {
    if (cachedGraphRecommendations && cachedGraphRecommendations.length > 0) {
      isGraphRecommendationsExpanded = !isGraphRecommendationsExpanded
      updateGraphRecommendationsUI()
    } else {
      await runGraphRecommendationsFetch({ force: false })
    }
  })
}

// 메모/하이라이트/언더라인 항목을 클릭하면 해당 논문을 열고 해당 페이지로 이동한다.
// Notes 페이지(pages/notesPage.js)와 Library 상세 패널에서 공유해서 쓴다.
async function openAnnotationTarget(doc, pageNum) {
  try {
    const freshDoc = await fetchLibraryDoc(doc.id)
    await openFromLibrary(freshDoc)
    scrollToPage(viewerScrollContainer, pageNum)
  } catch (err) {
    console.error('주석에서 논문 열기 실패:', err)
    showToast('논문을 불러오지 못했습니다.', 'error')
  }
}

let currentLibraryDocs = []

// ── 라이브러리 화면에서 번역 중인 문서의 진행률을 실시간으로 갱신 ──────────
// 뷰어 화면은 startJobPolling으로 진행률을 폴링하지만, 라이브러리 화면은
// renderLibrary()가 화면 진입/탭 전환 시 한 번만 스냅샷을 불러오기 때문에
// 별도로 라이브러리 화면이 활성 상태인 동안에만 도는 가벼운 폴링이 필요하다.
let libraryPollingTimer = null

function stopLibraryPolling() {
  if (libraryPollingTimer) { clearInterval(libraryPollingTimer); libraryPollingTimer = null }
}

function startLibraryPolling() {
  stopLibraryPolling()
  libraryPollingTimer = setInterval(refreshLibraryProgress, 4000)
}

async function refreshLibraryProgress() {
  if (!libraryScreen.classList.contains('active') || isLibrarySearchActive) return
  const inProgress = currentLibraryDocs.some(doc => (doc.translated_pages?.length || 0) < (doc.total_pages || 1))
  if (!inProgress) return

  try {
    const data = state.currentLibraryTab === 'trash'
      ? await fetchLibraryTrash({ ...getTranslationOptions(workspaceModeController.getMode()), documentMode: workspaceModeController.getMode() })
      : await fetchLibrary({ ...getTranslationOptions(workspaceModeController.getMode()), documentMode: workspaceModeController.getMode() })
    const freshDocsById = new Map((data.documents || []).map(doc => [doc.id, doc]))

    currentLibraryDocs.forEach((doc, idx) => {
      const freshDoc = freshDocsById.get(doc.id)
      if (!freshDoc) return
      const oldTranslated = doc.translated_pages?.length || 0
      const newTranslated = freshDoc.translated_pages?.length || 0
      if (oldTranslated === newTranslated) return
      currentLibraryDocs[idx] = freshDoc
      const container = libraryGrid.querySelector(`:scope > [data-id="${freshDoc.id}"]`)
      if (container) updateDocItemProgress(container, freshDoc)
    })
  } catch (err) {
    console.error(err)
  }
}

// 카드 전체를 다시 그리지 않고 진행률 바/텍스트만 갱신 (카드/리스트 뷰 공용)
function updateDocItemProgress(container, doc) {
  const translated = doc.translated_pages?.length || 0
  const total = doc.total_pages || 1
  const pct = Math.round((translated / total) * 100)
  const isDone = translated >= total
  const progressRow = container.querySelector('.doc-card-progress-row')
  if (!progressRow) return
  if (isDone) {
    const slot = progressRow.closest('.doc-list-progress-slot')
    ;(slot || progressRow).remove()
    return
  }
  const bar = progressRow.querySelector('.doc-progress-bar')
  const text = progressRow.querySelector('span')
  if (bar) bar.style.width = `${pct}%`
  if (text) text.textContent = `${translated}/${total} · ${pct}%`
}

function filterLibraryCards(docs) {
  currentLibraryDocs = docs
  libraryGrid.innerHTML = ''
  libraryGrid.classList.toggle('list-view', libraryViewMode === 'list')

  libraryGrid.classList.toggle('compact-view', libraryViewMode === 'compact')
  // Update filter buttons active class
  document.querySelectorAll('.category-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.category === activeCategoryFilter)
  })
  $('library-breadcrumb')?.classList.toggle('global-filter-active', activeCategoryFilter !== 'ALL')

  // 카테고리 칩은 폴더 경계를 무시한 전역 필터다. '전체'일 때만 현재 폴더를 적용한다.
  let filteredDocs = state.currentLibraryTab === 'trash' || activeCategoryFilter !== 'ALL'
    ? docs
    : docs.filter(doc => (doc.folder_id || null) === activeLibraryFolderId)

  if (activeCategoryFilter.startsWith('type:')) {
    const selectedType = activeCategoryFilter.slice(5)
    filteredDocs = filteredDocs.filter(doc => (doc.document_type || 'other') === selectedType)
  } else if (activeCategoryFilter !== 'ALL') {
    filteredDocs = filteredDocs.filter(doc => (doc.metadata?.categories || []).includes(activeCategoryFilter))
  }

  // 상태 필터(전체/읽지 않음/읽는 중/완료/즐겨찾기) 적용 - 휴지통 탭에는 없는 개념이라 건너뛴다.
  if (state.currentLibraryTab !== 'trash' && activeStatusFilter !== 'all') {
    const favIds = getFavoriteIds()
    filteredDocs = filteredDocs.filter(doc => (
      activeStatusFilter === 'favorites' ? favIds.has(doc.id) : getLibraryDocStatus(doc) === activeStatusFilter
    ))
  }

  filteredDocs = sortLibraryDocs(filteredDocs)

  const childFolders = state.currentLibraryTab === 'trash' || activeCategoryFilter !== 'ALL'
    ? []
    : libraryFolders.filter(folder => (folder.parent_id || null) === activeLibraryFolderId)
  if (filteredDocs.length === 0 && childFolders.length === 0) {
    const variant = state.currentLibraryTab === 'trash'
      ? 'trash'
      : (activeStatusFilter !== 'all' ? activeStatusFilter : (docs.length > 0 ? 'filtered' : 'library'))
    libraryGrid.appendChild(createEmptyState(variant)); return
  }

  childFolders.forEach(folder => libraryGrid.appendChild(createFolderCard(folder)))
  const createItem = libraryViewMode === 'list' ? createDocListRow : createDocCard
  filteredDocs.forEach(doc => libraryGrid.appendChild(createItem(doc)))
}

// ── 라이브러리 전체 검색 (파일명/제목/카테고리 + 번역된 본문 텍스트) ──────
let isLibrarySearchActive = false
let librarySearchDebounceTimer = null

function renderLibrarySearchResults(docs, query) {
  libraryGrid.innerHTML = ''
  libraryGrid.classList.toggle('list-view', libraryViewMode === 'list')
  libraryGrid.classList.toggle('compact-view', libraryViewMode === 'compact')

  if (docs.length === 0) {
    const el = document.createElement('div')
    el.className = 'lib-empty'
    el.innerHTML = `<div style="margin-bottom:16px;color:var(--text-muted)">${icon('book', 48)}</div>
      <p>"${escapeHtml(query)}"에 대한 검색 결과가 없습니다</p>
      <p style="font-size:13px;color:var(--text-muted);margin-top:8px">논문 제목, 파일명, 번역된 본문 내용을 검색합니다</p>`
    libraryGrid.appendChild(el)
  } else {
    const createItem = libraryViewMode === 'list' ? createDocListRow : createDocCard
    docs.forEach(doc => libraryGrid.appendChild(createItem(doc)))
  }

  if (librarySearchStatus) {
    librarySearchStatus.textContent = `"${query}" 검색 결과 ${docs.length}건`
    librarySearchStatus.classList.remove('hidden')
  }
}

async function runLibrarySearch(query) {
  try {
    const res = await searchLibrary(query, workspaceModeController.getMode())
    // 디바운스 중 사용자가 입력을 더 바꿨을 수 있으므로, 지금 입력값과 다르면 버린다
    if (librarySearchInput.value.trim() !== query) return
    renderLibrarySearchResults(res.documents || [], query)
  } catch (err) {
    console.error(err)
    if (librarySearchStatus) {
      librarySearchStatus.textContent = '검색 중 오류가 발생했습니다.'
      librarySearchStatus.classList.remove('hidden')
    }
  }
}

function exitLibrarySearch() {
  isLibrarySearchActive = false
  if (librarySearchStatus) librarySearchStatus.classList.add('hidden')
  if (libraryFilterRow) libraryFilterRow.style.display = 'flex'
  filterLibraryCards(currentLibraryDocs)
}

if (librarySearchInput) {
  librarySearchInput.addEventListener('input', () => {
    const query = librarySearchInput.value.trim()
    if (librarySearchClearBtn) librarySearchClearBtn.classList.toggle('hidden', !query)
    clearTimeout(librarySearchDebounceTimer)

    if (!query) {
      if (isLibrarySearchActive) exitLibrarySearch()
      return
    }
    librarySearchDebounceTimer = setTimeout(() => {
      isLibrarySearchActive = true
      if (libraryFilterRow) libraryFilterRow.style.display = 'none'
      runLibrarySearch(query)
    }, 300)
  })
}

if (librarySearchClearBtn) {
  librarySearchClearBtn.addEventListener('click', () => {
    librarySearchInput.value = ''
    librarySearchClearBtn.classList.add('hidden')
    exitLibrarySearch()
    librarySearchInput.focus()
  })
}

// variant: 'library'(보관함 전체가 비어 있음) | 'trash'(휴지통이 비어 있음) |
// 'unread' | 'reading' | 'finished' | 'favorites'(해당 상태 탭에 걸리는 문서가 없음) |
// 'filtered'(태그 필터 결과가 없음). 과거 boolean(isHistory) 시그니처와의 호환을 위해
// true도 'finished'로 취급한다.
const LIBRARY_EMPTY_STATE_VARIANTS = {
  trash:     { iconName: 'trash2',   title: '휴지통이 비어 있습니다', desc: '삭제한 논문이 여기에 표시됩니다' },
  unread:    { iconName: 'bookOpen', title: '읽지 않은 논문이 없습니다', desc: '모든 논문을 확인했네요' },
  reading:   { iconName: 'bookOpen', title: '읽는 중인 논문이 없습니다', desc: '번역이 진행 중인 논문이 여기에 표시됩니다' },
  finished:  { iconName: 'bookOpen', title: '읽은 논문이 없습니다', desc: '보관함에서 논문의 체크 아이콘을 눌러 읽음 처리해 보세요' },
  favorites: { iconName: 'star',     title: '즐겨찾기한 논문이 없습니다', desc: '카드의 별표 아이콘을 눌러 즐겨찾기에 추가해 보세요' },
  filtered:  { iconName: 'tag',      title: '조건에 맞는 논문이 없습니다', desc: '다른 필터를 선택해 보세요' },
  library:   { iconName: 'book',     title: '보관함에 저장된 논문이 없습니다', desc: '새 논문을 추가하거나 PDF를 업로드해 보세요' },
}
function createEmptyState(variant = 'library') {
  if (variant === true) variant = 'finished'
  if (variant === false) variant = 'library'
  const el = document.createElement('div')
  el.className = 'lib-empty'
  const c = LIBRARY_EMPTY_STATE_VARIANTS[variant] || LIBRARY_EMPTY_STATE_VARIANTS.library
  el.innerHTML = `<div style="margin-bottom:16px;color:var(--text-muted)">${icon(c.iconName, 48)}</div>
    <p>${c.title}</p>
    <p style="font-size:13px;color:var(--text-muted);margin-top:8px">${c.desc}</p>`
  return el
}


// 카드/리스트 뷰 공용: 문서 데이터로부터 두 뷰가 함께 쓰는 마크업 조각을 미리 계산한다.
function prepareDocItemHtml(doc) {
  const pct = getLibraryReadProgress(doc)
  const isDone = doc.metadata?.read === true || pct >= 100
  const date = new Date(doc.created_at).toLocaleDateString('ko-KR', { year:'numeric', month:'short', day:'numeric' })

  const categories = doc.metadata?.categories || []
  let tagsHtml = ''
  if (categories.length > 0) {
    const shownCategories = categories.slice(0, 2)
    const hiddenCategoryCount = categories.length - shownCategories.length
    tagsHtml = `<div class="doc-card-tags">` +
      shownCategories.map(cat => `<span class="doc-card-tag" title="${escapeHtml(cat)}">${escapeHtml(cat)}</span>`).join('') +
      (hiddenCategoryCount > 0 ? `<span class="doc-card-tag doc-card-tag-count" title="태그 ${hiddenCategoryCount}개 더 보기">+${hiddenCategoryCount}</span>` : '') +
      `</div>`
  }

  const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
  const isRead = doc.metadata?.read === true

  let dateHtml = `<span class="doc-meta-chip">${date}</span>`
  if (isRead && doc.metadata?.read_at) {
    const readDateStr = new Date(doc.metadata.read_at).toLocaleDateString('ko-KR', { year:'numeric', month:'short', day:'numeric' })
    dateHtml = `<span class="doc-meta-chip done">완독 ${readDateStr}</span>`
  }

  const isSelected = selectedDocIds.has(doc.id)
  const compareCheckHtml = ''

  const checkBtnHtml = state.currentLibraryTab === 'trash' ? '' : `
    <button class="doc-card-check-btn ${isSelected ? 'checked' : ''}" data-id="${doc.id}" title="${isSelected ? '선택 해제' : '선택'}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </button>
  `


  const expandBtnHtml = state.currentLibraryTab === 'trash' ? '' : `
    <button class="doc-card-expand-btn" data-id="${doc.id}" title="미리보기">${icon('expand', 12)}</button>
  `

  let progressHtml = ''
  if (!isDone) {
    const lastPage = Number.isInteger(doc.metadata?.last_page) ? doc.metadata.last_page : 0
    const totalPages = doc.total_pages || 0
    progressHtml = `
      <div class="doc-card-progress-row">
        <div class="doc-progress-bar-wrap"><div class="doc-progress-bar" style="width:${pct}%"></div></div>
        <span>${lastPage}/${totalPages}p · ${pct}%</span>
      </div>
    `
  }

  const openIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>'

  // ctaBtnHtml: 리스트 뷰용 - 자리를 적게 차지하는 아이콘 전용 버튼
  // ctaBtnFullHtml: 카드 뷰용 - 미리보기 팝업의 "열기" 버튼과 동일한 전체 너비 텍스트 버튼
  let iconActionsHtml = ''
  let ctaBtnHtml = ''
  let ctaBtnFullHtml = ''
  if (state.currentLibraryTab === 'trash') {
    iconActionsHtml = `
      <button class="doc-permanent-delete-btn" data-id="${doc.id}" title="영구 삭제">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
    `
    ctaBtnHtml = `<button class="doc-restore-btn doc-cta-compact" data-id="${doc.id}" title="복원">${icon('refreshCw', 15)}</button>`
    ctaBtnFullHtml = `<button class="doc-restore-btn" data-id="${doc.id}"><span>복원</span>${icon('refreshCw', 15)}</button>`
  } else {
    iconActionsHtml = `
      <button class="doc-edit-btn" data-id="${doc.id}" title="제목 수정">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"></path></svg>
      </button>
      <div class="doc-card-kebab-wrapper">
        <button class="doc-card-kebab-btn" data-id="${doc.id}" title="더보기">
          ${icon('moreVertical', 14)}
        </button>
        <div class="doc-card-kebab-menu hidden" data-id="${doc.id}">
          <button class="doc-card-kebab-item doc-card-delete-btn" data-id="${doc.id}">
            ${icon('trash2', 13)}
            <span>삭제하기</span>
          </button>
          <button class="doc-card-kebab-item doc-card-clear-cache-btn" data-id="${doc.id}">
            ${icon('refreshCw', 13)}
            <span>캐시 삭제</span>
          </button>
        </div>
      </div>
    `
    ctaBtnHtml = `<button class="doc-open-btn doc-cta-compact" data-id="${doc.id}" title="열기">${openIcon}</button>`
    ctaBtnFullHtml = `<button class="doc-open-btn" data-id="${doc.id}"><span>열기</span>${openIcon}</button>`
  }

  return { pct, isDone, categories, tagsHtml, displayTitle, isRead, dateHtml, checkBtnHtml, compareCheckHtml, expandBtnHtml, progressHtml, iconActionsHtml, ctaBtnHtml, ctaBtnFullHtml }
}

// 카드/리스트 뷰 공용: 위임 없이 각 아이템 컨테이너에 직접 붙는 이벤트 리스너를 등록한다.
let activeLibraryDragPreview = null

function removeLibraryDragPreview() {
  activeLibraryDragPreview?.remove()
  activeLibraryDragPreview = null
}

function createLibraryDragPreview(count) {
  removeLibraryDragPreview()
  const preview = document.createElement('div')
  preview.className = 'library-multi-drag-preview'
  preview.setAttribute('aria-hidden', 'true')
  const stackDepth = Math.min(count - 1, 3)
  preview.innerHTML = `${Array.from({ length: stackDepth }, (_, index) => `<span class="library-drag-stack-sheet" style="--stack-index:${index + 1}"></span>`).join('')}
    <div class="library-drag-stack-card">
      <span class="library-drag-stack-icon">${icon('fileText', 22)}</span>
      <span class="library-drag-stack-copy"><strong>${count}개 논문</strong><small>선택 항목 이동</small></span>
      <span class="library-drag-stack-count">${count}</span>
    </div>`
  document.body.appendChild(preview)
  activeLibraryDragPreview = preview
  return preview
}

function wireDocDragEvents(container, doc) {
  if (state.currentLibraryTab === 'trash') return
  container.draggable = true
  container.addEventListener('dragstart', e => {
    const ids = selectedDocIds.has(doc.id) ? Array.from(selectedDocIds) : [doc.id]
    e.dataTransfer.setData('application/x-easypaper-item', JSON.stringify({ kind: 'document', ids }))
    e.dataTransfer.effectAllowed = 'move'
    container.classList.add('doc-dragging')
    if (ids.length > 1) {
      const preview = createLibraryDragPreview(ids.length)
      e.dataTransfer.setDragImage(preview, 24, 24)
    }
  })
  container.addEventListener('dragend', () => {
    container.classList.remove('doc-dragging')
    removeLibraryDragPreview()
  })
}

// 클래스명(.doc-card-check-btn, .doc-open-btn 등)만 맞으면 어떤 레이아웃이든 동작한다.
function wireDocItemEvents(container, doc, displayTitle) {
  wireDocDragEvents(container, doc)
  if (selectedDocIds.has(doc.id)) {
    container.classList.add('doc-card-selected')
  }

  const checkBtn = container.querySelector('.doc-card-check-btn')
  if (checkBtn) {
    checkBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleDocSelection(doc.id)
    })
  }

  const typeFilterChip = container.querySelector('[data-document-type-filter]')
  if (typeFilterChip) {
    typeFilterChip.addEventListener('click', event => {
      event.stopPropagation()
      activeCategoryFilter = `type:${typeFilterChip.dataset.documentTypeFilter}`
      filterLibraryCards(currentLibraryDocs)
    })
  }

  const openBtn = container.querySelector('.doc-open-btn')
  if (openBtn) {
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (selectedDocIds.size > 0) {
        toggleDocSelection(doc.id)
        return
      }
      openFromLibrary(doc)
    })
  }


  const kebabBtn = container.querySelector('.doc-card-kebab-btn')
  const kebabMenu = container.querySelector('.doc-card-kebab-menu')
  if (kebabBtn && kebabMenu) {
    kebabBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const isHidden = kebabMenu.classList.contains('hidden')
      document.querySelectorAll('.doc-card-kebab-menu').forEach(m => m.classList.add('hidden'))
      if (isHidden) {
        kebabMenu.classList.remove('hidden')
      }
    })
  }

  const cardDeleteBtn = container.querySelector('.doc-card-delete-btn, .doc-delete-btn')
  if (cardDeleteBtn) {
    cardDeleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      kebabMenu?.classList.add('hidden')
      const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
      const ok = await showCustomConfirm(`"${displayTitle}"을 삭제할까요? (휴지통으로 이동합니다)`, { title: '논문 삭제', confirmText: '삭제', danger: true })
      if (!ok) return
      try {
        await deleteLibraryDoc(doc.id)
        showToast('휴지통으로 이동되었습니다.', 'success')
        await renderLibrary()
      } catch {
        showToast('삭제 실패', 'error')
      }
    })
  }

  const cardClearCacheBtn = container.querySelector('.doc-card-clear-cache-btn')
  if (cardClearCacheBtn) {
    cardClearCacheBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      kebabMenu?.classList.add('hidden')
      const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
      const ok = await showCustomConfirm(`"${displayTitle}"의 PDF 추출 캐시를 삭제할까요?\n(다음 열람 시 PDF를 다시 파싱하게 됩니다.)`, { title: 'PDF 캐시 삭제', confirmText: '캐시 삭제' })
      if (!ok) return
      try {
        await clearSingleDocCacheAPI(doc.id)
        showToast('PDF 추출 캐시가 삭제되었습니다.', 'success')
      } catch (err) {
        showToast('캐시 삭제 실패: ' + err.message, 'error')
      }
    })
  }


  const restoreBtn = container.querySelector('.doc-restore-btn')
  if (restoreBtn) {
    restoreBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await restoreLibraryDoc(doc.id)
        showToast('논문이 복원되었습니다.', 'success')
        await renderLibrary()
      } catch (err) {
        showToast('복원 실패: ' + err.message, 'error')
      }
    })
  }

  const permDeleteBtn = container.querySelector('.doc-permanent-delete-btn')
  if (permDeleteBtn) {
    permDeleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
      const ok = await showCustomConfirm(`"${displayTitle}"을 영구적으로 삭제할까요?\n이 작업은 되돌릴 수 없으며, 모든 번역 데이터 및 채팅 기록이 지워집니다.`, {
        title: '논문 영구 삭제',
        confirmText: '영구 삭제',
        danger: true
      })
      if (!ok) return
      try {
        await deleteLibraryDocPermanently(doc.id)
        showToast('영구 삭제되었습니다.', 'success')
        await renderLibrary()
      } catch (err) {
        showToast('삭제 실패: ' + err.message, 'error')
      }
    })
  }

  const editBtn = container.querySelector('.doc-edit-btn')
  if (editBtn) {
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const titleEl = container.querySelector('.doc-card-title')
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
          await updateLibraryDocTitle(doc.id, newTitle)
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
  }

  container.addEventListener('click', (e) => {
    if (e.target.closest('.doc-card-kebab-wrapper, .doc-edit-btn, .doc-open-btn, .doc-restore-btn, .doc-permanent-delete-btn, .doc-card-fav-btn, .doc-card-expand-btn')) return

    if (selectedDocIds.size > 0) {
      toggleDocSelection(doc.id)
      return
    }
    if (state.currentLibraryTab === 'trash') {
      showToast('휴지통에 있는 논문입니다. 복원 후 열 수 있습니다.', 'warning')
      return
    }
    openFromLibrary(doc)
  })
}

function documentTypeChipHtml(doc, includeMode = false) {
  const docMode = doc.document_mode || "research"
  const docType = doc.document_type || "research_paper"
  const typeLabel = workspaceModeController.getTypeLabel(docMode, docType)
  const label = includeMode ? `${docMode === "research" ? "연구" : "일반"} · ${typeLabel}` : typeLabel
  if (docMode === 'general' && state.currentWorkspacePage === 'library') {
    return `<button type="button" class="document-type-chip ${docMode}" data-document-type-filter="${escapeHtml(docType)}" title="${escapeHtml(label)} 유형만 보기">${escapeHtml(label)}</button>`
  }
  return `<span class="document-type-chip ${docMode}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`
}

function processingBadgeHtml(doc) {
  const processing = doc?.processing || doc?.processingStatus
  if (!processing) return ''
  const label = processing.badge === 'local_only'
    ? t('library:privacy.localOnly')
    : processing.badge === 'local_processing' ? t('library:privacy.localProcessing') : t('library:privacy.externalTransfer')
  const itemLabels = {
    document_text: t('library:privacy.items.document_text'),
    chat_history: t('library:privacy.items.chat_history'),
    page_image: t('library:privacy.items.page_image'),
    document_metadata: t('library:privacy.items.document_metadata'),
    notes: t('library:privacy.items.notes'),
    document_file: t('library:privacy.items.document_file')
  }
  const items = (processing.transfer_items || []).map(item => itemLabels[item] || item).join(', ')
  const title = items ? t('library:privacy.transferItems', { items }) : label
  return `<span class="processing-badge ${escapeHtml(processing.badge)}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`
}

function renderViewerProcessingBadge(processing) {
  const el = $('viewer-processing-badge')
  if (!el) return
  const wrapper = document.createElement('div')
  wrapper.innerHTML = processingBadgeHtml({ processing })
  const badge = wrapper.firstElementChild
  if (!badge) { el.className = 'processing-badge hidden'; el.textContent = ''; return }
  el.className = badge.className
  el.textContent = badge.textContent
  el.title = badge.title
}
function createDocCard(doc) {
  const d = prepareDocItemHtml(doc)
  const isFav = isFavoriteDoc(doc.id)
  const docMode = doc.document_mode || 'research'

  // 카드 뷰는 리스트 뷰의 압축 진행률(d.progressHtml)과는 별도로, 전체 너비 바 +
  // 퍼센트를 보여주는 새 레이아웃을 쓴다(리스트 뷰는 손대지 않는다 - createDocListRow는
  // 편집 허용 범위 밖).
  let cardProgressHtml = ''
  if (d.isDone) {
    cardProgressHtml = `
      <div class="lib-card-progress lib-card-progress-done">
        <span class="doc-meta-chip done">${icon('checkCircle', 11)}완료</span>
      </div>
    `
  } else {
    cardProgressHtml = `
      <div class="lib-card-progress">
        <div class="lib-card-progress-bar-wrap"><div class="lib-card-progress-bar" style="width:${d.pct}%"></div></div>
        <span class="lib-card-progress-pct">${d.pct}%</span>
      </div>
    `
  }

  // 즐겨찾기는 휴지통 문서에는 의미가 없어(체크/미리보기 버튼과 동일하게) 숨긴다.
  const favBtnHtml = state.currentLibraryTab === 'trash' ? '' : `
    <button class="doc-card-fav-btn ${isFav ? 'active' : ''}" data-id="${escapeHtml(doc.id)}" title="즐겨찾기">${icon('star', 11)}</button>
  `

  const card = document.createElement('div')
  card.className = 'doc-card'
  card.dataset.id = doc.id
  card.dataset.documentMode = docMode
  card.innerHTML = `
    ${d.compareCheckHtml}
    <div class="doc-card-zone">
      <div class="doc-card-zone-actions">
        ${d.expandBtnHtml}
        ${d.checkBtnHtml}
      </div>
      <div class="lib-card-top">
        <div class="lib-card-thumb">
          <img src="/api/library/${encodeURIComponent(doc.id)}/cover" alt="" loading="lazy" />
          <div class="lib-card-thumb-fallback">${icon('fileText', 18)}</div>
          ${favBtnHtml}
        </div>
        <div class="lib-card-top-body">
          <div class="doc-card-title" title="${escapeHtml(doc.filename)}">${escapeHtml(d.displayTitle)}</div>
          ${documentTypeChipHtml(doc, true)}
        </div>
      </div>
      ${d.tagsHtml}
      <div class="doc-card-meta">
        ${d.dateHtml}<span class="meta-dot"></span><span class="doc-meta-chip">${doc.total_pages || 0}p</span>
      </div>
      ${cardProgressHtml}
    </div>
    <div class="doc-card-footer">
      ${d.ctaBtnFullHtml}
      <div class="doc-icon-actions">${d.iconActionsHtml}</div>
    </div>`

  const thumbImg = card.querySelector('.lib-card-thumb img')
  if (thumbImg) {
    thumbImg.addEventListener('error', () => {
      thumbImg.closest('.lib-card-thumb')?.classList.add('cover-fallback')
    })
  }

  card.addEventListener('click', (e) => {
    if (e.target.closest('.doc-card-kebab-wrapper, .doc-edit-btn, .doc-open-btn, .doc-restore-btn, .doc-permanent-delete-btn, .doc-card-fav-btn, .doc-card-expand-btn')) return

    if (selectedDocIds.size > 0) {
      toggleDocSelection(doc.id)
      e.stopImmediatePropagation()
      return
    }
    if (state.currentLibraryTab === 'trash') {
      showToast('휴지통에 있는 논문입니다. 복원 후 열 수 있습니다.', 'warning')
      e.stopImmediatePropagation()
      return
    }
    openLibraryDetailPanel(doc)
    e.stopImmediatePropagation()
  })


  wireDocItemEvents(card, doc, d.displayTitle)

  const expandBtn = card.querySelector('.doc-card-expand-btn')
  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      showDocPreview(doc)
    })
  }

  const favBtn = card.querySelector('.doc-card-fav-btn')
  if (favBtn) {
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const nowFav = toggleFavoriteDoc(doc.id)
      favBtn.classList.toggle('active', nowFav)
      renderLibraryStatusTabs(currentLibraryDocs)
    })
  }

  return card
}

// ============================================================
// 라이브러리 카드 상세 패널 (우측 드로어)
// 카드를 클릭하면 열리며, 표지/제목 + "논문 열기" 버튼 + 개요(AI 요약/기본 정보/태그)·
// 메모·AI 대화·관련 자료 탭을 보여준다. index.html은 건드리지 않고 이 함수들이
// 처음 필요할 때(ensureLibraryDetailPanel) 마크업을 직접 삽입한다.
// ============================================================
let libraryDetailDoc = null
let libraryDetailLoadedTabs = new Set()
let libraryDetailSummaryReqToken = 0
let libraryDetailBiblioReqToken = 0
let libraryGraphCacheForDetail = null // fetchLibraryGraph() 결과 캐시 - 패널을 열 때마다 다시 조회하지 않도록. renderLibrary()가 무효화한다.
const LIBRARY_DETAIL_TABS = ['overview', 'notes', 'questions', 'related']


function chooseReparseEngine(currentEngine) {
  const choices = (pdfParsersData || []).filter(parser => parser.installed && parser.id !== currentEngine)
  if (!choices.length && currentEngine !== 'pymupdf') {
    choices.push({ id: 'pymupdf', name: 'PyMuPDF' })
  }
  if (!choices.length) {
    showToast(t('library:reparse.noInstalled'), 'info')
    return Promise.resolve(null)
  }
  return new Promise(resolve => {
    const modal = document.createElement('div')
    modal.className = 'custom-confirm-modal-wrapper'
    modal.innerHTML = `
      <div class="custom-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="reparse-engine-title">
        <div class="custom-confirm-modal-header">
          <span id="reparse-engine-title" class="custom-confirm-modal-title">${t('library:reparse.selectTitle')}</span>
        </div>
        <div class="custom-confirm-modal-body">
          <label class="folder-dialog-label">${t('library:reparse.selectLabel')}
            <select class="folder-dialog-input reparse-engine-select">
              ${choices.map(parser => `<option value="${escapeHtml(parser.id)}">${escapeHtml(parser.name || parser.id)}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="custom-confirm-modal-footer">
          <button class="custom-confirm-btn cancel-btn">${t('library:reparse.cancel')}</button>
          <button class="custom-confirm-btn confirm-btn primary-btn">${t('library:reparse.start')}</button>
        </div>
      </div>`
    document.body.appendChild(modal)
    const select = modal.querySelector('select')
    const close = value => {
      modal.classList.remove('active')
      setTimeout(() => { modal.remove(); resolve(value) }, 180)
    }
    modal.querySelector('.cancel-btn').addEventListener('click', () => close(null))
    modal.querySelector('.confirm-btn').addEventListener('click', () => close(select.value))
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') close(null) })
    modal.addEventListener('click', event => { if (event.target === modal) close(null) })
    setTimeout(() => { modal.classList.add('active'); select.focus() }, 10)
  })
}

function showReparseComparison(preview) {
  return new Promise(resolve => {
    const current = preview.current_report || {}
    const candidate = preview.candidate_report || {}
    const impact = preview.impact || {}
    const problemPreviews = (candidate.pages || []).filter(page => page.issues?.length).slice(0, 5)
    const modal = document.createElement('div')
    modal.className = 'custom-confirm-modal-wrapper'
    modal.innerHTML = `
      <div class="custom-confirm-modal reparse-comparison-modal" role="dialog" aria-modal="true" aria-labelledby="reparse-compare-title">
        <div class="custom-confirm-modal-header">
          <span id="reparse-compare-title" class="custom-confirm-modal-title">${t('library:reparse.compareTitle')}</span>
        </div>
        <div class="custom-confirm-modal-body">
          <div class="reparse-report-grid">
            <section><strong>${t('library:reparse.current')}</strong><span>${escapeHtml(current.parser_engine || '')}</span><span>${t('library:reparse.problemPages', { count: current.problem_page_count || 0 })}</span></section>
            <section><strong>${t('library:reparse.candidate')}</strong><span>${escapeHtml(candidate.parser_engine || '')}</span><span>${t('library:reparse.problemPages', { count: candidate.problem_page_count || 0 })}</span></section>
          </div>
          <div class="reparse-problem-previews">
            ${problemPreviews.map(page => `<article><strong>${escapeHtml(t('viewer:pageLabel', { page: page.page_num }))}</strong><small>${escapeHtml((page.issues || []).join(', '))}</small><p>${escapeHtml(page.preview || '')}</p></article>`).join('')}
          </div>
          <p>${escapeHtml(t('library:reparse.affected', {
            translations: impact.translations_to_regenerate || 0,
            insights: impact.insights_to_regenerate || 0,
            tasks: impact.running_tasks_to_cancel || 0,
          }))}</p>
          <p>${escapeHtml(t('library:reparse.preserved'))}</p>
        </div>
        <div class="custom-confirm-modal-footer">
          <button class="custom-confirm-btn cancel-btn">${t('library:reparse.cancel')}</button>
          <button class="custom-confirm-btn confirm-btn primary-btn">${t('library:reparse.apply')}</button>
        </div>
      </div>`
    document.body.appendChild(modal)
    const close = value => {
      modal.classList.remove('active')
      setTimeout(() => { modal.remove(); resolve(value) }, 180)
    }
    modal.querySelector('.cancel-btn').addEventListener('click', () => close(false))
    modal.querySelector('.confirm-btn').addEventListener('click', () => close(true))
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') close(false) })
    modal.addEventListener('click', event => { if (event.target === modal) close(false) })
    setTimeout(() => { modal.classList.add('active'); modal.querySelector('.cancel-btn').focus() }, 10)
  })
}

async function runDocumentReparseFlow(doc) {
  if (!pdfParsersData?.length) {
    const parserInfo = await fetchPdfParsersInfoAPI()
    pdfParsersData = parserInfo.parsers || []
  }
  const engine = await chooseReparseEngine(doc.parser_engine || 'pymupdf')
  if (!engine) return
  showToast(t('library:reparse.running'), 'info')
  let preview = await createReparsePreviewAPI(doc.id, engine)
  while (['queued', 'running'].includes(preview.status)) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    preview = await getReparsePreviewAPI(doc.id, preview.id)
  }
  if (preview.status !== 'succeeded') {
    throw new Error(preview.last_error_code || t('library:reparse.failed'))
  }
  if (!await showReparseComparison(preview)) return
  const applied = await applyReparsePreviewAPI(doc.id, preview.id)
  libraryDetailDoc = {
    ...doc,
    content_revision: applied.content_revision,
    parser_engine: applied.parser_engine,
    parser_version: applied.parser_version,
    total_pages: applied.total_pages,
  }
  showToast(t('library:reparse.applied', { revision: applied.content_revision }), 'success')
  await renderLibrary()
}


function ensureLibraryDetailPanel() {
  if ($('lib-detail-panel')) return

  const openIconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>'
  const closeIconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
  const moreIconSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>'

  document.body.insertAdjacentHTML('beforeend', `
    <div id="lib-detail-overlay" class="lib-detail-overlay"></div>
    <aside id="lib-detail-panel" class="lib-detail-panel" aria-hidden="true">
      <button id="lib-detail-close-btn" class="lib-detail-close-btn" title="닫기">${closeIconSvg}</button>
      <div class="lib-detail-hero">
        <div class="lib-detail-cover" id="lib-detail-cover">
          <img id="lib-detail-cover-img" alt="" />
          <div class="lib-detail-cover-fallback">${icon('fileText', 26)}</div>
        </div>
        <div class="lib-detail-title-block">
          <h2 id="lib-detail-title" class="lib-detail-title"></h2>
          <p id="lib-detail-subtitle" class="lib-detail-subtitle"></p>
          <div class="lib-detail-processing-row">
            <span id="lib-detail-processing-badge"></span>
            <label for="lib-detail-processing-policy">${t('library:privacy.policy')}</label>
            <select id="lib-detail-processing-policy">
              <option value="inherit">${t('library:privacy.inherit')}</option>
              <option value="local_only">${t('library:privacy.localOnly')}</option>
            </select>
          </div>
        </div>
      </div>
      <div class="lib-detail-actions">
        <button id="lib-detail-open-btn" class="lib-detail-open-btn">${openIconSvg}<span>논문 열기</span></button>
        <button id="lib-detail-fav-btn" class="lib-detail-icon-btn" title="즐겨찾기">${icon('star', 15)}</button>
        <button id="lib-detail-edit-btn" class="lib-detail-icon-btn" title="제목 수정">${icon('edit3', 14)}</button>
        <button id="lib-detail-more-btn" class="lib-detail-icon-btn" title="더보기">${moreIconSvg}</button>
        <div id="lib-detail-more-menu" class="lib-detail-more-menu hidden">
          <button id="lib-detail-classification-btn" class="lib-detail-more-item">${icon('layers', 13)}<span>문서 분류 변경</span></button>
          <button id="lib-detail-reparse-btn" class="lib-detail-more-item">${icon('refreshCw', 13)}<span>${t('library:reparse.menu')}</span></button>
          <button id="lib-detail-clear-cache-btn" class="lib-detail-more-item">${icon('refreshCw', 13)}<span>PDF 추출 캐시 삭제</span></button>
          <button id="lib-detail-delete-btn" class="lib-detail-more-item danger">${icon('trash2', 13)}<span>삭제 (휴지통으로 이동)</span></button>
        </div>

      </div>
      <div class="lib-detail-tabs">
        <button type="button" class="lib-detail-tab active" data-tab="overview">개요</button>
        <button type="button" class="lib-detail-tab" data-tab="notes">메모<span id="lib-detail-tab-count-notes" class="lib-detail-tab-count hidden"></span></button>
        <button type="button" class="lib-detail-tab" data-tab="questions">AI 대화<span id="lib-detail-tab-count-questions" class="lib-detail-tab-count hidden"></span></button>
        <button type="button" class="lib-detail-tab" data-tab="related">관련 자료<span id="lib-detail-tab-count-related" class="lib-detail-tab-count hidden"></span></button>
      </div>
      <div class="lib-detail-body">
        <section id="lib-detail-panel-overview" class="lib-detail-panel-section">
          <div class="lib-detail-summary-block">
            <h3>AI 요약</h3>
            <div id="lib-detail-summary-text" class="lib-detail-summary-text"></div>
          </div>
          <div class="lib-detail-quickinfo-block">
            <h3>기본 정보</h3>
            <dl id="lib-detail-quickinfo" class="lib-detail-quickinfo"></dl>
          </div>
          <div class="lib-detail-tags-block">
            <div class="lib-detail-tags-heading"><h3>태그</h3><div><button id="lib-detail-tags-edit-btn" class="lib-detail-tag-action">편집</button><button id="lib-detail-tags-ai-btn" class="lib-detail-tag-action">AI 재분류</button></div></div>
            <div id="lib-detail-tags" class="lib-detail-tags"></div>
          </div>
        </section>
        <section id="lib-detail-panel-notes" class="lib-detail-panel-section hidden"></section>
        <section id="lib-detail-panel-questions" class="lib-detail-panel-section hidden"></section>
        <section id="lib-detail-panel-related" class="lib-detail-panel-section hidden"></section>
      </div>
    </aside>
  `)

  $('lib-detail-overlay')?.addEventListener('click', closeLibraryDetailPanel)
  $('lib-detail-close-btn')?.addEventListener('click', closeLibraryDetailPanel)

  document.querySelectorAll('#lib-detail-panel .lib-detail-tab').forEach(btn => {
    btn.addEventListener('click', () => switchLibraryDetailTab(btn.dataset.tab))
  })

  $('lib-detail-open-btn')?.addEventListener('click', () => {
    if (!libraryDetailDoc) return
    const doc = libraryDetailDoc
    closeLibraryDetailPanel()
    openFromLibrary(doc)
  })

  $('lib-detail-fav-btn')?.addEventListener('click', () => {
    if (!libraryDetailDoc) return
    const nowFav = toggleFavoriteDoc(libraryDetailDoc.id)
    $('lib-detail-fav-btn')?.classList.toggle('active', nowFav)
    const cardFavBtn = libraryGrid.querySelector(`.doc-card-fav-btn[data-id="${CSS.escape(libraryDetailDoc.id)}"]`)
    if (cardFavBtn) cardFavBtn.classList.toggle('active', nowFav)
    renderLibraryStatusTabs(currentLibraryDocs)
  })

  $('lib-detail-edit-btn')?.addEventListener('click', () => {
    if (libraryDetailDoc) startLibraryDetailTitleEdit(libraryDetailDoc)
  })

  const moreBtn = $('lib-detail-more-btn')
  const moreMenu = $('lib-detail-more-menu')
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      moreMenu.classList.toggle('hidden')
    })
    document.addEventListener('click', () => moreMenu.classList.add('hidden'))
  }

  $('lib-detail-classification-btn')?.addEventListener('click', async () => {
    if (!libraryDetailDoc) return
    const doc = libraryDetailDoc
    moreMenu?.classList.add('hidden')
    const selected = await workspaceModeController.chooseDocumentClassification(doc.document_mode || 'research')
    if (!selected || (selected.documentMode === (doc.document_mode || 'research') && selected.documentType === doc.document_type)) return
    const ok = await showCustomConfirm(
      '분류를 변경하면 이후 번역·개요·AI 정책이 새 문서 종류를 따릅니다. 기존 번역 또는 인사이트가 있으면 안전을 위해 변경되지 않습니다.',
      { title: '문서 분류 변경', confirmText: '분류 변경', danger: false },
    )
    if (!ok) return
    try {
      const updated = await patchDocumentClassificationAPI(doc.id, { document_mode: selected.documentMode, document_type: selected.documentType })
      libraryDetailDoc = { ...doc, ...updated }
      closeLibraryDetailPanel()
      await workspaceModeController.setMode(selected.documentMode)
      await showLibraryScreen()
      showToast('문서 분류를 변경했습니다.', 'success')
    } catch (error) {
      showToast(error.message || '문서 분류 변경 실패', 'error')
    }
  })


  $('lib-detail-reparse-btn')?.addEventListener('click', async () => {
    if (!libraryDetailDoc) return
    const doc = libraryDetailDoc
    moreMenu?.classList.add('hidden')
    try {
      await runDocumentReparseFlow(doc)
    } catch (error) {
      showToast(error.message || t('library:reparse.failed'), 'error')
    }
  })

  $('lib-detail-clear-cache-btn')?.addEventListener('click', async () => {
    if (!libraryDetailDoc) return
    const doc = libraryDetailDoc
    const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
    moreMenu?.classList.add('hidden')
    const ok = await showCustomConfirm(`"${displayTitle}"의 PDF 추출 캐시를 삭제할까요?\n(다음 열람 시 PDF를 다시 파싱하게 됩니다.)`, { title: 'PDF 캐시 삭제', confirmText: '캐시 삭제' })
    if (!ok) return
    try {
      await clearSingleDocCacheAPI(doc.id)
      showToast('PDF 추출 캐시가 삭제되었습니다.', 'success')
    } catch (err) {
      showToast('캐시 삭제 실패: ' + err.message, 'error')
    }
  })

  $('lib-detail-delete-btn')?.addEventListener('click', async () => {

    if (!libraryDetailDoc) return
    const doc = libraryDetailDoc
    const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
    moreMenu?.classList.add('hidden')
    const ok = await showCustomConfirm(`"${displayTitle}"을 삭제할까요? (휴지통으로 이동합니다)`, { title: '논문 삭제', confirmText: '삭제', danger: true })
    if (!ok) return
    try {
      await deleteLibraryDoc(doc.id)
      showToast('휴지통으로 이동되었습니다.', 'success')
      closeLibraryDetailPanel()
      await renderLibrary()
    } catch {
      showToast('삭제 실패', 'error')
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('lib-detail-panel')?.classList.contains('open')) closeLibraryDetailPanel()
  })
}

function openLibraryDetailPanel(doc) {
  ensureLibraryDetailPanel()
  libraryDetailDoc = doc
  libraryDetailLoadedTabs = new Set(['overview'])

  const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
  const isGeneralDocument = (doc.document_mode || 'research') === 'general'
  const openLabel = $('lib-detail-open-btn')?.querySelector('span')
  if (openLabel) openLabel.textContent = isGeneralDocument ? '문서 열기' : '논문 열기'
  document.querySelector('#lib-detail-panel .lib-detail-tab[data-tab="related"]')?.classList.toggle('hidden', isGeneralDocument)
  document.querySelector('#lib-detail-panel .lib-detail-tags-block')?.classList.toggle('hidden', isGeneralDocument)
  const titleEl = $('lib-detail-title')
  if (titleEl) titleEl.textContent = displayTitle
  const subtitleEl = $('lib-detail-subtitle')
  if (subtitleEl) {
    const date = new Date(doc.created_at).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })
    subtitleEl.textContent = `등록 ${date} · ${doc.total_pages || 1}페이지`
  }
  const processingBadge = $('lib-detail-processing-badge')
  if (processingBadge) processingBadge.innerHTML = processingBadgeHtml(doc)
  const processingSelect = $('lib-detail-processing-policy')
  if (processingSelect) {
    processingSelect.value = doc.processing_policy || 'inherit'
    processingSelect.onchange = async () => {
      const previous = doc.processing_policy || 'inherit'
      processingSelect.disabled = true
      try {
        const processing = await patchDocumentProcessingPolicyAPI(doc.id, processingSelect.value)
        doc.processing_policy = processing.processing_policy
        doc.processing = processing
        if (processingBadge) processingBadge.innerHTML = processingBadgeHtml(doc)
        if (state.currentDocId === doc.id) {
          state.processingPolicy = processing.processing_policy
          state.processingStatus = processing
          renderViewerProcessingBadge(processing)
        }
        showToast(t('library:privacy.updated'), 'success')
        await renderLibrary()
      } catch (error) {
        processingSelect.value = previous
        showToast(error.message, 'error')
      } finally {
        processingSelect.disabled = false
      }
    }
  }

  const coverWrap = $('lib-detail-cover')
  const coverImg = $('lib-detail-cover-img')
  if (coverWrap && coverImg) {
    coverWrap.classList.remove('cover-fallback')
    coverImg.onerror = () => coverWrap.classList.add('cover-fallback')
    coverImg.src = `/api/library/${encodeURIComponent(doc.id)}/cover`
  }

  $('lib-detail-fav-btn')?.classList.toggle('active', isFavoriteDoc(doc.id))
  ;['notes', 'questions', 'related'].forEach(t => {
    const c = $(`lib-detail-tab-count-${t}`)
    if (c) { c.textContent = ''; c.classList.add('hidden') }
  })

  switchLibraryDetailTab('overview')
  loadLibraryDetailOverview(doc)

  $('lib-detail-overlay')?.classList.add('open')
  const panel = $('lib-detail-panel')
  if (panel) { panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false') }
}

function closeLibraryDetailPanel() {
  if (!libraryDetailDoc) return
  libraryDetailDoc = null
  libraryDetailSummaryReqToken++ // 진행 중이던 AI 요약 요청의 응답이 늦게 와도 화면에 반영되지 않도록 무효화
  libraryDetailBiblioReqToken++ // 진행 중이던 서지 정보 요청도 동일하게 무효화
  $('lib-detail-overlay')?.classList.remove('open')
  const panel = $('lib-detail-panel')
  if (panel) { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true') }
  $('lib-detail-more-menu')?.classList.add('hidden')
}

function switchLibraryDetailTab(tab) {
  document.querySelectorAll('#lib-detail-panel .lib-detail-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  })
  LIBRARY_DETAIL_TABS.forEach(t => {
    $(`lib-detail-panel-${t}`)?.classList.toggle('hidden', t !== tab)
  })
  if (!libraryDetailDoc) return
  if (!libraryDetailLoadedTabs.has(tab)) {
    libraryDetailLoadedTabs.add(tab)
    if (tab === 'notes') loadLibraryDetailNotes(libraryDetailDoc)
    else if (tab === 'questions') loadLibraryDetailQuestions(libraryDetailDoc)
    else if (tab === 'related') loadLibraryDetailRelated(libraryDetailDoc)
  }
}

// 카드의 제목 인라인 수정(wireDocItemEvents의 .doc-edit-btn 핸들러)과 동일한 방식으로,
// 패널 안에서도 제목을 바로 고칠 수 있게 한다.
function startLibraryDetailTitleEdit(doc) {
  const titleEl = $('lib-detail-title')
  if (!titleEl) return
  const oldTitle = titleEl.textContent

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'lib-detail-title-input'
  input.value = oldTitle
  titleEl.replaceWith(input)
  input.focus()
  input.select()

  let isSaving = false
  async function save() {
    if (isSaving) return
    isSaving = true
    const newTitle = input.value.trim()
    if (newTitle && newTitle !== oldTitle) {
      try {
        await updateLibraryDocTitle(doc.id, newTitle)
        showToast('제목이 변경되었습니다.', 'success')
        titleEl.textContent = newTitle
        await renderLibrary()
        if ((doc.document_mode || 'research') === 'research') fetchLibraryBibliography(doc.id, true).then(biblio => {
          const venueEl = $('lib-detail-qi-venue')
          const doiEl = $('lib-detail-qi-doi')
          const arxivEl = $('lib-detail-qi-arxiv')
          const citationsEl = $('lib-detail-qi-citations')
          if (venueEl) venueEl.textContent = biblio.venue || '—'
          if (doiEl) doiEl.textContent = biblio.doi || '—'
          if (arxivEl) arxivEl.textContent = biblio.arxiv_id || '—'
          if (citationsEl) citationsEl.textContent = biblio.citation_count != null ? biblio.citation_count.toLocaleString('ko-KR') : '—'
        }).catch(() => {})
      } catch (err) {
        showToast('제목 변경 실패: ' + err.message, 'error')
        titleEl.textContent = oldTitle
      }
    } else {
      titleEl.textContent = oldTitle
    }
    input.replaceWith(titleEl)
  }
  input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); await save() }
    else if (ev.key === 'Escape') {
      ev.preventDefault()
      isSaving = true
      titleEl.textContent = oldTitle
      input.replaceWith(titleEl)
    }
  })
  input.addEventListener('blur', () => { if (!isSaving) save() })
}

// 개요 탭: Quick Info/태그는 이미 갖고 있는 문서 데이터로 즉시 렌더링하고, AI 요약은
// 읽기 전 브리핑(primer)의 hook 텍스트를 재사용한다(백엔드에 별도 "요약" 필드는 없음).
// 아직 캐시가 없으면 생성에 시간이 걸릴 수 있어(fetchPrimer가 내부적으로 폴링), 패널을
// 닫거나 다른 논문으로 바꾼 뒤 응답이 와도 화면에 반영되지 않도록 요청 토큰으로 막는다.
async function openPaperTagEditor(doc) {
  const ontology = await fetchPaperTagOntology()
  const roles = ontology.roles || {}
  const current = doc.metadata?.paper_tags || {}
  const selected = {
    primary_topic: new Set((current.primary_topics || []).map(item => item.name || item)),
    domain: new Set((current.domains || []).map(item => item.name || item)),
    method: new Set((current.methods || []).map(item => item.name || item)),
  }
  const labels = { primary_topic: '핵심 주제', domain: '적용 분야', method: '방법' }
  const modal = document.createElement('div')
  modal.className = 'custom-confirm-modal-wrapper paper-tag-editor-wrap'
  modal.innerHTML = `<div class="custom-confirm-modal paper-tag-editor"><div class="custom-confirm-modal-header"><span class="custom-confirm-modal-title">논문 태그 편집</span></div><div class="custom-confirm-modal-body paper-tag-editor-body">${Object.entries(roles).map(([role, names]) => `<fieldset class="paper-tag-fieldset"><legend>${labels[role] || role}</legend><div class="paper-tag-options">${names.map((name, index) => `<label><input type="checkbox" data-role="${role}" value="${escapeHtml(name)}" ${selected[role]?.has(name) ? 'checked' : ''}><span>${escapeHtml(name)}</span></label>`).join('')}</div></fieldset>`).join('')}</div><div class="custom-confirm-modal-footer"><button class="custom-confirm-btn cancel-btn">취소</button><button class="custom-confirm-btn confirm-btn primary-btn">저장</button></div></div>`
  document.body.appendChild(modal)
  return new Promise(resolve => {
    const close = result => { modal.classList.remove('active'); setTimeout(() => { modal.remove(); resolve(result) }, 200) }
    modal.querySelector('.cancel-btn').addEventListener('click', () => close(null))
    modal.addEventListener('click', e => { if (e.target === modal) close(null) })
    modal.querySelector('.confirm-btn').addEventListener('click', async () => {
      const payload = { primary_topics: [], domains: [], methods: [] }
      modal.querySelectorAll('input:checked').forEach(input => {
        const field = input.dataset.role === 'primary_topic' ? 'primary_topics' : input.dataset.role === 'domain' ? 'domains' : 'methods'
        payload[field].push(input.value)
      })
      if (!payload.primary_topics.length) { showToast('핵심 주제를 하나 이상 선택해 주세요.', 'warning'); return }
      try {
        const result = await updatePaperTags(doc.id, payload)
        close(result)
      } catch (err) { showToast(err.message || '태그 저장 실패', 'error') }
    })
    setTimeout(() => modal.classList.add('active'), 10)
  })
}

function renderStructuredPaperTags(metadata) {
  const tags = metadata?.paper_tags
  if (!tags) return (metadata?.categories || []).map(name => `<span class="lib-detail-tag">${escapeHtml(name)}</span>`).join('')
  const groups = [
    ['핵심', tags.primary_topics || []], ['분야', tags.domains || []], ['방법', tags.methods || []],
  ]
  return groups.flatMap(([label, items]) => items.map(item => {
    const name = item.name || item
    const evidence = item.evidence ? ` title="${escapeHtml(item.evidence)}"` : ''
    return `<span class="lib-detail-tag"${evidence}><small>${label}</small>${escapeHtml(name)}</span>`
  })).join('')
}

async function loadLibraryDetailOverview(doc) {
  const total = doc.total_pages || 1
  const translated = doc.translated_pages?.length || 0
  const pct = Math.round((translated / total) * 100)
  const status = getLibraryDocStatus(doc)
  const statusLabel = { unread: '읽지 않음', reading: '읽는 중', finished: '완료' }[status] || status
  const addedDate = new Date(doc.created_at).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })

  const isGeneralDocument = (doc.document_mode || 'research') === 'general'
  const quickInfoEl = $('lib-detail-quickinfo')
  if (quickInfoEl) {
    const commonInfo = `
      <dt>등록일</dt><dd>${escapeHtml(addedDate)}</dd>
      <dt>페이지</dt><dd>${total}p</dd>
      <dt>번역 진행률</dt><dd>${pct}%</dd>
      <dt>상태</dt><dd>${escapeHtml(statusLabel)}</dd>`
    quickInfoEl.innerHTML = isGeneralDocument
      ? `<dt>문서 종류</dt><dd>${escapeHtml(workspaceModeController.getTypeLabel('general', doc.document_type || 'other'))}</dd>${commonInfo}`
      : `<dt>Venue</dt><dd id="lib-detail-qi-venue">불러오는 중...</dd>${commonInfo}
         <dt>DOI</dt><dd id="lib-detail-qi-doi">불러오는 중...</dd>
         <dt>ArXiv</dt><dd id="lib-detail-qi-arxiv">불러오는 중...</dd>
         <dt>Citations</dt><dd id="lib-detail-qi-citations">불러오는 중...</dd>`
  }
  // Venue/DOI/ArXiv/Citations는 문서 자체에 저장된 필드가 없어 OpenAlex 제목
  // 검색으로 채운다(서버가 첫 조회 때만 검색하고 이후엔 캐시 반환 - services/
  // reference_linker.py resolve_paper_metadata). 못 찾은 필드는 "—"로 표시하고
  // 지어내지 않는다.
  const myBiblioToken = ++libraryDetailBiblioReqToken
  if (!isGeneralDocument) fetchLibraryBibliography(doc.id).then(biblio => {
    if (myBiblioToken !== libraryDetailBiblioReqToken) return
    const venueEl = $('lib-detail-qi-venue')
    const doiEl = $('lib-detail-qi-doi')
    const arxivEl = $('lib-detail-qi-arxiv')
    const citationsEl = $('lib-detail-qi-citations')
    if (venueEl) venueEl.textContent = biblio.venue || '—'
    if (doiEl) doiEl.textContent = biblio.doi || '—'
    if (arxivEl) arxivEl.textContent = biblio.arxiv_id || '—'
    if (citationsEl) citationsEl.textContent = biblio.citation_count != null ? biblio.citation_count.toLocaleString('ko-KR') : '—'
  }).catch(err => {
    if (myBiblioToken !== libraryDetailBiblioReqToken) return
    console.error('서지 정보 로드 실패:', err)
    ;['lib-detail-qi-venue', 'lib-detail-qi-doi', 'lib-detail-qi-arxiv', 'lib-detail-qi-citations'].forEach(id => {
      const el = $(id)
      if (el) el.textContent = '—'
    })
  })

  const tagsEl = $('lib-detail-tags')
  if (!isGeneralDocument && tagsEl) {
    tagsEl.innerHTML = renderStructuredPaperTags(doc.metadata) || `<p class="lib-detail-empty" style="padding:0">지정된 태그가 없습니다.</p>`
  }
  const tagsEditBtn = $('lib-detail-tags-edit-btn')
  if (tagsEditBtn) tagsEditBtn.classList.toggle('hidden', isGeneralDocument)
  if (tagsEditBtn) tagsEditBtn.onclick = async () => {
    try {
      const result = await openPaperTagEditor(doc)
      if (!result) return
      doc.metadata = result.metadata
      libraryDetailDoc = doc
      loadLibraryDetailOverview(doc)
      showToast('태그를 저장했습니다.', 'success')
      await renderLibrary()
    } catch (err) { showToast(err.message || '태그 편집기를 열지 못했습니다.', 'error') }
  }
  const tagsAiBtn = $('lib-detail-tags-ai-btn')
  if (tagsAiBtn) tagsAiBtn.classList.toggle('hidden', isGeneralDocument)
  if (!isGeneralDocument && tagsAiBtn) tagsAiBtn.onclick = async () => {
    const ok = await showCustomConfirm('사용자 지정 태그를 최신 AI 분류 결과로 교체할까요?', { title: 'AI 태그 재분류', confirmText: '재분류', danger: false })
    if (!ok) return
    try {
      const result = await reclassifyPaperTags(doc.id)
      doc.metadata = result.metadata
      libraryDetailDoc = doc
      loadLibraryDetailOverview(doc)
      showToast('태그를 다시 분류했습니다.', 'success')
      await renderLibrary()
    } catch (err) { showToast(err.message || '태그 재분류 실패', 'error') }
  }

  const myToken = ++libraryDetailSummaryReqToken
  const summaryEl = $('lib-detail-summary-text')
  if (summaryEl) summaryEl.innerHTML = `<p class="lib-detail-summary-loading">AI 요약을 불러오는 중...</p>`
  try {
    const targetLang = getTranslationOptions().targetLang
    const data = await fetchPrimer(doc.id, targetLang)
    if (myToken !== libraryDetailSummaryReqToken) return
    const text = data.hook || data.feynman || data.lineage || ''
    if (summaryEl) {
      summaryEl.innerHTML = text
        ? escapeHtml(text).replace(/\n/g, '<br>')
        : `<p class="lib-detail-summary-loading">아직 생성된 요약이 없습니다.</p>`
    }
  } catch (err) {
    if (myToken !== libraryDetailSummaryReqToken) return
    console.error('AI 요약 로드 실패:', err)
    if (summaryEl) summaryEl.innerHTML = `<p class="lib-detail-summary-error">AI 요약을 불러오지 못했습니다.</p>`
  }
}

// 메모 탭: 서버 API가 아니라 문서별 localStorage(easypaper_memos_*)에서 바로 읽는다
// (loadMemos는 이미 메모/하이라이트 목록 화면(renderAnnotationsBrowser)이 쓰는 함수).
function loadLibraryDetailNotes(doc) {
  const section = $('lib-detail-panel-notes')
  const countEl = $('lib-detail-tab-count-notes')
  if (!section) return

  const memosByPage = loadMemos(doc.id)
  const items = []
  Object.keys(memosByPage).forEach(pageKey => {
    const pageNum = parseInt(pageKey.replace('page_', ''), 10)
    if (isNaN(pageNum)) return
    memosByPage[pageKey].forEach(memo => items.push({ pageNum, memo }))
  })
  items.sort((a, b) => String(b.memo.id).localeCompare(String(a.memo.id)))

  if (countEl) { countEl.textContent = String(items.length); countEl.classList.toggle('hidden', items.length === 0) }

  if (items.length === 0) {
    section.innerHTML = `<p class="lib-detail-empty">이 ${(doc.document_mode || 'research') === 'general' ? '문서' : '논문'}에 남긴 메모가 없습니다.</p>`
    return
  }
  section.innerHTML = items.map((entry, i) => {
    const text = (entry.memo.content && entry.memo.content.trim()) || entry.memo.sentenceText || '(내용 없음)'
    return `
      <div class="lib-detail-list-item" data-idx="${i}">
        <div class="lib-detail-list-item-meta">${entry.pageNum}페이지</div>
        <div class="lib-detail-list-item-text">${escapeHtml(truncateForList(text, 90))}</div>
      </div>
    `
  }).join('')
  section.querySelectorAll('.lib-detail-list-item').forEach((item, i) => {
    item.addEventListener('click', () => {
      const entry = items[i]
      closeLibraryDetailPanel()
      openAnnotationTarget(doc, entry.pageNum)
    })
  })
}

// "질문" 탭: 문서별 질문 개수를 직접 세는 API/필드가 없어(메시지 단위 카운트는
// 제공되지 않음), 이 문서에 대해 실제로 나눈 AI 어시스턴트 대화 세션 수/목록으로
// 대체한다 - getChatSessionsAPI()는 이미 AI Chats 페이지가 쓰는 기존 엔드포인트다.
async function loadLibraryDetailQuestions(doc) {
  const section = $('lib-detail-panel-questions')
  const countEl = $('lib-detail-tab-count-questions')
  if (!section) return
  section.innerHTML = `<p class="lib-detail-empty">불러오는 중...</p>`
  try {
    const data = await getChatSessionsAPI(doc.document_mode || 'research')
    const sessions = (data.sessions || []).filter(s => s.doc_id === doc.id)
    if (countEl) { countEl.textContent = String(sessions.length); countEl.classList.toggle('hidden', sessions.length === 0) }
    if (sessions.length === 0) {
      section.innerHTML = `<p class="lib-detail-empty">이 ${(doc.document_mode || 'research') === 'general' ? '문서' : '논문'}에 대해 나눈 AI 대화가 없습니다.</p>`
      return
    }
    section.innerHTML = sessions.map((s, i) => `
      <div class="lib-detail-list-item" data-idx="${i}">
        <div class="lib-detail-list-item-meta">${escapeHtml(formatChatSessionTime(s.last_message_at))}</div>
        <div class="lib-detail-list-item-text">${escapeHtml(s.title || '')}</div>
      </div>
    `).join('')
    section.querySelectorAll('.lib-detail-list-item').forEach(item => {
      item.addEventListener('click', async () => {
        try {
          closeLibraryDetailPanel()
          await openFromLibrary(doc)
          openChatSidebar()
        } catch {
          showToast('대화를 열 수 없습니다.', 'error')
        }
      })
    })
  } catch (err) {
    console.error('AI 대화 목록 로드 실패:', err)
    section.innerHTML = `<p class="lib-detail-empty" style="color:var(--error)">대화 목록을 불러오지 못했습니다.</p>`
  }
}

// "관련 자료" 탭: 지식 그래프에서 이 논문(paper:{id}) 노드와 직접 연결된 이웃(인용/카테고리/
// 개념/메모/Figure)을 보여준다. 전체 그래프를 한 번만 불러와 캐시하고(renderLibrary가 무효화),
// 문서 하나마다 새 API를 만들지 않는다.
async function getLibraryGraphForDetail() {
  if (!libraryGraphCacheForDetail) {
    libraryGraphCacheForDetail = await fetchLibraryGraph()
  }
  return libraryGraphCacheForDetail
}

async function loadLibraryDetailRelated(doc) {
  const section = $('lib-detail-panel-related')
  const countEl = $('lib-detail-tab-count-related')
  if (!section) return
  section.innerHTML = `<p class="lib-detail-empty">불러오는 중...</p>`
  try {
    const graph = await getLibraryGraphForDetail()
    const nodeId = `paper:${doc.id}`
    const nodesById = new Map((graph.nodes || []).map(n => [n.id, n]))
    const neighborIds = new Set()
    ;(graph.edges || []).forEach(e => {
      if (e.source === nodeId) neighborIds.add(e.target)
      else if (e.target === nodeId) neighborIds.add(e.source)
    })
    const neighbors = Array.from(neighborIds).map(id => nodesById.get(id)).filter(Boolean)

    if (countEl) { countEl.textContent = String(neighbors.length); countEl.classList.toggle('hidden', neighbors.length === 0) }

    if (neighbors.length === 0) {
      section.innerHTML = `<p class="lib-detail-empty">아직 연결된 논문/개념이 없습니다.</p>`
      return
    }
    const typeLabel = { paper: '논문', concept: '개념', note: '메모', figure: 'Figure' }
    section.innerHTML = neighbors.map((n, i) => `
      <div class="lib-detail-list-item" data-idx="${i}">
        <div class="lib-detail-list-item-meta">${escapeHtml(typeLabel[n.type] || n.type || '')}</div>
        <div class="lib-detail-list-item-text">${escapeHtml(n.label || '')}</div>
      </div>
    `).join('')
    section.querySelectorAll('.lib-detail-list-item').forEach((item, i) => {
      item.addEventListener('click', async () => {
        const n = neighbors[i]
        if (n.type !== 'paper') return
        try {
          const targetDoc = await fetchLibraryDoc(n.id.replace('paper:', ''))
          closeLibraryDetailPanel()
          openLibraryDetailPanel(targetDoc)
        } catch {
          showToast('논문 정보를 불러오지 못했습니다.', 'error')
        }
      })
    })
  } catch (err) {
    console.error('관련 자료 로드 실패:', err)
    section.innerHTML = `<p class="lib-detail-empty" style="color:var(--error)">관련 정보를 불러오지 못했습니다.</p>`
  }
}

function createDocListRow(doc) {
  const d = prepareDocItemHtml(doc)
  const docMode = doc.document_mode || 'research'

  // 리스트 뷰도 카드 뷰와 마찬가지로 최대 2개만 보여주고 나머지는 "+N"으로 요약한다.
  let listTagsHtml = ''
  if (d.categories.length > 0) {
    const shown = d.categories.slice(0, 2)
    const restCount = d.categories.length - shown.length
    listTagsHtml = `<div class="doc-card-tags">` +
      shown.map(cat => `<span class="doc-card-tag">${escapeHtml(cat)}</span>`).join('') +
      (restCount > 0 ? `<span class="doc-card-tag">+${restCount}</span>` : '') +
      `</div>`
  }

  const row = document.createElement('div')
  row.className = 'doc-list-row'
  row.dataset.id = doc.id
  row.dataset.documentMode = docMode
  row.innerHTML = `
    ${d.compareCheckHtml}
    ${d.checkBtnHtml}
    <div class="doc-list-title" title="${escapeHtml(doc.filename)}">${escapeHtml(d.displayTitle)}</div>
    ${documentTypeChipHtml(doc, true)}
    ${listTagsHtml}
    <div class="doc-card-meta">
      ${d.dateHtml}<span class="meta-dot"></span><span class="doc-meta-chip">${doc.total_pages || 0}p</span>
    </div>
    <div class="doc-list-progress-slot">${d.progressHtml}</div>
    <div class="doc-card-cta">
      <div class="doc-icon-actions">${d.iconActionsHtml}</div>
      ${d.ctaBtnHtml}
    </div>`
  wireDocItemEvents(row, doc, d.displayTitle)
  return row
}

// ── 논문 미리보기(빠른 보기) 팝업 ──────────────────────────
let docPreviewCurrentDoc = null

function showDocPreview(doc) {
  docPreviewCurrentDoc = doc
  const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
  docPreviewTitle.textContent = displayTitle

  // 표지 이미지 생성 실패(손상된 PDF 등) 시 깨진 이미지 아이콘 대신 중립 그라디언트로
  // 자연스럽게 대체한다 (카테고리 색을 쓰지 않아 다른 곳과 톤이 일관됨).
  const hero = docPreviewCoverImg.closest('.doc-preview-hero')
  docPreviewCoverImg.classList.remove('hidden')
  if (hero) hero.style.background = ''
  docPreviewCoverImg.onerror = () => {
    docPreviewCoverImg.classList.add('hidden')
    if (hero) hero.style.background = 'linear-gradient(160deg, var(--bg-elevated), var(--bg-card))'
  }
  docPreviewCoverImg.src = `/api/library/${doc.id}/cover`
  docPreviewPages.textContent = `${doc.total_pages || 1}p`

  const categories = doc.metadata?.categories || []
  docPreviewTags.innerHTML = categories.map(cat => `<span>${escapeHtml(cat)}</span>`).join('')

  const date = new Date(doc.created_at).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })
  const translated = doc.translated_pages?.length || 0
  const total = doc.total_pages || 1
  docPreviewMeta.textContent = `등록 ${date} · 번역 ${translated}/${total}p`

  docPreviewOverlay.classList.remove('hidden')
}

function hideDocPreview() {
  docPreviewOverlay.classList.add('hidden')
  docPreviewCurrentDoc = null
}

if (docPreviewClose) docPreviewClose.addEventListener('click', hideDocPreview)
if (docPreviewOverlay) {
  docPreviewOverlay.addEventListener('click', (e) => {
    if (e.target === docPreviewOverlay) hideDocPreview()
  })
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && docPreviewOverlay && !docPreviewOverlay.classList.contains('hidden')) {
    hideDocPreview()
  }
})

if (docPreviewOpenBtn) {
  docPreviewOpenBtn.addEventListener('click', () => {
    const doc = docPreviewCurrentDoc
    if (!doc) return
    // 트랜지션 콜백에는 팝업을 닫는 즉각적인 DOM 변경만 넣는다 - openFromLibrary
    // 전체(PDF 로드 + 페이지 렌더링)를 콜백 안에 넣고 기다리면, 뷰 트랜지션이
    // "이후 상태" 스냅샷을 로딩이 다 끝날 때까지 못 찍어서 그 사이 화면이 멈춘
    // 것처럼 보이고 뷰어 진입이 오히려 훨씬 느리게 느껴진다. 팝업 닫힘만 짧게
    // 트랜지션으로 처리하고, 문서 로딩은 기존과 동일하게 곧장 진행해 원래의
    // 점진적 로딩 표시(스피너 등)가 그대로 보이도록 한다.
    if (document.startViewTransition) {
      document.startViewTransition(() => { hideDocPreview() })
    } else {
      hideDocPreview()
    }
    openFromLibrary(doc)
  })
}

// ── 읽기 전 브리핑(Reading Primer) 모달 ──────────────────────
// mode: 'gate'면 논문을 처음 열 때 뷰어 진입을 가로막는 형태로 뜨며
// (건너뛰기/읽으러 가기 둘 다 통과), 'toolbar'면 뷰어 툴바에서 언제든
// 다시 열어보는 형태로 뜬다(닫기 버튼 하나만 노출). 어느 모드든 모달이
// 닫히는 시점에 resolve되는 프로미스를 반환한다.
let primerResolve = null

function hidePrimerModal(result) {
  closeOverlayModal(primerModal)
  if (primerResolve) {
    const resolve = primerResolve
    primerResolve = null
    resolve(result)
  }
}

// 섹션이 계보/파인만 설명/실험 흐름/용어집/관련 논문까지 늘어나 세로로 나열하면
// 모달이 너무 길어지므로 탭 구조로 나눈다. 개요 탭은 항상 노출하고, 나머지
// 탭은 해당 데이터가 없으면(예: 논문이 새 용어를 안 만든 경우 용어집) 탭
// 버튼 자체를 숨겨 탭바가 지저분해지지 않게 한다.
function switchPrimerTab(tabName) {
  document.querySelectorAll('.primer-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName)
  })
  document.querySelectorAll('.primer-tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.panel === tabName)
  })
}

function togglePrimerTabButton(tabName, visible) {
  const btn = primerTabsBar && primerTabsBar.querySelector(`.primer-tab-btn[data-tab="${tabName}"]`)
  if (btn) btn.classList.toggle('hidden', !visible)
}

if (primerTabsBar) {
  primerTabsBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.primer-tab-btn')
    if (!btn || btn.classList.contains('hidden')) return
    switchPrimerTab(btn.dataset.tab)
  })
}

// 브리핑 텍스트는 LLM이 LaTeX($...$)나 마크다운(**볼드** 등)을 섞어 반환할 수
// 있으므로, 번역창과 동일한 formatTranslationHtml/applyKatexToElement 파이프라인을
// 통해 렌더링한다(기존에는 textContent/escapeHtml로만 표시해 원문 그대로 노출됐다).
function renderPrimerRichText(el, text) {
  if (!el) return
  el.innerHTML = formatTranslationHtml(text)
  applyKatexToElement(el)
}

function renderPrimerLineage(data) {
  if (data.lineage) {
    renderPrimerRichText(primerLineageText, data.lineage)
    primerLineageSection.classList.remove('hidden')
  } else {
    primerLineageSection.classList.add('hidden')
  }
  togglePrimerTabButton('lineage', !!data.lineage)
}

function renderPrimerFeynman(data) {
  if (data.feynman) {
    renderPrimerRichText(primerFeynmanText, data.feynman)
    primerFeynmanSection.classList.remove('hidden')
  } else {
    primerFeynmanSection.classList.add('hidden')
  }
  togglePrimerTabButton('feynman', !!data.feynman)
}

function renderPrimerExperimentFlow(data) {
  const flow = data.experiment_flow || []
  if (flow.length === 0) {
    primerExperimentSection.classList.add('hidden')
    primerExperimentFlow.innerHTML = ''
    togglePrimerTabButton('experiment', false)
    return
  }
  primerExperimentFlow.innerHTML = flow.map((step, i) => `
    <li class="primer-experiment-step">
      <div class="primer-experiment-step-num">${i + 1}</div>
      <div class="primer-experiment-step-body">
        <div class="primer-experiment-row"><span class="primer-experiment-tag">가설</span><span>${formatTranslationHtml(step.hypothesis)}</span></div>
        <div class="primer-experiment-row"><span class="primer-experiment-tag">방법</span><span>${formatTranslationHtml(step.method)}</span></div>
        <div class="primer-experiment-row"><span class="primer-experiment-tag">결과</span><span>${formatTranslationHtml(step.result)}</span></div>
      </div>
    </li>
  `).join('')
  primerExperimentSection.classList.remove('hidden')
  togglePrimerTabButton('experiment', true)
  applyKatexToElement(primerExperimentFlow)
}

function renderPrimerGlossary(data) {
  const glossary = data.glossary || []
  if (glossary.length === 0) {
    primerGlossarySection.classList.add('hidden')
    primerGlossary.innerHTML = ''
    togglePrimerTabButton('glossary', false)
    return
  }
  primerGlossary.innerHTML = glossary.map(g => `
    <details class="primer-glossary-item">
      <summary class="primer-glossary-term">${formatTranslationHtml(g.term)}</summary>
      <p class="primer-glossary-def">${formatTranslationHtml(g.definition)}</p>
    </details>
  `).join('')
  primerGlossarySection.classList.remove('hidden')
  togglePrimerTabButton('glossary', true)
  applyKatexToElement(primerGlossary)
}

function renderPrimerCitationGraph(container, citationGraph, mode) {
  const section = primerGraphSection
  const libraryMatches = (citationGraph && citationGraph.library) || []
  const externalMatches = (citationGraph && citationGraph.external) || []
  const nodes = [
    ...libraryMatches.map(m => ({ ...m, kind: 'library' })),
    ...externalMatches.map(m => ({ ...m, kind: 'external' })),
  ]
  if (nodes.length === 0) {
    section.classList.add('hidden')
    container.innerHTML = ''
    togglePrimerTabButton('graph', false)
    return
  }
  section.classList.remove('hidden')
  togglePrimerTabButton('graph', true)

  const width = 460, height = 280, cx = width / 2, cy = height / 2
  const nodeR = 40, centerR = 32
  const radius = Math.min(width, height) / 2 - nodeR - 4
  const angleStep = (2 * Math.PI) / nodes.length
  const positioned = nodes.map((n, i) => {
    const angle = -Math.PI / 2 + i * angleStep
    return { ...n, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
  })

  const truncate = (s, n) => (s && s.length > n) ? `${s.slice(0, n)}…` : (s || '')
  let svg = `<svg viewBox="0 0 ${width} ${height}" class="primer-graph-svg">`
  for (const n of positioned) {
    svg += `<line x1="${cx}" y1="${cy}" x2="${n.x}" y2="${n.y}" class="primer-graph-edge" />`
  }
  svg += `<circle cx="${cx}" cy="${cy}" r="${centerR}" class="primer-graph-node primer-graph-node-center" />`
  svg += `<text x="${cx}" y="${cy}" class="primer-graph-node-text primer-graph-node-text-center">이 논문</text>`
  positioned.forEach((n, i) => {
    const cls = n.kind === 'library' ? 'primer-graph-node-library' : 'primer-graph-node-external'
    svg += `<g class="primer-graph-node-group" data-idx="${i}">`
    svg += `<circle cx="${n.x}" cy="${n.y}" r="${nodeR}" class="primer-graph-node ${cls}" />`
    svg += `<text x="${n.x}" y="${n.y}" class="primer-graph-node-text">${escapeHtml(truncate(n.title, 16))}</text>`
    svg += `</g>`
  })
  svg += `</svg>`
  container.innerHTML = svg

  container.querySelectorAll('.primer-graph-node-group').forEach(g => {
    g.addEventListener('click', async () => {
      const n = positioned[parseInt(g.dataset.idx, 10)]
      if (n.kind === 'library') {
        const targetDoc = await fetchLibraryDoc(n.doc_id).catch(() => null)
        if (!targetDoc) return
        if (mode === 'gate') {
          // gate 모드는 openFromLibrary가 이 모달의 프로미스를 await하며 대기
          // 중이므로, 여기서 곧장 openFromLibrary를 호출하면 원래 문서 로딩과
          // 동시에 실행되어 state가 뒤섞인다. 대신 redirect 시그널로 resolve해
          // 호출부가 원래 문서 로딩을 건너뛰고 순서대로 이 논문을 열게 한다.
          hidePrimerModal({ redirect: targetDoc })
        } else {
          hidePrimerModal()
          openFromLibrary(targetDoc)
        }
      } else if (n.url) {
        window.open(n.url, '_blank', 'noopener')
      }
    })
  })
}

function setPrimerModeCopy(isOverview) {
  const setSectionLabel = (section, value) => {
    const label = section?.querySelector('.primer-label span:last-child')
    if (label) label.textContent = value
  }
  const setTabLabel = (tab, value) => {
    const button = primerTabsBar?.querySelector(`[data-tab="${tab}"]`)
    if (button) button.textContent = value
  }
  const loadingText = primerLoading?.querySelector('p')
  const errorText = primerError?.querySelector('p')
  if (loadingText) loadingText.textContent = isOverview ? '문서 개요를 준비하고 있어요...' : '읽기 전 브리핑을 준비하고 있어요...'
  if (errorText) errorText.textContent = isOverview ? '문서 개요를 불러오지 못했습니다.' : '브리핑을 불러오지 못했습니다.'
  setSectionLabel(primerQuestionsSection, isOverview ? '문서 유형별 빠른 질문' : '읽기 전에 스스로 답해보기')
  setSectionLabel(primerChecklistSection, isOverview ? '전제 조건·주의사항·핵심 지표' : '읽으면서 확인할 것')
  setSectionLabel(primerLineageSection, isOverview ? '문서 구조' : '이 논문의 연구 계보')
  setSectionLabel(primerFeynmanSection, isOverview ? '핵심 내용' : '파인만 기법으로 쉽게 이해하기')
  setTabLabel('lineage', isOverview ? '문서 구조' : '계보')
  setTabLabel('feynman', isOverview ? '핵심 내용' : '쉽게 이해하기')
}

function renderPrimerContent(doc, data, mode) {
  const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
  const isOverview = data.document_overview === true
  setPrimerModeCopy(isOverview)
  primerTitle.textContent = displayTitle
  if (primerEyebrow) primerEyebrow.textContent = isOverview ? '문서 개요' : '읽기 전 브리핑'

  if (data.hook) {
    renderPrimerRichText(primerHookText, data.hook)
    primerHookSection.classList.remove('hidden')
  } else {
    primerHookSection.classList.add('hidden')
  }

  const questions = data.questions || []
  primerQuestions.innerHTML = questions.map(q => `<li>${formatTranslationHtml(q)}</li>`).join('')
  primerQuestionsSection.classList.toggle('hidden', questions.length === 0)
  applyKatexToElement(primerQuestions)

  const checklist = data.checklist || []
  primerChecklist.innerHTML = checklist.map(c => `<li>${formatTranslationHtml(c)}</li>`).join('')
  primerChecklistSection.classList.toggle('hidden', checklist.length === 0)
  applyKatexToElement(primerChecklist)

  if (data.figure) {
    primerFigureImg.src = `/api/library/${doc.id}/primer-figure?ts=${Date.now()}`
    primerFigureSection.classList.remove('hidden')
  } else {
    primerFigureSection.classList.add('hidden')
  }

  renderPrimerLineage(data)
  renderPrimerFeynman(data)
  renderPrimerExperimentFlow(data)
  renderPrimerGlossary(data)
  renderPrimerCitationGraph(primerGraph, data.citation_graph, mode)

  switchPrimerTab('overview')
}

// 재생성 버튼 클릭 시 현재 보고 있던 문서/모드로 다시 로드할 수 있도록 기억해둔다.
let primerCurrentDoc = null
let primerCurrentMode = 'gate'

function _loadPrimerInto(doc, mode, dataPromise) {
  // 이미 캐시된 브리핑은 fetch가 수십~수백ms 안에 끝나는 경우가 많다. 그때마다
  // 로딩 화면을 곧장 띄웠다 지우면 눈 깜짝할 사이에 스피너가 번쩍이는 flicker로
  // 보인다. 응답이 실제로 늦어질 때만(200ms 초과) 로딩 상태를 노출한다.
  let settled = false
  const loadingTimer = window.setTimeout(() => {
    if (settled) return
    primerLoading.classList.remove('hidden')
    primerError.classList.add('hidden')
    primerBody.classList.add('hidden')
  }, 200)

  return dataPromise
    .then(data => {
      settled = true
      window.clearTimeout(loadingTimer)
      renderPrimerContent(doc, data, mode)
      primerLoading.classList.add('hidden')
      primerError.classList.add('hidden')
      primerBody.classList.remove('hidden')
    })
    .catch(err => {
      settled = true
      window.clearTimeout(loadingTimer)
      console.error('브리핑 로드 실패:', err)
      primerLoading.classList.add('hidden')
      primerBody.classList.add('hidden')
      primerError.classList.remove('hidden')
    })
}

async function showPrimerModal(doc, { mode = 'gate' } = {}) {
  primerCurrentDoc = doc
  primerCurrentMode = mode
  return new Promise((resolve) => {
    primerResolve = resolve
    openOverlayModal(primerModal)
    primerSkipBtn.classList.toggle('hidden', mode !== 'gate')
    primerContinueBtn.textContent = mode === 'gate' ? '읽으러 가기' : '닫기'

    const targetLang = getTranslationOptions().targetLang
    const isOverview = (doc.document_mode || state.currentDocumentMode) === 'general'
    setPrimerModeCopy(isOverview)
    if (primerEyebrow) primerEyebrow.textContent = isOverview ? '문서 개요' : '읽기 전 브리핑'
    _loadPrimerInto(doc, mode, fetchPrimer(doc.id, targetLang))
  })
}

async function regenerateCurrentPrimer() {
  if (!primerCurrentDoc || (primerRegenerateBtn && primerRegenerateBtn.disabled)) return
  const doc = primerCurrentDoc
  const mode = primerCurrentMode
  const targetLang = getTranslationOptions().targetLang

  if (primerRegenerateBtn) {
    primerRegenerateBtn.disabled = true
    primerRegenerateBtn.classList.add('is-loading')
  }
  try {
    await regeneratePrimer(doc.id, targetLang)
    await _loadPrimerInto(doc, mode, fetchPrimer(doc.id, targetLang))
  } catch (err) {
    console.error('브리핑 재생성 실패:', err)
    primerLoading.classList.add('hidden')
    primerError.classList.remove('hidden')
  } finally {
    if (primerRegenerateBtn) {
      primerRegenerateBtn.disabled = false
      primerRegenerateBtn.classList.remove('is-loading')
    }
  }
}

if (primerRegenerateBtn) primerRegenerateBtn.addEventListener('click', regenerateCurrentPrimer)
if (primerCloseBtn) primerCloseBtn.addEventListener('click', hidePrimerModal)
if (primerSkipBtn) primerSkipBtn.addEventListener('click', hidePrimerModal)
if (primerContinueBtn) primerContinueBtn.addEventListener('click', hidePrimerModal)
if (primerModal) {
  primerModal.addEventListener('click', (e) => {
    if (e.target === primerModal) hidePrimerModal()
  })
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && primerModal && !primerModal.classList.contains('hidden')) {
    hidePrimerModal()
  }
})
if (viewerPrimerBtn) {
  viewerPrimerBtn.addEventListener('click', () => {
    if (!state.currentDocId) return
    showPrimerModal(
      { id: state.currentDocId, metadata: state.currentDocMetadata, filename: state.filename, document_mode: state.currentDocumentMode },
      { mode: 'toolbar' }
    )
  })
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
        // Figure/Table 라벨은 documentImages가 로드되어야 알 수 있으므로,
        // 이미 렌더링된 페이지들의 본문 참조 오버레이도 여기서 함께 다시 그린다.
        renderFigureRefOverlayLayer(textLayerDiv, pageNum)
      }
    })
  } catch (e) {
    console.warn("이미지 좌표 로드 실패:", e)
    state.documentImages = []
  }
}

async function loadDocumentReferences(docId) {
  try {
    const refRes = await fetchLibraryReferences(docId)
    state.referenceMap = refRes.references || {}
    state.citationStyle = detectCitationStyle(state.referenceMap)

    // 이미 렌더링되어 있는 페이지들의 인용 오버레이 갱신
    document.querySelectorAll('.textLayer').forEach(textLayerDiv => {
      const pageWrapper = textLayerDiv.closest('.pdf-page-wrapper')
      if (pageWrapper) {
        const pageNum = parseInt(pageWrapper.dataset.page)
        renderCitationOverlayLayer(textLayerDiv, pageNum)
      }
    })
  } catch (e) {
    console.warn("참고문헌 목록 로드 실패:", e)
    state.referenceMap = {}
    state.citationStyle = null
  }
}

// location.hash 대입은 브라우저에 따라 popstate와 hashchange를 둘 다 발생시켜,
// 두 리스너가 각각 handleRouting()을 호출하면서 openFromLibrary가 같은 문서에
// 대해 중복 실행되는 경쟁 조건이 있었다(state.sessionId는 함수 맨 앞에서 동기적으로
// 설정되지만 viewerScreen이 active가 되는 시점은 그보다 한참 뒤라서, 두 번째 호출이
// 라우터의 "이미 열려있는 문서면 스킵" 가드를 통과해버림). 그 결과 채팅 히스토리가
// 두 번 렌더링되는 등의 중복 문제가 생겼다. 비교 화면의 openCompareScreen에 적용한
// 것과 동일한 패턴으로, 같은 문서를 여는 재진입 호출을 걸러낸다.
let docOpeningId = null

// 하이라이트/메모는 localStorage가 원본이고 서버 저장은 다중 기기 동기화를
// 위한 best-effort 백업일 뿐이다. 로컬에 이미 데이터가 있으면(가장 흔한
// 케이스: 같은 브라우저에서 계속 쓰던 문서) 절대 덮어쓰지 않고, 로컬에 해당
// 키가 아예 없을 때만(다른 브라우저/설치에서 처음 여는 경우) 서버 데이터를
// 채워 넣는다 - 병합 로직 없음, 로컬이 있으면 항상 로컬이 우선한다. 문서당
// 한 번만 시도하도록 마커를 남긴다(매번 열 때마다 재조회하지 않기 위함).
async function hydrateAnnotationsAndMemosFromServer(docId) {
  const marker = `easypaper_hydrated_${docId}`
  if (localStorage.getItem(marker)) return
  try {
    if (!localStorage.getItem(`easypaper_annotations_${docId}`)) {
      const server = await fetchLibraryAnnotations(docId).catch(() => null)
      if (server?.data && Object.keys(server.data).length) {
        localStorage.setItem(`easypaper_annotations_${docId}`, JSON.stringify(server.data))
      }
    }
    if (!localStorage.getItem(`easypaper_memos_${docId}`)) {
      const server = await fetchLibraryMemos(docId).catch(() => null)
      if (server?.data && Object.keys(server.data).length) {
        localStorage.setItem(`easypaper_memos_${docId}`, JSON.stringify(server.data))
      }
    }
  } finally {
    localStorage.setItem(marker, '1')
  }
}

async function openFromLibrary(doc, shouldPushState = true) {
  await loadFeatureNamespaces('viewer')
  if (docOpeningId === doc.id) return
  docOpeningId = doc.id
  try {
    // 이전 문서에서 진행 중이던 채팅 스트림이 있으면 반드시 먼저 취소한다.
    // 이 함수는 popstate/hashchange 라우팅(handleRouting)에서 resetState()를
    // 거치지 않고 직접 호출될 수 있어서, 취소하지 않으면 이전 문서의 스트림
    // 응답이 뒤늦게 도착해 방금 초기화한 새 문서의 state.chatHistory/DOM에
    // 섞여 들어가는 경쟁 조건이 있었다.
    if (state.chatActiveStream) { state.chatActiveStream(); state.chatActiveStream = null }

    if (shouldPushState) {
      history.pushState({ screen: 'viewer', docId: doc.id }, '', `#viewer?id=${doc.id}`)
    }
    state.sessionId  = doc.id
    allMemosHidden = loadAllMemosHiddenState(doc.id)
    updateMemosHideAllBtnUI()
    loadDocumentImages(doc.id)
    loadDocumentReferences(doc.id)
    state.filename   = doc.filename
    state.currentDocId = doc.id
    state.currentDocMetadata = doc.metadata || {}
    state.currentDocumentMode = doc.document_mode || "research"
    applyModeViewerSettings(state.currentDocumentMode)
    state.currentDocumentType = doc.document_type || "research_paper"
    state.sourceLanguage = doc.source_language || "auto"
    state.detectedSourceLanguage = doc.detected_source_language || "und"
    state.preferredTargetLanguage = doc.preferred_target_language || null
    state.processingPolicy = doc.processing_policy || "inherit"
    state.processingStatus = doc.processing || null
    populateLanguageControls()

    // 읽기 전 브리핑 게이팅: 설정에서 껐거나 이미 이 문서의 브리핑을 본 적
    // 있으면 건너뛴다. primer_shown 필드 자체가 없는 구버전 문서(이 기능
    // 배포 전 업로드분)는 "이미 열람한 적 있는지"(독서완료 표시 또는 마지막
    // 읽던 페이지 존재)로 판단해, 이미 여러 번 읽은 논문에 갑자기 브리핑이
    // 뜨지 않도록 그 자리에서 primer_shown을 백필한다.
    const isResearchDocument = (doc.document_mode || "research") === "research"
    if (outlineToggleBtn) outlineToggleBtn.title = isResearchDocument ? '논문 목차 보기' : '문서 목차 보기'
    if (viewerPrimerBtn) {
      viewerPrimerBtn.classList.toggle('hidden', isResearchDocument && state.disablePrimer)
      viewerPrimerBtn.title = isResearchDocument ? '읽기 전 브리핑 다시 보기' : '문서 개요 보기'
    }
    if (!state.disablePrimer && isResearchDocument) {
      const meta = state.currentDocMetadata
      const alreadyShown = meta.primer_shown === true
      if (!alreadyShown) {
        const alreadyOpenedBefore = meta.read === true || Number.isInteger(meta.last_page)
        if (alreadyOpenedBefore) {
          state.currentDocMetadata.primer_shown = true
          updateLibraryDocMetadata(doc.id, { primer_shown: true }).catch(() => {})
        } else {
          const gateResult = await showPrimerModal(doc, { mode: 'gate' })
          state.currentDocMetadata.primer_shown = true
          updateLibraryDocMetadata(doc.id, { primer_shown: true }).catch(() => {})
          // 브리핑의 인용 그래프에서 내 라이브러리의 다른 논문으로 바로 이동한
          // 경우 - 지금 열던 이 문서(doc)는 아직 로딩을 시작하지도 않았으므로
          // 이어서 로딩하지 않고, 대신 그 논문을 새로 연다 (finally에서
          // docOpeningId가 정리된 뒤에 호출해야 재진입 가드에 걸리지 않는다).
          if (gateResult && gateResult.redirect) {
            docOpeningId = null
            return openFromLibrary(gateResult.redirect)
          }
        }
      }
    }

    // 이 지점 이후로는 gating 리다이렉트 없이 실제로 이 문서를 열 것이 확정된
    // 상태다. loadAnnotations/loadMemos가 이 문서 데이터를 처음 읽기 전에
    // (아래 loadPDF에서 페이지를 렌더링하며 바로 참조한다) 서버 미러 데이터를
    // 먼저 끌어와야 다른 기기에서 저장한 하이라이트/메모가 반영된다.
    await hydrateAnnotationsAndMemosFromServer(doc.id)

    // 논문을 여는 시점 자체를 "마지막으로 읽은 시각"으로 기록한다(fire-and-forget).
    // 스크롤로 페이지가 바뀔 때만 last_read_at이 갱신되면, 열자마자 바로 나가거나
    // (이 fix 이전에 이미 last_page가 있던 예전 문서처럼) 페이지 이동이 없는
    // 경우 대시보드 "최근 읽은 논문"의 날짜가 계속 업로드 시각에 머물러 있었다.
    state.currentDocMetadata.last_read_at = new Date().toISOString()
    updateLibraryDocMetadata(doc.id, { last_read_at: state.currentDocMetadata.last_read_at }).catch(() => {})

    if (viewerReadToggleBtn) {
      const isRead = state.currentDocMetadata.read === true
      const readLabel = viewerReadToggleBtn.querySelector('.read-btn-text')
      if (readLabel) readLabel.textContent = isResearchDocument ? '독서 완료' : '읽기 완료'
      viewerReadToggleBtn.classList.toggle('active', isRead)
    }
    const displayTitle = (doc.metadata && doc.metadata.title) ? doc.metadata.title : doc.filename
    state.title      = displayTitle
    state.totalPages = doc.total_pages
    state.translationCache = {}
    state.translationSentences = {}
    state.translatingPages = new Set()
    state.pageInsightCache = {}
    // 번역이 완료된 페이지 번호만 기록하고 번역본 로드는 lazy-load에 위임
    state.translatedPages  = new Set(doc.translated_pages || [])

    // 채팅 내역 초기화
    state.chatHistory = []
    chatMessages.innerHTML = buildChatWelcomeHtml()

    // 채팅 기록 조회는 PDF 로딩과 서로 무관한 별개의 요청이므로, 기다리지 않고
    // 병렬로 시작해 전체 대기 시간을 줄인다 (완료되면 아래에서 반영).
    const chatHistoryPromise = getChatHistoryAPI(doc.id).catch(err => {
      console.error('채팅 기록 로드 실패:', err)
      return null
    })

    await loadPDF(`/api/library/${doc.id}/pdf`)
    docTitle.textContent  = displayTitle
    docTitle.title        = doc.filename
    if (viewerDocumentTypeChip) {
      const docMode = doc.document_mode || "research"
      viewerDocumentTypeChip.className = `document-type-chip ${docMode}`
      viewerDocumentTypeChip.textContent = workspaceModeController.getTypeLabel(docMode, doc.document_type || "research_paper")
    }
    renderViewerProcessingBadge(doc.processing)
    pageTotal.textContent = `/ ${doc.total_pages}`
    pageInput.max   = doc.total_pages

    // 책갈피: 설정에서 끄지 않았고 마지막으로 읽던 위치가 저장되어 있으면 그 페이지로,
    // 아니면 1페이지로
    const savedLastPage = state.disableBookmark ? null : doc.metadata?.last_page
    const restorePage = (Number.isInteger(savedLastPage) && savedLastPage >= 1 && savedLastPage <= doc.total_pages)
      ? savedLastPage
      : 1
    pageInput.value = restorePage
    state.currentPage = restorePage

    showViewer()
    hideOutlineSidebar()

    // PDF가 로드된 뒤에만 가능한 두 작업(페이지 렌더링, 목차 조회)은 서로 무관하므로
    // 병렬로 실행한다 - 이전에는 순차 실행이라 두 작업 시간이 그대로 더해졌었다.
    await Promise.all([
      (async () => {
        await initScrollViewer()
        if (restorePage > 1) {
          scrollToPage(viewerScrollContainer, restorePage, { instant: true })
        }
      })(),
      loadPDFOutline(),
    ])

    // 채팅 기록 반영 (PDF 로딩과 병렬로 이미 완료됐을 가능성이 높음)
    // 주의: 변수명을 "history"로 쓰면 이 함수 맨 위에서 쓰는 전역 history(window.history)
    // 객체를 가려버려("Cannot access 'history' before initialization") 함수 전체가
    // 조용히 실패하므로 반드시 다른 이름을 사용해야 한다.
    const chatRes = await chatHistoryPromise
    const chatHistoryList = chatRes?.history || []
    if (chatHistoryList.length > 0) {
      for (const msg of chatHistoryList) {
        state.chatHistory.push({ role: msg.role, content: msg.content })
        const isAssistant = msg.role === 'assistant'
        let renderedContent = isAssistant ? formatChatHtml(msg.content) : formatUserChatHtml(msg.content)
        if (isAssistant && msg.stale) {
          renderedContent = `<span class="chat-stale-revision-badge">${t("chat:staleRevision")}</span>${renderedContent}`
        }
        const messageElement = appendChatMessage(msg.role, renderedContent, true)
        if (isAssistant && msg.evidence?.length) {
          attachEvidenceToBubble(messageElement.querySelector(".message-bubble"), msg.evidence)
        }
        if (isAssistant && msg.verification) {
          renderVerificationBadge(messageElement, msg.verification)
        }
      }

      // 마지막 답변이 여전히 어시스턴트 것이라면(그 뒤로 새 질문을 보내지
      // 않았다면) 새로고침 전에 붙어 있던 추천 질문 칩을 캐시에서 복원한다.
      const lastMsg = chatHistoryList[chatHistoryList.length - 1]
      if (lastMsg.role === 'assistant') {
        const cachedQuestions = loadSuggestedQuestionsCache(doc.id)
        if (cachedQuestions?.length) {
          renderSuggestedQuestionChips(chatMessages.lastElementChild, cachedQuestions)
        }
      }
    }
  } finally {
    if (docOpeningId === doc.id) docOpeningId = null
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// PDF 원문에서 볼드로 표시된 구간은 backend(pdf_parser.py의 _spans_to_bold_markdown)가
// 마크다운(**...**)으로 감싸서 넘겨준다 - Figure/Table 캡션, 참고문헌 원문 등
// 오버레이 툴팁에 원문 그대로의 볼드 서식을 되살릴 때 이 함수로 변환한다.
// (formatTranslationHtml과 동일하게 escapeHtml 이후에 ** -> <strong> 치환)
function renderBoldText(str) {
  return escapeHtml(str).replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
}

// marked.parse()는 마크다운 소스에 섞인 raw HTML(<script>, onerror= 등)을 그대로
// 통과시킨다. AI 채팅 응답/메모/체인지로그처럼 우리가 직접 작성하지 않은 텍스트를
// marked로 렌더링한 뒤 innerHTML에 꽂아넣는 모든 지점에서는, 악성 PDF의
// 프롬프트 인젝션으로 LLM이 <script>/onerror= 같은 태그를 그대로 재생산해
// same-origin XSS로 이어질 수 있다(세션 쿠키는 HttpOnly라 못 훔쳐도, 로그인된
// 사용자 권한으로 API 키 조회·계정 변경 등을 그대로 수행 가능). 이를 막기 위해
// marked 출력은 반드시 DOMPurify로 한 번 걸러낸 뒤에만 innerHTML에 대입한다.
function sanitizeMarkedHtml(html) {
  return DOMPurify.sanitize(html)
}

function setLibraryAddMenuOpen(open) {
  const wrap = document.querySelector('.lib-add-fab-wrap')
  if (!wrap) return
  wrap.classList.toggle('open', open)
  libUploadBtn.setAttribute('aria-expanded', String(open))
  const labelKey = open ? 'common:addMenu.close' : 'common:addMenu.open'
  const label = open ? t('common:addMenu.close') : t('common:addMenu.open')
  libUploadBtn.dataset.i18nAriaLabel = labelKey
  libUploadBtn.setAttribute('aria-label', label)
}
libUploadBtn.addEventListener('click', () => setLibraryAddMenuOpen(!document.querySelector('.lib-add-fab-wrap')?.classList.contains('open')))
$('lib-add-paper-btn')?.addEventListener('click', () => { setLibraryAddMenuOpen(false); fileInput.click() })
$('lib-add-folder-btn')?.addEventListener('click', () => { setLibraryAddMenuOpen(false); openCreateFolderDialog() })

// ── 테마 토글 기능 ──────────────────────────────

// Tauri 데스크탑 창의 타이틀바(테마)와 배경색을 앱의 라이트/다크 토글과 맞춘다.
// 웹 배포에서는 window.__TAURI_INTERNALS__가 없어 isTauriDesktop이 항상
// false라 이 함수가 조용히 아무 일도 하지 않는다 - 동일한 frontend/dist를
// 웹/데스크탑에 그대로 재사용하기 위함(별도 빌드 분기 없음).
const LIGHT_THEME_BG = '#f8fafc'
const DARK_THEME_BG = '#06050a'

async function syncDesktopWindowTheme(isLight) {
  if (!isTauriDesktop) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    await win.setTheme(isLight ? 'light' : 'dark')
    await win.setBackgroundColor(isLight ? LIGHT_THEME_BG : DARK_THEME_BG)
  } catch (err) {
    console.warn('데스크탑 타이틀바 테마 동기화 실패:', err)
  }
}

function initTheme() {
  const savedTheme = getModeSetting('theme', workspaceModeController.getMode())
  const isLight = savedTheme === 'light'
  document.body.classList.toggle('light-theme', isLight)
  updateThemeIcons(isLight)
  syncDesktopWindowTheme(isLight)
}

function toggleTheme() {
  const mode = workspaceModeController.getMode()
  const isLight = document.body.classList.toggle('light-theme')
  setModeSetting('theme', mode, isLight ? 'light' : 'dark')
  updateThemeIcons(isLight)
  applyAccentColor(currentAccentColor, { persist: false })
  showToast(isLight ? t('settings:themeLightEnabled') : t('settings:themeDarkEnabled'), 'success')
  syncDesktopWindowTheme(isLight)
}

function updateThemeIcons(isLight) {
  const sunIcons = document.querySelectorAll('.sun-icon')
  const moonIcons = document.querySelectorAll('.moon-icon')
  sunIcons.forEach(icon => icon.classList.toggle('hidden', !isLight))
  moonIcons.forEach(icon => icon.classList.toggle('hidden', isLight))
}

const themeToggleBtn = $('theme-toggle-btn')
const globalThemeToggleBtn = $('global-theme-toggle-btn')
const sidebarThemeToggleBtn = $('sidebar-theme-toggle-btn')

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', toggleTheme)
}
if (globalThemeToggleBtn) {
  globalThemeToggleBtn.addEventListener('click', toggleTheme)
}
if (sidebarThemeToggleBtn) {
  sidebarThemeToggleBtn.addEventListener('click', toggleTheme)
}

// 초기 테마 적용
initTheme()

// ── 테마 색상(강조색) 커스터마이징 ──────────────────────────────
const DEFAULT_ACCENT_COLOR = '#2563eb'
const ACCENT_PRESETS = [
  { name: '강한 블루', hex: '#2563eb' },
  { name: '딥 틸',     hex: '#1f8a8c' },
  { name: '에메랄드',   hex: '#1c9c6b' },
  { name: '인디고',    hex: '#5457b8' },
  { name: '코랄 로즈',  hex: '#e0677a' },
  { name: '터콰이즈',   hex: '#17a2b8' },
  { name: '플럼',      hex: '#9c4f96' },
  { name: '오커 클레이', hex: '#c08a45' },
]

let currentAccentColor = DEFAULT_ACCENT_COLOR

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
function rgbToHex(r, g, b) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)))
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('')
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return { h, s, l }
}
function hslToRgb(h, s, l) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: hue2rgb(p, q, h + 1 / 3) * 255,
    g: hue2rgb(p, q, h) * 255,
    b: hue2rgb(p, q, h - 1 / 3) * 255,
  }
}
// 기준 색상의 명도(lightness)만 delta만큼 옮긴 색상 반환 (그라데이션/텍스트 톤 파생용)
function shadeHex(hex, lightnessDelta) {
  const { r, g, b } = hexToRgb(hex)
  const hsl = rgbToHsl(r, g, b)
  hsl.l = Math.max(0.08, Math.min(0.92, hsl.l + lightnessDelta))
  const rgb = hslToRgb(hsl.h, hsl.s, hsl.l)
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

function deriveAccentTokens(baseHex) {
  const base = hexToRgb(baseHex)
  const fromHex = shadeHex(baseHex, -0.16)
  const toHex = shadeHex(baseHex, 0.18)
  const fromRgb = hexToRgb(fromHex)
  return {
    from: fromHex,
    to: toHex,
    glow: `rgba(${base.r}, ${base.g}, ${base.b}, 0.3)`,
    controlSoft: `rgba(${base.r}, ${base.g}, ${base.b}, 0.16)`,
    textDark: shadeHex(baseHex, 0.24),   // 다크 테마에서 태그 텍스트로 쓸 밝은 톤
    textLight: shadeHex(baseHex, -0.24), // 라이트 테마에서 태그 텍스트로 쓸 어두운 톤
    borderGlowDark: `rgba(${base.r}, ${base.g}, ${base.b}, 0.2)`,
    borderGlowLight: `rgba(${fromRgb.r}, ${fromRgb.g}, ${fromRgb.b}, 0.1)`,
  }
}

function applyAccentColor(hex, { persist = true } = {}) {
  const tokens = deriveAccentTokens(hex)
  const root = document.documentElement.style
  root.setProperty('--accent-from', tokens.from)
  root.setProperty('--accent-mid', hex)
  root.setProperty('--accent-to', tokens.to)
  root.setProperty('--accent-glow', tokens.glow)
  root.setProperty('--control-accent-soft', tokens.controlSoft)

  const isLight = document.body.classList.contains('light-theme')
  document.body.style.setProperty('--control-accent-text', isLight ? tokens.textLight : tokens.textDark)
  document.body.style.setProperty('--border-glow', isLight ? tokens.borderGlowLight : tokens.borderGlowDark)

  currentAccentColor = hex
  if (persist) setModeSetting('accentColor', workspaceModeController.getMode(), hex)
  updateAccentSettingsUI(hex)
}

function updateAccentSettingsUI(hex) {
  if (settingAccentPicker) settingAccentPicker.value = hex
  if (settingAccentHex) settingAccentHex.textContent = hex.toUpperCase()
  if (settingAccentSwatches) {
    settingAccentSwatches.querySelectorAll('.accent-swatch').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.hex.toLowerCase() === hex.toLowerCase())
    })
  }
}

function renderAccentSwatches() {
  if (!settingAccentSwatches) return
  settingAccentSwatches.innerHTML = ACCENT_PRESETS.map(p => `
    <button type="button" class="accent-swatch" data-hex="${p.hex}" title="${p.name}" style="background:${p.hex}"></button>
  `).join('')
  settingAccentSwatches.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.addEventListener('click', () => applyAccentColor(btn.dataset.hex))
  })
}
renderAccentSwatches()

if (settingAccentPicker) {
  settingAccentPicker.addEventListener('input', () => applyAccentColor(settingAccentPicker.value))
}
if (settingAccentResetBtn) {
  settingAccentResetBtn.addEventListener('click', () => applyAccentColor(DEFAULT_ACCENT_COLOR))
}

function initAccentColor() {
  const saved = getModeSetting('accentColor', workspaceModeController.getMode())
  applyAccentColor(saved, { persist: false })
}
initAccentColor()

function applyModeTheme(mode) {
  const normalizedMode = normalizeSettingsMode(mode)
  const isLight = getModeSetting('theme', normalizedMode) === 'light'
  document.body.classList.toggle('light-theme', isLight)
  updateThemeIcons(isLight)
  applyAccentColor(getModeSetting('accentColor', normalizedMode), { persist: false })
  syncDesktopWindowTheme(isLight)
}

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
// localStorage 쓰기는 항상 동기로 즉시 수행하고(이 함수의 호출부 다수가
// mousemove/keydown 같은 동기 이벤트 핸들러라 async로 바꾸면 입력 지연이
// 생긴다), 서버 미러 동기화는 디바운스해 fire-and-forget으로 보낸다. 서버는
// 항상 전체 블롭을 덮어쓰므로(시퀀스 번호 불필요) 마지막에 도착한 요청이
// 이기고 다음 저장 때 자연히 정합성이 맞춰진다.
const _annotationMirrorTimers = {}
function saveAnnotations(sessionId, annotations) {
  localStorage.setItem(`easypaper_annotations_${sessionId}`, JSON.stringify(annotations))
  if (!sessionId) return
  clearTimeout(_annotationMirrorTimers[sessionId])
  _annotationMirrorTimers[sessionId] = setTimeout(() => {
    delete _annotationMirrorTimers[sessionId]
    putLibraryAnnotations(sessionId, annotations).catch(err => console.warn('서버 동기화 실패(로컬은 유지됨):', err))
  }, 1000)
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
    color: chosenColor,
    createdAt: new Date().toISOString()
  })
  saveAnnotations(state.sessionId, annotations)
  globalAnalyticsTracker.trackInteraction(type, pageNum)
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

  if (sentenceIdx >= 10000) {
    pdfIdx = sentenceIdx;
    transIdx = -1;
    pdfElements = pdfSpans.filter(el => parseInt(el.dataset.sentenceIdx || '0', 10) === sentenceIdx);
    return { pdfIdx, transIdx, pdfElements };
  }

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

  // pdfIdx에 매핑되는 모든 PDF span 엘리먼트 수집 (비파괴 시스템에서는 빈 배열일 수 있음)
  pdfElements = pdfSpans.filter(el => parseInt(el.dataset.sentenceIdx || '0', 10) === pdfIdx);

  // VTM 브릿지: 가상 텍스트 맵에서 sentenceRange도 함께 반환하여 어노테이션 시스템 지원
  let sentenceRange = null;
  const vtmRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum];
  if (vtmRanges) {
    sentenceRange = vtmRanges.find(r => {
      const idx = r.sentenceIdx >= 10000 ? (r.originalSentenceIdx ?? r.sentenceIdx) : r.sentenceIdx;
      return idx === pdfIdx;
    }) || null;
  }

  return { pdfIdx, transIdx, pdfElements, sentenceRange };
}

// 커스텀 다이얼로그 확인 모달 유틸리티
function showCustomConfirm(message, { title = '확인', confirmText = '확인', cancelText = '취소', danger = true } = {}) {
  return new Promise((resolve) => {
    const modal = document.createElement('div')
    modal.className = 'custom-confirm-modal-wrapper'

    const iconHtml = danger
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-mid)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;

    const confirmBtnClass = danger ? 'custom-confirm-btn confirm-btn' : 'custom-confirm-btn confirm-btn primary-btn';

    modal.innerHTML = `
      <div class="custom-confirm-modal">
        <div class="custom-confirm-modal-header">
          ${iconHtml}
          <span class="custom-confirm-modal-title">${title}</span>
        </div>
        <div class="custom-confirm-modal-body">
          ${message.replace(/\n/g, '<br>')}
        </div>
        <div class="custom-confirm-modal-footer">
          <button class="custom-confirm-btn cancel-btn">${cancelText}</button>
          <button class="${confirmBtnClass}">${confirmText}</button>
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

// ── 채팅 인용 이미지 로컬 영속화 ─────────────────────────
// 채팅 메시지 자체(백엔드 DB)에는 "[인용된 이미지 (Page N)]" 같은 텍스트
// placeholder만 저장되고 실제 이미지(base64)는 저장되지 않는다 - 그 결과
// 새로고침/재접속 후 히스토리를 다시 불러오면 인용했던 이미지가 사라지고
// placeholder 텍스트만 남는 문제가 있었다. 이미지 자체는 여기(로컬
// 스토리지, annotations/memos와 동일한 문서별 키 패턴)에 별도 보관해두고,
// 히스토리 렌더링 시 메시지에 함께 저장해둔 참조 ID로 다시 찾아 복원한다
// (같은 브라우저에서 새로고침하는 일반적인 경우는 커버되고, 다른 기기/
// 브라우저에서 열거나 로컬 스토리지가 지워진 경우엔 기존과 동일하게
// placeholder만 보인다 - 완전한 서버측 보관은 이번 범위 밖).
const CHAT_QUOTE_IMAGE_MAX_ENTRIES = 20

function loadChatQuoteImages(sessionId) {
  if (!sessionId) return {}
  try {
    return JSON.parse(localStorage.getItem(`easypaper_chat_quote_images_${sessionId}`)) || {}
  } catch (e) {
    return {}
  }
}

function saveChatQuoteImage(sessionId, quoteId, base64Img) {
  if (!sessionId) return
  try {
    const images = loadChatQuoteImages(sessionId)
    images[quoteId] = base64Img
    // quoteId 자체에 타임스탬프가 앞에 붙어 있어 문자열 정렬 = 시간 순 정렬
    const keys = Object.keys(images).sort()
    if (keys.length > CHAT_QUOTE_IMAGE_MAX_ENTRIES) {
      keys.slice(0, keys.length - CHAT_QUOTE_IMAGE_MAX_ENTRIES).forEach(k => delete images[k])
    }
    localStorage.setItem(`easypaper_chat_quote_images_${sessionId}`, JSON.stringify(images))
  } catch (e) {
    console.warn('인용 이미지 로컬 저장 실패:', e)
  }
}

function getChatQuoteImage(sessionId, quoteId) {
  if (!sessionId || !quoteId) return null
  return loadChatQuoteImages(sessionId)[quoteId] || null
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

const _memoMirrorTimers = {}
function saveMemos(sessionId, memos) {
  if (!sessionId) return
  const key = `easypaper_memos_${sessionId}`
  localStorage.setItem(key, JSON.stringify(memos))
  clearTimeout(_memoMirrorTimers[sessionId])
  _memoMirrorTimers[sessionId] = setTimeout(() => {
    delete _memoMirrorTimers[sessionId]
    putLibraryMemos(sessionId, memos).catch(err => console.warn('서버 동기화 실패(로컬은 유지됨):', err))
  }, 1000)
}

// ── 하이라이트/밑줄/메모 삭제 실행취소(Ctrl+Z) ──────────────────────
// 삭제 직후 일정 시간 안에는 Ctrl+Z로 되살릴 수 있도록 최근 삭제 내역을 스택으로 보관한다.
const ANNOTATION_UNDO_WINDOW_MS = 8000
let annotationUndoStack = []

function pushAnnotationUndo(action) {
  annotationUndoStack.push({ ...action, expiresAt: Date.now() + ANNOTATION_UNDO_WINDOW_MS })
  if (annotationUndoStack.length > 20) annotationUndoStack.shift()
}

// 만료되지 않은 가장 최근 삭제 내역을 꺼낸다 (만료된 항목은 버리고 계속 탐색)
function popValidAnnotationUndo() {
  const now = Date.now()
  while (annotationUndoStack.length) {
    const action = annotationUndoStack.pop()
    if (action.expiresAt >= now) return action
  }
  return null
}

// 삭제됐던 어노테이션(하이라이트/밑줄) 배열을 스토리지에 되돌려 넣는다
function restoreAnnotationItems(pageNum, items) {
  if (!items || items.length === 0) return
  const annotations = loadAnnotations(state.sessionId)
  if (!annotations[`page_${pageNum}`]) annotations[`page_${pageNum}`] = []
  annotations[`page_${pageNum}`].push(...items)
  saveAnnotations(state.sessionId, annotations)
}

// 삭제됐던 메모 배열을 스토리지에 되돌려 넣는다 (연타 등으로 이미 복원된 항목은 건너뜀)
function restoreMemoItems(pageNum, memos) {
  if (!memos || memos.length === 0) return
  const allMemosObj = loadMemos(state.sessionId)
  const pageMemos = allMemosObj[`page_${pageNum}`] || []
  memos.forEach(m => {
    if (!pageMemos.some(pm => pm.id === m.id)) pageMemos.push(m)
  })
  allMemosObj[`page_${pageNum}`] = pageMemos
  saveMemos(state.sessionId, allMemosObj)
}

function undoLastAnnotationAction() {
  const action = popValidAnnotationUndo()
  if (!action) return false

  const pageWrapper = viewerScrollContainer && viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${action.pageNum}"]`)
  const textLayerDiv = pageWrapper && pageWrapper.querySelector('.textLayer')

  if (action.kind === 'annotation') {
    restoreAnnotationItems(action.pageNum, action.items)
    if (textLayerDiv) reRenderPageAnnotations(textLayerDiv, action.pageNum)
    const label = action.items.length > 1 ? '어노테이션' : (action.items[0].type === 'highlight' ? '하이라이트' : '밑줄')
    showToast(`${label}가 복원되었습니다 ✓`, 'success')
  } else if (action.kind === 'memo') {
    restoreMemoItems(action.pageNum, [action.memo])
    renderPageMemos(action.pageNum)
    showToast('메모가 복원되었습니다 ✓', 'success')
  } else if (action.kind === 'clear') {
    restoreAnnotationItems(action.pageNum, action.items)
    restoreMemoItems(action.pageNum, action.memos)
    if (textLayerDiv) reRenderPageAnnotations(textLayerDiv, action.pageNum)
    else renderPageMemos(action.pageNum)
    showToast('삭제한 표시가 복원되었습니다 ✓', 'success')
  }
  return true
}

document.addEventListener('keydown', (e) => {
  const isUndoCombo = (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
  if (!isUndoCombo || annotationUndoStack.length === 0) return

  // 텍스트 입력 중(메모 편집 등)에는 브라우저 기본 실행취소를 방해하지 않는다
  const active = document.activeElement
  const isEditableTarget = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)
  if (isEditableTarget) return

  e.preventDefault()
  undoLastAnnotationAction()
})

// 툴바의 "전체 숨기기" 토글 - 개별 memo.hidden 필드와는 별개로, 문서를 보는 동안만
// 켜고 끄는 순수 화면 표시 상태(번역창 접기의 isTransPaneCollapsed와 동일한 패턴).
// 문서(세션)별로 마지막 상태를 기억해두되, 각 메모의 저장된 내용에는 손대지 않는다.
let allMemosHidden = false

function getAllMemosHiddenKey(sessionId) {
  return `easypaper_memos_all_hidden_${sessionId}`
}

function loadAllMemosHiddenState(sessionId) {
  if (!sessionId) return false
  return localStorage.getItem(getAllMemosHiddenKey(sessionId)) === 'true'
}

function updateMemosHideAllBtnUI() {
  if (!memosHideAllBtn) return
  memosHideAllBtn.classList.toggle('active', allMemosHidden)
  memosHideAllBtn.title = allMemosHidden
    ? '숨긴 메모 모두 표시'
    : '작성된 모든 메모 숨기기 (하이라이트만 표시)'
  const labelEl = memosHideAllBtn.querySelector('span')
  if (labelEl) labelEl.textContent = allMemosHidden ? '숨긴 메모 모두 표시' : '메모 숨기기'
}

function redrawAllPageMemos() {
  document.querySelectorAll('.pdf-page-wrapper').forEach(wrapper => {
    const pageNum = parseInt(wrapper.dataset.page, 10)
    if (!isNaN(pageNum)) renderPageMemos(pageNum)
  })
}

if (memosHideAllBtn) {
  memosHideAllBtn.addEventListener('click', () => {
    allMemosHidden = !allMemosHidden
    if (state.sessionId) {
      localStorage.setItem(getAllMemosHiddenKey(state.sessionId), String(allMemosHidden))
    }
    updateMemosHideAllBtnUI()
    redrawAllPageMemos()
    showToast(allMemosHidden ? '모든 메모가 숨겨졌습니다.' : '숨겼던 메모를 모두 표시합니다.', 'info')
  })
}

function updateMemoConnectorLine(pageWrapper, memo) {
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

  const sentenceIdx = memo.sentenceIdx
  const pageNum = parseInt(pageWrapper.dataset.page, 10)
  const pageRect = pageWrapper.getBoundingClientRect()

  // VTM 기반 앵커 좌표 계산 (비파괴 시스템 우선, 폴백은 .pdf-sentence 스팬)
  let anchorX = 0, anchorY = 0
  let foundCoords = false

  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
  const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum]
  const textLayerForConn = pageWrapper.querySelector('.textLayer')

  if (vtm && sentenceRanges && textLayerForConn) {
    // 사용자가 실제로 드래그해서 선택한 범위(charStart/charEnd)가 저장돼 있으면
    // 그 범위의 시작점을 앵커로 쓰고, 없으면(드웰 호버 등) 문장 전체로 대체한다.
    const hasExplicitRange = memo.charStart != null && memo.charEnd != null
    const sRange = hasExplicitRange
      ? { charStart: memo.charStart, charEnd: memo.charEnd }
      : sentenceRanges.find(r => {
          const idx = r.sentenceIdx >= 10000 ? (r.originalSentenceIdx ?? r.sentenceIdx) : r.sentenceIdx
          return idx === sentenceIdx || r.sentenceIdx === sentenceIdx
        })
    if (sRange) {
      const rects = getSentenceRects(sRange, vtm, textLayerForConn)
      if (rects.length > 0) {
        anchorX = rects[0].left
        anchorY = rects[0].top + rects[0].height / 2
        foundCoords = true
      }
    }
  }

  if (!foundCoords) {
    const sentenceEl = pageWrapper.querySelector(`.pdf-sentence[data-sentence-idx="${sentenceIdx}"]`)
    if (sentenceEl) {
      const { pdfElements } = getMappedElementsAndIndices(sentenceEl, pageNum, sentenceIdx)
      const startEl = (pdfElements && pdfElements.length > 0) ? pdfElements[0] : sentenceEl
      if (startEl) {
        const startRect = startEl.getBoundingClientRect()
        anchorX = startRect.left - pageRect.left
        anchorY = startRect.top - pageRect.top + startRect.height / 2
        foundCoords = true
      }
    }
  }

  if (!foundCoords) {
    path.setAttribute('d', '')
    return
  }

  const memoLeft = (memo.x / 100) * pageWrapper.offsetWidth
  const memoTop = (memo.y / 100) * pageWrapper.offsetHeight
  const memoEl = pageWrapper.querySelector(`.floating-memo[data-id="${memo.id}"]`)
  const memoWidth = memoEl ? memoEl.offsetWidth : (memo.width || 260)
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

  pageWrapper.querySelectorAll('.floating-memo').forEach(el => {
    el._memoResizeObserver?.disconnect()
    if (el._memoResizeSaveTimer) clearTimeout(el._memoResizeSaveTimer)
    el.remove()
  })
  const svg = pageWrapper.querySelector('.memo-connector-svg')
  if (svg) svg.innerHTML = ''

  // Clear any existing sentence has-memo highlights (VTM 오버레이 및 폴백 스팬)
  const overlay = pageWrapper.querySelector('.pdf-highlight-overlay')
  if (overlay) {
    clearOverlayBoxes(overlay, 'sentence-memo-box')
  }
  pageWrapper.querySelectorAll('.pdf-sentence-has-memo').forEach(el => {
    el.classList.remove('pdf-sentence-has-memo', 'pdf-sentence-has-memo-hidden')
    Array.from(el.classList).forEach(cls => {
      if (cls.startsWith('color-')) el.classList.remove(cls)
    })
    delete el.dataset.memoId
  })

  // 폴백(VTM 미사용) 경로에서 숨겨진 메모의 하이라이트 클릭 시 다시 보이기.
  // .pdf-sentence 스팬은 이 함수가 다시 호출돼도 파괴/재생성되지 않고 그대로
  // 남아있는 요소라, 매번 element에 직접 리스너를 추가하면 재렌더링될 때마다
  // 리스너가 계속 쌓인다. 그래서 pageWrapper 하나당 한 번만 위임 리스너를 걸고,
  // 클릭 시점에 최신 memo 목록을 다시 읽어서 처리한다.
  if (!pageWrapper.dataset.memoRevealBound) {
    pageWrapper.dataset.memoRevealBound = '1'
    pageWrapper.addEventListener('click', (e) => {
      const target = e.target.closest('.pdf-sentence-has-memo-hidden')
      if (!target || !target.dataset.memoId) return
      e.stopPropagation()
      const pNum = parseInt(pageWrapper.dataset.page, 10)
      const allMemosObj = loadMemos(state.sessionId)
      const memos = allMemosObj[`page_${pNum}`] || []
      const targetMemo = memos.find(m => m.id === target.dataset.memoId)
      if (targetMemo) {
        targetMemo.hidden = false
        saveMemos(state.sessionId, allMemosObj)
        renderPageMemos(pNum)
      }
    })
  }

  if (!state.sessionId) return
  const allMemos = loadMemos(state.sessionId)
  const pageMemos = allMemos[`page_${pageNum}`] || []

  pageMemos.forEach(memo => {
    // 개별 "숨기기"(memo.hidden) 또는 툴바의 "전체 숨기기"(allMemosHidden) 중
    // 하나라도 켜져 있으면 카드는 그리지 않고 PDF 본문의 하이라이트만 남긴다.
    // 전체 숨기기는 순수 화면 표시 상태라 하이라이트를 클릭해도 개별 메모만
    // 되살아나지 않도록, "클릭해서 다시 보이기"는 개별 숨김에만 적용한다.
    const isHiddenIndividually = !!memo.hidden
    const isHidden = isHiddenIndividually || allMemosHidden

    const revealHiddenMemo = () => {
      memo.hidden = false
      const allMemosObj = loadMemos(state.sessionId)
      allMemosObj[`page_${pageNum}`] = pageMemos
      saveMemos(state.sessionId, allMemosObj)
      renderPageMemos(pageNum)
    }

    // VTM 기반 메모 하이라이트 (비파괴 시스템) - 카드 표시 여부와 무관하게 항상 그린다
    const vtmForMemo = state.virtualTextMaps && state.virtualTextMaps[pageNum]
    const memoSentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum]
    let sentenceText = memo.sentenceText || ''

    if (vtmForMemo && memoSentenceRanges) {
      // 사용자가 실제로 드래그해서 선택한 범위(charStart/charEnd)가 저장돼 있으면
      // 그 범위를 그대로 쓰고, 없으면(드웰 호버 등 과거 방식) 문장 전체로 대체한다.
      const hasExplicitRange = memo.charStart != null && memo.charEnd != null
      const memoSRange = hasExplicitRange
        ? { charStart: memo.charStart, charEnd: memo.charEnd }
        : memoSentenceRanges.find(r => {
            const idx = r.sentenceIdx >= 10000 ? (r.originalSentenceIdx ?? r.sentenceIdx) : r.sentenceIdx
            return idx === memo.sentenceIdx
          })
      if (memoSRange) {
        sentenceText = vtmForMemo.fullText.substring(memoSRange.charStart, memoSRange.charEnd).trim()
        const memoTextLayer = pageWrapper.querySelector('.textLayer')
        if (memoTextLayer) {
          const memoOverlay = getOrCreateOverlay(pageWrapper)
          const memoRects = getSentenceRects(memoSRange, vtmForMemo, memoTextLayer)
          memoRects.forEach(r => {
            const box = document.createElement('div')
            const colorClass = `color-${memo.color || 'default'}`
            box.className = isHiddenIndividually
              ? `sentence-memo-box hidden-memo ${colorClass}`
              : `sentence-memo-box ${colorClass}`
            box.style.left = `${r.left}px`
            box.style.top = `${r.top}px`
            box.style.width = `${r.width}px`
            box.style.height = `${r.height}px`
            box.dataset.memoId = memo.id
            if (isHiddenIndividually) {
              box.title = '숨겨진 메모 다시 표시'
              box.addEventListener('click', (e) => { e.stopPropagation(); revealHiddenMemo() })
            }
            memoOverlay.appendChild(box)
          })
        }
      }
    } else {
      // 폴백: .pdf-sentence 스팬 기반
      const sentenceEl = pageWrapper.querySelector(`.pdf-sentence[data-sentence-idx="${memo.sentenceIdx}"]`)
      if (sentenceEl) {
        sentenceText = sentenceEl.textContent.trim()
        const { pdfElements } = getMappedElementsAndIndices(sentenceEl, pageNum, memo.sentenceIdx)
        if (pdfElements) {
          pdfElements.forEach(el => {
            el.classList.add('pdf-sentence-has-memo', `color-${memo.color || 'default'}`)
            el.dataset.memoId = memo.id
            if (isHiddenIndividually) {
              // 클릭 시 되살리기는 pageWrapper에 위임된 리스너(위 참고)가 처리한다 -
              // 이 요소는 재렌더링 때마다 파괴되지 않고 남아있어 직접 리스너를
              // 달면 호출될 때마다 중복으로 쌓이기 때문
              el.classList.add('pdf-sentence-has-memo-hidden')
              el.dataset.memoId = memo.id
              el.title = '숨겨진 메모 다시 표시'
            }
          })
        }
      }
    }

    if (isHidden) return // 카드/커넥터는 그리지 않고 하이라이트만 남긴다

    const memoEl = document.createElement('div')
    memoEl.className = `floating-memo color-${memo.color || 'default'}${memo.collapsed ? ' collapsed' : ''}`
    memoEl.setAttribute('data-id', memo.id)
    memoEl.style.left = `${memo.x}%`
    memoEl.style.top = `${memo.y}%`
    if (Number.isFinite(memo.width)) memoEl.style.width = `${memo.width}px`
    if (!memo.collapsed && Number.isFinite(memo.height)) memoEl.style.height = `${memo.height}px`

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
          updateMemoConnectorLine(pageWrapper, memo)
        })

        textarea.addEventListener('blur', () => {
          setTimeout(() => {
            const exists = memoEl.parentNode !== null
            if (exists) {
              isEditing = false
              updateCardContent()
              updateMemoConnectorLine(pageWrapper, memo)
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
            pushAnnotationUndo({ kind: 'memo', pageNum, memo })

            // 본문의 선택 영역 및 고정 하이라이트 지우기
            applyActiveHighlight(null, null)
            window.getSelection().removeAllRanges()

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
        body.innerHTML = `<div class="floating-memo-render">${sanitizeMarkedHtml(renderedHtml)}</div>`

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
          if (memo.collapsed) {
            memo.collapsed = false
            memoEl.classList.remove('collapsed')
            const collapseBtnEl = memoEl.querySelector('.collapse-btn')
            if (collapseBtnEl) {
              collapseBtnEl.innerHTML = icon('chevronUp', 12)
              collapseBtnEl.title = '메모 접기'
            }
            const allMemosObj = loadMemos(state.sessionId)
            allMemosObj[`page_${pageNum}`] = pageMemos
            saveMemos(state.sessionId, allMemosObj)
          }
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
            pushAnnotationUndo({ kind: 'memo', pageNum, memo })

            // 본문의 선택 영역 및 고정 하이라이트 지우기
            applyActiveHighlight(null, null)
            window.getSelection().removeAllRanges()

            renderPageMemos(pageNum)
          }
        })
      }
    }

    const shortTitle = sentenceText
      ? (sentenceText.length > 20 ? sentenceText.substring(0, 20) + '...' : sentenceText)
      : 'Memo'

    memoEl.innerHTML = `
      <div class="floating-memo-header" tabindex="0" role="group" aria-label="${t('viewer:a11y.memoMove')}">
        <div class="floating-memo-title" title="${sentenceText}">
          <span>${icon('edit3', 12, 'style="vertical-align:-2px;margin-right:2px"')}${shortTitle}</span>
        </div>
        <div class="floating-memo-color-picker">
          <button type="button" class="color-dot default ${!memo.color || memo.color === 'default' ? 'selected' : ''}" data-color="default" title="${t('viewer:a11y.defaultColor')}" aria-label="${t('viewer:a11y.color', { color: t('viewer:a11y.defaultColor') })}" aria-pressed="${String(!memo.color || memo.color === 'default')}"></button>
          <button type="button" class="color-dot yellow ${memo.color === 'yellow' ? 'selected' : ''}" data-color="yellow" title="${t('viewer:a11y.yellow')}" aria-label="${t('viewer:a11y.color', { color: t('viewer:a11y.yellow') })}" aria-pressed="${String(memo.color === 'yellow')}"></button>
          <button type="button" class="color-dot green ${memo.color === 'green' ? 'selected' : ''}" data-color="green" title="${t('viewer:a11y.green')}" aria-label="${t('viewer:a11y.color', { color: t('viewer:a11y.green') })}" aria-pressed="${String(memo.color === 'green')}"></button>
          <button type="button" class="color-dot blue ${memo.color === 'blue' ? 'selected' : ''}" data-color="blue" title="${t('viewer:a11y.blue')}" aria-label="${t('viewer:a11y.color', { color: t('viewer:a11y.blue') })}" aria-pressed="${String(memo.color === 'blue')}"></button>
          <button type="button" class="color-dot red ${memo.color === 'red' ? 'selected' : ''}" data-color="red" title="${t('viewer:a11y.red')}" aria-label="${t('viewer:a11y.color', { color: t('viewer:a11y.red') })}" aria-pressed="${String(memo.color === 'red')}"></button>
        </div>
        <div class="floating-memo-toggles">
          <button type="button" class="floating-memo-action-btn collapse-btn" title="${memo.collapsed ? '메모 펼치기' : '메모 접기'}">
            ${icon(memo.collapsed ? 'chevronDown' : 'chevronUp', 12)}
          </button>
          <button type="button" class="floating-memo-action-btn hide-btn" title="메모 숨기기 (하이라이트만 표시)">
            ${icon('eyeOff', 12)}
          </button>
        </div>
        <div class="floating-memo-actions"></div>
      </div>
      <div class="floating-memo-body"></div>
      <button type="button" class="floating-memo-resize-handle" aria-label="${t('viewer:a11y.memoResize')}" title="${t('viewer:a11y.memoResize')}"></button>
    `

    updateCardContent()

    const collapseBtn = memoEl.querySelector('.collapse-btn')
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      memo.collapsed = !memo.collapsed
      const allMemosObj = loadMemos(state.sessionId)
      allMemosObj[`page_${pageNum}`] = pageMemos
      saveMemos(state.sessionId, allMemosObj)

      memoEl.classList.toggle('collapsed', memo.collapsed)
      memoEl.style.height = memo.collapsed || !Number.isFinite(memo.height) ? '' : `${memo.height}px`
      collapseBtn.innerHTML = icon(memo.collapsed ? 'chevronDown' : 'chevronUp', 12)
      collapseBtn.title = memo.collapsed ? '메모 펼치기' : '메모 접기'
      setTimeout(() => updateMemoConnectorLine(pageWrapper, memo), 0)
    })

    const hideBtn = memoEl.querySelector('.hide-btn')
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      memo.hidden = true
      const allMemosObj = loadMemos(state.sessionId)
      allMemosObj[`page_${pageNum}`] = pageMemos
      saveMemos(state.sessionId, allMemosObj)
      renderPageMemos(pageNum)
    })

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

        memo.color = selectedColor
        const allMemosObj = loadMemos(state.sessionId)
        allMemosObj[`page_${pageNum}`] = pageMemos
        saveMemos(state.sessionId, allMemosObj)

        // 카드뿐 아니라 원문 하이라이트(색상 클래스)도 함께 갱신되어야 하므로
        // 전체 재렌더링을 통해 두 경로(카드 UI + VTM/폴백 하이라이트)를 동기화한다
        renderPageMemos(pageNum)
      })
    })

    pageWrapper.appendChild(memoEl)

    // CSS 네이티브 resize를 사용하는 동안 연결선을 실시간으로 맞추고, 사용자가
    // 놓은 최종 크기를 메모 데이터에 저장해 문서를 다시 열어도 복원한다.
    if (window.ResizeObserver) {
      let observedWidth = memoEl.offsetWidth
      let observedHeight = memoEl.offsetHeight
      const resizeObserver = new ResizeObserver(entries => {
        const entry = entries[0]
        if (!entry || memo.collapsed) return
        const borderBox = entry.borderBoxSize?.[0]
        const nextWidth = Math.round(borderBox?.inlineSize ?? memoEl.offsetWidth)
        const nextHeight = Math.round(borderBox?.blockSize ?? memoEl.offsetHeight)
        if (nextWidth === observedWidth && nextHeight === observedHeight) return
        observedWidth = nextWidth
        observedHeight = nextHeight
        memo.width = nextWidth
        memo.height = nextHeight
        updateMemoConnectorLine(pageWrapper, memo)

        if (memoEl._memoResizeSaveTimer) clearTimeout(memoEl._memoResizeSaveTimer)
        memoEl._memoResizeSaveTimer = setTimeout(() => {
          const allMemosObj = loadMemos(state.sessionId)
          allMemosObj[`page_${pageNum}`] = pageMemos
          saveMemos(state.sessionId, allMemosObj)
          memoEl._memoResizeSaveTimer = null
        }, 250)
      })
      memoEl._memoResizeObserver = resizeObserver
      resizeObserver.observe(memoEl)
    }

    const resizeHandle = memoEl.querySelector('.floating-memo-resize-handle')
    resizeHandle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const step = event.shiftKey ? 20 : 4
      let width = memoEl.offsetWidth
      let height = memoEl.offsetHeight
      if (event.key === 'ArrowLeft') width -= step
      if (event.key === 'ArrowRight') width += step
      if (event.key === 'ArrowUp') height -= step
      if (event.key === 'ArrowDown') height += step
      width = Math.max(220, Math.min(520, width))
      height = Math.max(120, Math.min(Math.round(window.innerHeight * 0.75), height))
      memo.width = Math.round(width)
      memo.height = Math.round(height)
      memoEl.style.width = `${memo.width}px`
      memoEl.style.height = `${memo.height}px`
      updateMemoConnectorLine(pageWrapper, memo)
      const allMemosObj = loadMemos(state.sessionId)
      allMemosObj[`page_${pageNum}`] = pageMemos
      saveMemos(state.sessionId, allMemosObj)
      announceA11y(t('viewer:a11y.memoSize', { width: memo.width, height: memo.height }))
    })

    const header = memoEl.querySelector('.floating-memo-header')
    header.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const step = event.shiftKey ? 20 : 4
      const dxPct = step / Math.max(1, pageWrapper.offsetWidth) * 100
      const dyPct = step / Math.max(1, pageWrapper.offsetHeight) * 100
      if (event.key === 'ArrowLeft') memo.x -= dxPct
      if (event.key === 'ArrowRight') memo.x += dxPct
      if (event.key === 'ArrowUp') memo.y -= dyPct
      if (event.key === 'ArrowDown') memo.y += dyPct
      memo.x = Math.min(Math.max(-150, memo.x), 250)
      memo.y = Math.min(Math.max(-150, memo.y), 250)
      memoEl.style.left = `${memo.x}%`
      memoEl.style.top = `${memo.y}%`
      updateMemoConnectorLine(pageWrapper, memo)
      const allMemosObj = loadMemos(state.sessionId)
      allMemosObj[`page_${pageNum}`] = pageMemos
      saveMemos(state.sessionId, allMemosObj)
      announceA11y(t('viewer:a11y.memoPosition', { x: Math.round(memoEl.offsetLeft), y: Math.round(memoEl.offsetTop) }))
    })
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

        updateMemoConnectorLine(pageWrapper, memo)
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
      updateMemoConnectorLine(pageWrapper, memo)
    }, 50)
  })
}

// explicitRange({charStart, charEnd})가 주어지면 사용자가 실제로 드래그해서 고른
// 정확한 범위로 메모를 만들고, 없으면(드웰 호버 등) 문장 전체 범위를 사용한다.
function createFloatingMemoForSentence(pageNum, sentenceIdx, explicitRange) {
  if (!state.sessionId) return

  const pageWrapper = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`)
  if (!pageWrapper) return

  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
  const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum]
  if (!vtm || !sentenceRanges) return

  const sRange = sentenceRanges.find(r => {
    const idx = r.sentenceIdx >= 10000 ? (r.originalSentenceIdx ?? r.sentenceIdx) : r.sentenceIdx
    return idx === sentenceIdx || r.sentenceIdx === sentenceIdx
  })
  if (!sRange) return

  const memoRange = explicitRange || { charStart: sRange.charStart, charEnd: sRange.charEnd }

  const sentenceText = vtm.fullText.substring(memoRange.charStart, memoRange.charEnd).trim()

  const textLayer = pageWrapper.querySelector('.textLayer')
  if (!textLayer) return

  const rects = getSentenceRects(memoRange, vtm, textLayer)
  if (rects.length === 0) return

  const firstRect = rects[0]
  const sentenceX = firstRect.left
  const sentenceY = firstRect.top

  const leftPct = Math.min(Math.max(10, ((sentenceX + firstRect.width / 2) / pageWrapper.offsetWidth) * 100), 70)
  const topPct = Math.min(Math.max(10, ((sentenceY + firstRect.height) / pageWrapper.offsetHeight) * 100 + 4), 85)

  const allMemosObj = loadMemos(state.sessionId)
  if (!allMemosObj[`page_${pageNum}`]) {
    allMemosObj[`page_${pageNum}`] = []
  }

  const newMemo = {
    id: `memo_${Date.now()}`,
    pageNum: pageNum,
    sentenceIdx: sentenceIdx,
    sentenceText: sentenceText,
    charStart: memoRange.charStart,
    charEnd: memoRange.charEnd,
    content: '',
    createdAt: new Date().toISOString(),
    x: leftPct,
    y: topPct
  }

  allMemosObj[`page_${pageNum}`].push(newMemo)
  saveMemos(state.sessionId, allMemosObj)
  globalAnalyticsTracker.trackInteraction('memo', pageNum)

  renderPageMemos(pageNum)
}

// PDF 원문/번역문/AI 답변에서 마우스로 드래그 선택한 텍스트를 추출한다.
// selection.toString()을 그대로 쓰면, 선택 영역에 KaTeX 수식이 포함될 때
// 문제가 있다 - KaTeX는 렌더링용 시각 트리(.katex-html)와 스크린리더용
// MathML 트리(.katex-mathml)를 함께 렌더링하는데(output: 'htmlAndMathml'),
// .katex-mathml은 화면에는 안 보이도록 클립 처리만 되어 있을 뿐 실제로는
// 선택 영역에 그대로 포함된다. 그 결과 selection.toString()이 두 트리의
// 텍스트를 이어 붙여 "3\n×\n3\n×\n33×3×3"처럼 수식이 중복되고, 게다가
// KaTeX 시각 트리 자체가 여러 개의 인접한 inline-block 상자로 이루어져
// 있어서 토큰 사이에 줄바꿈까지 끼어든다. 선택 영역을 복제한 뒤
// .katex-mathml만 제거하고 textContent로 읽으면 두 문제 모두 없어진다
// (실측 확인됨). pdf.js 텍스트 레이어는 단어 사이에 실제 공백 문자를
// 넣어두므로 일반 텍스트 선택에는 영향이 없다.
function extractSelectionText(selection) {
  if (!selection || selection.rangeCount === 0) return ''
  const parts = []
  for (let i = 0; i < selection.rangeCount; i++) {
    const frag = selection.getRangeAt(i).cloneContents()
    frag.querySelectorAll('.katex-mathml').forEach(el => el.remove())
    parts.push(frag.textContent)
  }
  return parts.join('')
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

    const selection = window.getSelection()
    const hasActiveSelection = selection && !selection.isCollapsed && selection.rangeCount > 0

    // ── 케이스 1: 드웰(700ms hover) 선택 상태 ──
    if (!hasActiveSelection && state.hoverSelectedPageNum != null && state.hoverSelectedSentenceIdx != null) {
      createFloatingMemoForSentence(state.hoverSelectedPageNum, state.hoverSelectedSentenceIdx)
      hideSelectionMenu()
      return
    }

    // ── 케이스 2: 일반 드래그/텍스트 선택 상태 ──
    if (hasActiveSelection) {
      const range = selection.getRangeAt(0)
      let startEl = range.startContainer
      if (startEl.nodeType === 3) startEl = startEl.parentElement
      if (!startEl) { hideSelectionMenu(); return }

      const pageWrapper = startEl.closest('.pdf-page-wrapper')
      if (!pageWrapper) { hideSelectionMenu(); return }
      const pageNum = parseInt(pageWrapper.dataset.page, 10)
      if (isNaN(pageNum)) { hideSelectionMenu(); return }

      // VTM 기반: 실제로 드래그해서 선택한 범위 그대로 메모 하이라이트를 만든다.
      // (sentenceIdx는 기존 메모 조회/삭제 등 하위 로직 호환을 위한 소속 문장
      // 앵커일 뿐, 하이라이트 범위 자체는 selRange를 그대로 사용한다)
      const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
      const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum]
      if (vtm && sentenceRanges) {
        const selRange = getVtmCharRangeFromSelection(range, vtm)
        if (selRange) {
          const anchorSRange = findSentenceAtChar(selRange.charStart, sentenceRanges)
            || findSentenceAtChar(Math.max(selRange.charStart, selRange.charEnd - 1), sentenceRanges)
            || sentenceRanges[0]
          const sentenceIdx = anchorSRange.sentenceIdx >= 10000 ? (anchorSRange.originalSentenceIdx ?? 0) : anchorSRange.sentenceIdx
          createFloatingMemoForSentence(pageNum, sentenceIdx, selRange)
          hideSelectionMenu()
          return
        }
      }

      // 폴백: .pdf-sentence 스팬 기반 (하위 호환)
      let sentenceEl = startEl.closest('.pdf-sentence')
      if (!sentenceEl) {
        const common = range.commonAncestorContainer
        const commonEl = common.nodeType === 3 ? common.parentElement : common
        sentenceEl = commonEl && commonEl.closest('.pdf-sentence')
      }
      if (sentenceEl) {
        const sentenceIdx = parseInt(sentenceEl.dataset.sentenceIdx, 10)
        createFloatingMemoForSentence(pageNum, sentenceIdx)
      }
    }
    hideSelectionMenu()
  })

  menu.querySelector('.ask-ai-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const selection = window.getSelection()
    const text = extractSelectionText(selection).trim()
    if (text) {
      askAIAssistant(text)
    }
    selection.removeAllRanges()
    hideSelectionMenu()
  })

  updateActiveColors()
  return menu
}

// ── 어노테이션(하이라이트/밑줄/메모) 마우스 호버 툴팁 관리 ──
let annHoverTooltip = null
let annHoverHideTimer = null
let activeHoveredSpan = null       // 하이라이트/밑줄 span (있을 때만) - 삭제 버튼의 대상
let activeHoveredPageNum = null
let activeHoveredSentenceIdx = null
let activeHoveredMemo = null       // 현재 호버 중인 위치에 이미 존재하는 메모 (있으면)
let activeHoveredText = ''

// 해당 페이지/문장에 이미 저장된 메모가 있는지 조회
function lookupMemoForSentence(pageNum, sentenceIdx) {
  if (pageNum == null || sentenceIdx == null || isNaN(sentenceIdx)) return null
  const allMemos = loadMemos(state.sessionId)
  const pageMemos = allMemos[`page_${pageNum}`] || []
  return pageMemos.find(m => m.sentenceIdx === sentenceIdx) || null
}

// 하이라이트/밑줄 span의 화면 위치로부터 소속 문장의 sentenceIdx를 역추적
function resolveSentenceIdxFromSpan(span, pageNum) {
  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
  const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum]
  const rect = span.getBoundingClientRect()
  const charIdx = vtm ? estimateCharIdxFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, vtm) : -1
  const sRange = (charIdx >= 0 && sentenceRanges) ? findSentenceAtChar(charIdx, sentenceRanges) : null
  if (sRange) return sRange.sentenceIdx >= 10000 ? (sRange.originalSentenceIdx ?? 0) : sRange.sentenceIdx

  // 폴백: .pdf-sentence 스팬 기반
  const sentenceEl = span.closest('.pdf-sentence')
  if (sentenceEl) {
    const idx = parseInt(sentenceEl.dataset.sentenceIdx, 10)
    if (!isNaN(idx)) return idx
  }
  return null
}

// VTM 기반 sentenceRange의 뷰포트 상 경계 사각형 (메모 전용 호버 - 실제 span이 없을 때 툴팁 위치 계산용)
function getSentenceViewportRect(sentenceRange, vtm) {
  const nodeRanges = vtm.nodeRanges
  let startNode = null, startOff = 0, endNode = null, endOff = 0
  for (const nr of nodeRanges) {
    if (startNode === null && nr.end > sentenceRange.charStart) { startNode = nr.node; startOff = Math.max(0, sentenceRange.charStart - nr.start) }
    if (nr.start < sentenceRange.charEnd) { endNode = nr.node; endOff = Math.min(nr.node.length, sentenceRange.charEnd - nr.start) }
  }
  if (!startNode || !endNode) return null
  try {
    const r = document.createRange()
    r.setStart(startNode, startOff)
    r.setEnd(endNode, endOff)
    return r.getBoundingClientRect()
  } catch (e) { return null }
}

// 현재 컨텍스트(activeHoveredSpan/activeHoveredMemo)에 맞춰 버튼 표시 상태 갱신
function updateAnnHoverTooltipButtons(tooltip) {
  const deleteBtn = tooltip.querySelector('.delete-ann-btn')
  const dividers = tooltip.querySelectorAll('.menu-divider')

  // 삭제(하이라이트/밑줄) 버튼은 실제로 지울 대상이 있을 때만 노출
  if (deleteBtn) {
    deleteBtn.style.display = activeHoveredSpan ? '' : 'none'
  }
  if (dividers[0]) {
    dividers[0].style.display = activeHoveredSpan ? '' : 'none'
  }

  const memoBtn = tooltip.querySelector('.memo-ann-btn')
  if (memoBtn) {
    const hasMemo = !!activeHoveredMemo
    memoBtn.title = hasMemo ? '메모 삭제' : '메모 추가'
    memoBtn.innerHTML = hasMemo
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>'
  }
}

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

    const pageWrapper = activeHoveredSpan.closest('.pdf-page-wrapper')
    if (!pageWrapper) return
    const pageNum = parseInt(pageWrapper.dataset.page, 10)
    const textLayerDiv = pageWrapper.querySelector('.textLayer')
    if (!textLayerDiv) return

    // 마우스가 실제로 올라가 있던 span의 타입(하이라이트/밑줄)만 지운다 - 같은 범위에
    // 하이라이트와 밑줄이 중첩 적용된 경우, 겹치는 다른 타입까지 함께 지워지면 안 된다.
    const annType = activeHoveredSpan.classList.contains('pdf-annotation-highlight') ? 'highlight' : 'underline'

    // 어노테이션 스팬의 dataset에서 직접 오프셋 정보 추출
    const annStartOffset = parseInt(activeHoveredSpan.dataset.startOffset, 10)
    const annEndOffset   = parseInt(activeHoveredSpan.dataset.endOffset,   10)

    if (!isNaN(annStartOffset) && !isNaN(annEndOffset)) {
      // 직접 오프셋으로 삭제 (신뢰 경로)
      const annotations = loadAnnotations(state.sessionId)
      if (annotations[`page_${pageNum}`]) {
        const removed = []
        // 같은 타입이면서 범위가 겹치는 것들만 삭제
        annotations[`page_${pageNum}`] = annotations[`page_${pageNum}`].filter(ann => {
          if (ann.type !== annType) return true
          const isOverlapping = (ann.startOffset >= annStartOffset && ann.startOffset <= annEndOffset) ||
                                (ann.endOffset   >= annStartOffset && ann.endOffset   <= annEndOffset)
          if (isOverlapping) removed.push(ann)
          return !isOverlapping
        })
        if (removed.length > 0) {
          saveAnnotations(state.sessionId, annotations)
          pushAnnotationUndo({ kind: 'annotation', pageNum, items: removed })
          showToast('어노테이션이 삭제되었습니다 ✓', 'success')
          reRenderPageAnnotations(textLayerDiv, pageNum)
        }
      }
    } else {
      // 폴백: VTM 기반 선택 범위 계산
      const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
      const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum]
      const annRect = activeHoveredSpan.getBoundingClientRect()
      const charIdx = vtm ? estimateCharIdxFromPoint(annRect.left + annRect.width / 2, annRect.top + annRect.height / 2, vtm) : -1
      const sRange = (charIdx >= 0 && sentenceRanges) ? findSentenceAtChar(charIdx, sentenceRanges) : null

      if (sRange && vtm) {
        // sentenceRange 전체 범위에 해당하는 textLayer offset 계산
        const nodeRanges = vtm.nodeRanges
        let startNode = null, startOff = 0, endNode = null, endOff = 0
        for (const nr of nodeRanges) {
          if (startNode === null && nr.end > sRange.charStart) { startNode = nr.node; startOff = Math.max(0, sRange.charStart - nr.start) }
          if (nr.start < sRange.charEnd) { endNode = nr.node; endOff = Math.min(nr.node.length, sRange.charEnd - nr.start) }
        }
        if (startNode && endNode) {
          try {
            const r = document.createRange()
            r.setStart(startNode, startOff)
            r.setEnd(endNode, endOff)
            const sentenceOffsets = getPageTextOffset(r, textLayerDiv)
            if (sentenceOffsets.startOffset !== null && sentenceOffsets.endOffset !== null) {
              const annotations = loadAnnotations(state.sessionId)
              if (annotations[`page_${pageNum}`]) {
                const removed = []
                annotations[`page_${pageNum}`] = annotations[`page_${pageNum}`].filter(ann => {
                  if (ann.type !== annType) return true
                  const isOverlapping = (ann.startOffset >= sentenceOffsets.startOffset && ann.startOffset <= sentenceOffsets.endOffset) ||
                                        (ann.endOffset   >= sentenceOffsets.startOffset && ann.endOffset   <= sentenceOffsets.endOffset)
                  if (isOverlapping) removed.push(ann)
                  return !isOverlapping
                })
                if (removed.length > 0) {
                  saveAnnotations(state.sessionId, annotations)
                  pushAnnotationUndo({ kind: 'annotation', pageNum, items: removed })
                  showToast('어노테이션이 삭제되었습니다 ✓', 'success')
                  reRenderPageAnnotations(textLayerDiv, pageNum)
                }
              }
            }
          } catch(err) { console.warn('Delete annotation fallback failed:', err) }
        }
      }
    }
    hideAnnHoverTooltip()
  })

  tooltip.querySelector('.memo-ann-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    if (activeHoveredPageNum == null) { hideAnnHoverTooltip(); return }

    if (activeHoveredMemo) {
      // 이미 존재하는 메모 삭제
      const allMemosObj = loadMemos(state.sessionId)
      const pageMemos = allMemosObj[`page_${activeHoveredPageNum}`] || []
      allMemosObj[`page_${activeHoveredPageNum}`] = pageMemos.filter(m => m.id !== activeHoveredMemo.id)
      saveMemos(state.sessionId, allMemosObj)
      pushAnnotationUndo({ kind: 'memo', pageNum: activeHoveredPageNum, memo: activeHoveredMemo })
      showToast('메모가 삭제되었습니다 ✓', 'success')
      renderPageMemos(activeHoveredPageNum)
    } else if (activeHoveredSentenceIdx != null && !isNaN(activeHoveredSentenceIdx)) {
      createFloatingMemoForSentence(activeHoveredPageNum, activeHoveredSentenceIdx)
    }
    hideAnnHoverTooltip()
  })

  tooltip.querySelector('.ask-ai-ann-btn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    const text = activeHoveredSpan ? activeHoveredSpan.textContent.trim() : activeHoveredText
    if (text) {
      askAIAssistant(text)
    }
    hideAnnHoverTooltip()
  })

  return tooltip
}

// 공통 위치 계산/노출 로직 - span 기반(하이라이트/밑줄)과 메모 전용(문장 범위) 양쪽에서 사용
function positionAndShowAnnHoverTooltip(rect) {
  if (!rect) return
  const tooltip = createAnnHoverTooltip()
  updateAnnHoverTooltipButtons(tooltip)
  tooltip.classList.remove('hidden')

  const tooltipWidth = tooltip.offsetWidth || 110
  const tooltipHeight = tooltip.offsetHeight || 32

  const left = rect.left + rect.width / 2 - tooltipWidth / 2 + window.scrollX
  const top = rect.top - tooltipHeight - 6 + window.scrollY

  tooltip.style.left = `${Math.max(8, left)}px`
  tooltip.style.top = `${Math.max(8, top)}px`
}

// 하이라이트/밑줄 span 위에서 호버할 때 - 삭제 대상은 정확히 이 span의 타입으로 한정된다
function showAnnHoverTooltipForSpan(annSpan) {
  if (annHoverHideTimer) {
    clearTimeout(annHoverHideTimer)
    annHoverHideTimer = null
  }

  // 같은 span에 계속 머무는 동안엔 mousemove마다 재계산하지 않고 위치만 갱신
  if (activeHoveredSpan === annSpan) {
    positionAndShowAnnHoverTooltip(annSpan.getBoundingClientRect())
    return
  }

  const pageWrapper = annSpan.closest('.pdf-page-wrapper')
  const pageNum = pageWrapper ? parseInt(pageWrapper.dataset.page, 10) : null
  const sentenceIdx = (pageNum != null && !isNaN(pageNum)) ? resolveSentenceIdxFromSpan(annSpan, pageNum) : null

  activeHoveredSpan = annSpan
  activeHoveredPageNum = (pageNum != null && !isNaN(pageNum)) ? pageNum : null
  activeHoveredSentenceIdx = sentenceIdx
  activeHoveredMemo = lookupMemoForSentence(activeHoveredPageNum, sentenceIdx)
  activeHoveredText = annSpan.textContent.trim()

  positionAndShowAnnHoverTooltip(annSpan.getBoundingClientRect())
}

// 하이라이트/밑줄 없이 메모만 존재하는 문장 위에서 호버할 때
function showAnnHoverTooltipForMemoSentence(pageNum, sentenceRange, sentenceIdx, memo) {
  if (annHoverHideTimer) {
    clearTimeout(annHoverHideTimer)
    annHoverHideTimer = null
  }

  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
  const rect = vtm ? getSentenceViewportRect(sentenceRange, vtm) : null
  if (!rect) return

  activeHoveredSpan = null
  activeHoveredPageNum = pageNum
  activeHoveredSentenceIdx = sentenceIdx
  activeHoveredMemo = memo
  activeHoveredText = vtm ? vtm.fullText.substring(sentenceRange.charStart, sentenceRange.charEnd).trim() : ''

  positionAndShowAnnHoverTooltip(rect)
}

function hideAnnHoverTooltip() {
  if (annHoverTooltip) {
    annHoverTooltip.classList.add('hidden')
  }
  activeHoveredSpan = null
  activeHoveredPageNum = null
  activeHoveredSentenceIdx = null
  activeHoveredMemo = null
  activeHoveredText = ''
}

function hideAnnHoverTooltipWithDelay() {
  if (annHoverHideTimer) clearTimeout(annHoverHideTimer)
  annHoverHideTimer = setTimeout(() => {
    hideAnnHoverTooltip()
  }, 250)
}

function handleAnnotate(type, color) {
  const selection = window.getSelection();
  const hasActiveSelection = selection && !selection.isCollapsed && selection.rangeCount > 0;

  // 1. 일반 마우스 드래그 선택 대응 (최우선)
  if (hasActiveSelection) {
    const range = selection.getRangeAt(0);
    let textLayer = range.commonAncestorContainer;
    if (textLayer && textLayer.nodeType === 3) {
      textLayer = textLayer.parentElement || textLayer.parentNode;
    }
    const textLayerDiv = (textLayer && textLayer.nodeType === 1) ? textLayer.closest('.textLayer') : null;
    if (!textLayerDiv) return;

    const pageWrapper = textLayerDiv.closest('.pdf-page-wrapper');
    if (!pageWrapper) return;
    const pageNum = parseInt(pageWrapper.dataset.page, 10);

    if (type === 'clear') {
      clearAnnotationsInRange(range, textLayerDiv, pageNum);
    } else {
      applyAnnotationToRange(range, type, textLayerDiv, pageNum, color);
    }

    hideSelectionMenu();
    return;
  }

  // 2. 드웰(700ms hover) 선택 → native selection이 있으면 케이스 1이 처리
  //    native selection 없이 hoverSelected* 상태로만 도달한 경우 (이전 시스템 호환)
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

  // 3. 새 시스템: VTM 기반 hoverSelectedPageNum/SentenceIdx → native selection 사용
  if (state.hoverSelectedPageNum != null && state.hoverSelectedSentenceIdx != null) {
    const pageNum = state.hoverSelectedPageNum;
    const sentenceIdx = state.hoverSelectedSentenceIdx;
    const textLayerDiv = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"] .textLayer`);
    if (!textLayerDiv) return;

    const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum];
    const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum];
    if (!vtm || !sentenceRanges) return;

    const sRange = sentenceRanges.find(r => {
      const idx = r.sentenceIdx >= 10000 ? (r.originalSentenceIdx ?? r.sentenceIdx) : r.sentenceIdx;
      return idx === sentenceIdx || r.sentenceIdx === sentenceIdx;
    });
    if (!sRange) return;

    const { nodeRanges } = vtm;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (const nr of nodeRanges) {
      if (startNode === null && nr.end > sRange.charStart) {
        startNode = nr.node;
        startOff  = Math.max(0, sRange.charStart - nr.start);
      }
      if (nr.start < sRange.charEnd) {
        endNode = nr.node;
        endOff  = Math.min(nr.node.length, sRange.charEnd - nr.start);
      }
    }
    if (startNode && endNode) {
      try {
        const r = document.createRange();
        r.setStart(startNode, startOff);
        r.setEnd(endNode, endOff);
        if (type === 'clear') {
          clearAnnotationsInRange(r, textLayerDiv, pageNum);
        } else {
          applyAnnotationToRange(r, type, textLayerDiv, pageNum, color);
        }
        window.getSelection().removeAllRanges();
        hideSelectionMenu();
        state.hoverSelectedPageNum = null;
        state.hoverSelectedSentenceIdx = null;
      } catch(err) {
        console.warn('handleAnnotate VTM path failed:', err);
      }
    }
  }
}


// 선택된 range가 이미 존재하는 하이라이트/밑줄/메모와 겹치는지 확인 - 겹치는 게 없으면
// 지울 대상 자체가 없으므로 선택 메뉴의 "지우기" 버튼을 보여줄 필요가 없다.
function selectionOverlapsExistingAnnotation(range, textLayerDiv, pageNum) {
  const offsets = getPageTextOffset(range, textLayerDiv)
  if (offsets.startOffset === null || offsets.endOffset === null) return false

  const annotations = loadAnnotations(state.sessionId)
  const pageAnns = annotations[`page_${pageNum}`] || []
  const hasAnnotation = pageAnns.some(ann =>
    ann.startOffset < offsets.endOffset && ann.endOffset > offsets.startOffset
  )
  if (hasAnnotation) return true

  const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum]
  const allMemos = loadMemos(state.sessionId)
  const pageMemos = allMemos[`page_${pageNum}`] || []
  if (sentenceRanges && pageMemos.length > 0) {
    return sentenceRanges.some(sr => {
      if (!(sr.charStart < offsets.endOffset && sr.charEnd > offsets.startOffset)) return false
      const idx = sr.sentenceIdx >= 10000 ? (sr.originalSentenceIdx ?? sr.sentenceIdx) : sr.sentenceIdx
      return pageMemos.some(m => m.sentenceIdx === idx)
    })
  }
  return false
}

function clearAnnotationsInRange(range, textLayerDiv, pageNum) {
  const offsets = getPageTextOffset(range, textLayerDiv)
  if (offsets.startOffset === null || offsets.endOffset === null) return

  // 하이라이트/밑줄 제거
  const annotations = loadAnnotations(state.sessionId)
  const removedAnnotations = []
  if (annotations[`page_${pageNum}`]) {
    annotations[`page_${pageNum}`] = annotations[`page_${pageNum}`].filter(ann => {
      const hasOverlap = !(ann.endOffset <= offsets.startOffset || ann.startOffset >= offsets.endOffset)
      if (hasOverlap) removedAnnotations.push(ann)
      return !hasOverlap
    })
  }

  // 선택 범위에 걸치는 문장의 메모도 함께 제거 ("지우기" 버튼은 지울 대상이 있을 때만
  // 노출되므로, 메모만 있던 선택이었다면 여기서도 실제로 지워져야 한다)
  const removedMemos = []
  const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum]
  const allMemosObj = loadMemos(state.sessionId)
  const pageMemos = allMemosObj[`page_${pageNum}`] || []
  if (sentenceRanges && pageMemos.length > 0) {
    const overlappingSentenceIdxs = new Set(
      sentenceRanges
        .filter(sr => sr.charStart < offsets.endOffset && sr.charEnd > offsets.startOffset)
        .map(sr => sr.sentenceIdx >= 10000 ? (sr.originalSentenceIdx ?? sr.sentenceIdx) : sr.sentenceIdx)
    )
    if (overlappingSentenceIdxs.size > 0) {
      allMemosObj[`page_${pageNum}`] = pageMemos.filter(m => {
        if (overlappingSentenceIdxs.has(m.sentenceIdx)) { removedMemos.push(m); return false }
        return true
      })
    }
  }

  if (removedAnnotations.length === 0 && removedMemos.length === 0) {
    window.getSelection().removeAllRanges()
    return
  }

  if (removedAnnotations.length > 0) saveAnnotations(state.sessionId, annotations)
  if (removedMemos.length > 0) saveMemos(state.sessionId, allMemosObj)
  pushAnnotationUndo({ kind: 'clear', pageNum, items: removedAnnotations, memos: removedMemos })
  showToast('선택 영역의 표시가 삭제되었습니다 ✓', 'success')
  // 메모 재렌더링까지 포함한다
  reRenderPageAnnotations(textLayerDiv, pageNum)
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

  // DOM 구조 변경 후 VirtualTextMap 및 문장 매핑 상태 재생성
  segmentPdfElements(textLayerDiv, pageNum)

  // Restore floating memos for the page
  renderPageMemos(pageNum)
}

function showSelectionMenu(rect, showAnnotateGroup, hasExistingAnnotation = true) {
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

  // 선택 영역에 이미 하이라이트/밑줄/메모가 없으면 지울 대상이 없으므로 "지우기" 버튼을 숨긴다
  const clearBtn = menu.querySelector('.clear-btn')
  if (clearBtn) {
    clearBtn.style.display = hasExistingAnnotation ? '' : 'none'
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
  if (viewerScrollContainer) {
    viewerScrollContainer.classList.remove('selection-dragging');
  }
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

      const selectedText = extractSelectionText(selection).trim()
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
      // AI가 답변한 채팅 메시지(assistant)에서 선택한 내용도 인용해 후속 질문을
      // 할 수 있도록, 사용자 자신의 메시지는 제외하고 assistant 말풍선만 대상으로 함
      const isChatAssistantMsg = container && container.nodeType === 1 && container.closest('.chat-message.assistant .message-bubble')

      if (!isTextLayer && !isTransContent && !isChatAssistantMsg) {
        hideSelectionMenu()
        return
      }

      const rect = range.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        let hasExistingAnnotation = true
        if (isTextLayer) {
          const textLayerDiv = container.closest('.textLayer')
          const pageWrapper = textLayerDiv && textLayerDiv.closest('.pdf-page-wrapper')
          const pageNum = pageWrapper ? parseInt(pageWrapper.dataset.page, 10) : null
          if (textLayerDiv && pageNum != null && !isNaN(pageNum)) {
            hasExistingAnnotation = selectionOverlapsExistingAnnotation(range, textLayerDiv, pageNum)
          }
        }
        showSelectionMenu(rect, !!isTextLayer, hasExistingAnnotation)
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
  renderCitationOverlayLayer(textLayerDiv, pageNum)
  renderFigureRefOverlayLayer(textLayerDiv, pageNum)

  // 이미 번역된 적이 있는 페이지인데 아직 번역 문장 데이터(state.translationSentences)가
  // 로드되지 않았다면, 방금 위에서 실행한 세그멘테이션은 정규식 기반 폴백
  // (splitIntoSentences) 결과다. 번역 캐시가 로드되면 alignSentencesToText로 다시
  // 세그멘테이션되며 문장 인덱스가 달라질 수 있어, 지금 메모를 그리면 잘못된 위치에
  // 표시됐다가 번역 로딩 완료 시 원래 위치로 튀어 보인다. 이 경우엔 그리지 않고
  // renderTransContent → reRenderPageAnnotations에서 최종 위치로 한 번만 그리게 한다.
  const pendingRetranslationSegmentation =
    state.translatedPages.has(pageNum) &&
    !(state.translationSentences[pageNum] && state.translationSentences[pageNum].length)
  if (pendingRetranslationSegmentation) return

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

// 감지된 그림/표 오버레이 박스의 모서리 핸들을 드래그해 영역을 직접 조절할 수
// 있게 한다. 자동 감지 bbox가 실제 표/그림보다 너무 크거나 작게 잡히는
// 경우(레이아웃이 특이한 논문 등)가 있어, 캡처 전에 사용자가 직접 보정할
// 수 있어야 한다. imgPercent는 state.documentImages 안의 객체를 그대로
// 참조하므로, 여기서 좌표를 갱신하면 이후 클릭 시 크롭(cropFigureFromCanvas)과
// 참조 오버레이 미리보기(renderFigureCrop)에도 그대로 반영된다.
const _FIGURE_OVERLAY_MIN_SIZE_PCT = 3

// 드래그로 만들어진 면적 증가율(growthFactor)을 문서 내 다른 모든 그림/표/수식
// 오버레이에도 똑같이 적용한다. 서로 원본 비율(가로:세로)이 다른 박스들을 전부
// 같은 모양으로 맞추는 게 아니라, 각자 자기 비율은 그대로 유지한 채 "면적"만
// 같은 비율로 커지거나 작아지게 한다 - 여러 그림/표를 한꺼번에 대충 훑어봐야
// 하는 상황에서, 하나를 보기 편한 크기로 키우면 나머지도 비슷한 체감 크기로
// 같이 커지는 게 자연스럽기 때문.
function _propagateOverlayAreaGrowth(sourceImgPercent, growthFactor) {
  if (!Number.isFinite(growthFactor) || growthFactor <= 0 || growthFactor === 1) return

  const others = (state.documentImages || []).filter(img => img !== sourceImgPercent)
  others.forEach(img => {
    const ratio = img.height > 0 ? img.width / img.height : 1
    const newArea = img.width * img.height * growthFactor
    let newWidth = Math.sqrt(newArea * ratio)
    let newHeight = ratio > 0 ? newWidth / ratio : newWidth

    if (newWidth < _FIGURE_OVERLAY_MIN_SIZE_PCT || newHeight < _FIGURE_OVERLAY_MIN_SIZE_PCT) {
      const scaleUp = Math.max(_FIGURE_OVERLAY_MIN_SIZE_PCT / newWidth, _FIGURE_OVERLAY_MIN_SIZE_PCT / newHeight)
      newWidth *= scaleUp
      newHeight *= scaleUp
    }
    if (newWidth > 100 || newHeight > 100) {
      const scaleDown = Math.min(100 / newWidth, 100 / newHeight)
      newWidth *= scaleDown
      newHeight *= scaleDown
    }

    // 중심점을 고정한 채로 커지거나 작아지게 한다 (박스의 어느 한쪽 모서리가
    // 아니라 중앙을 기준으로 삼는 게, 드래그한 모서리가 없는 다른 박스들에는
    // 더 자연스럽다).
    const centerX = img.left + img.width / 2
    const centerY = img.top + img.height / 2
    let newLeft = centerX - newWidth / 2
    let newTop = centerY - newHeight / 2
    newLeft = Math.max(0, Math.min(newLeft, 100 - newWidth))
    newTop = Math.max(0, Math.min(newTop, 100 - newHeight))

    img.left = newLeft
    img.top = newTop
    img.width = newWidth
    img.height = newHeight
  })

  // 이미 화면에 렌더링되어 있는 페이지들의 오버레이를 갱신된 percentage로
  // 다시 그린다 (loadDocumentImages에서 쓰는 것과 동일한 패턴).
  document.querySelectorAll('.textLayer').forEach(otherTextLayerDiv => {
    const pageWrapper = otherTextLayerDiv.closest('.pdf-page-wrapper')
    if (pageWrapper) {
      renderImageOverlayLayer(otherTextLayerDiv, parseInt(pageWrapper.dataset.page))
    }
  })
}

function _attachFigureOverlayResizeHandles(overlay, imgPercent, inner) {
  const corners = ['nw', 'ne', 'sw', 'se']

  corners.forEach(pos => {
    const handle = document.createElement('button')
    handle.type = 'button'
    handle.className = `pdf-figure-overlay-handle pdf-figure-overlay-handle-${pos}`
    handle.setAttribute('aria-label', t('viewer:a11y.imageResize'))

    // 핸들에서 시작된 클릭이 overlay의 click 리스너(크롭 트리거)까지
    // 버블링되지 않도록 막는다 - 드래그 없이 핸들만 클릭했을 때 의도치
    // 않게 캡처가 실행되는 것을 방지.
    handle.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })

    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      const stepPx = event.shiftKey ? 20 : 4
      const dx = (stepPx / Math.max(1, inner.offsetWidth)) * 100
      const dy = (stepPx / Math.max(1, inner.offsetHeight)) * 100
      const fixedX = pos.includes('w') ? imgPercent.left + imgPercent.width : imgPercent.left
      const fixedY = pos.includes('n') ? imgPercent.top + imgPercent.height : imgPercent.top
      let movingX = pos.includes('w') ? imgPercent.left : imgPercent.left + imgPercent.width
      let movingY = pos.includes('n') ? imgPercent.top : imgPercent.top + imgPercent.height
      if (event.key === 'ArrowLeft') movingX -= dx
      if (event.key === 'ArrowRight') movingX += dx
      if (event.key === 'ArrowUp') movingY -= dy
      if (event.key === 'ArrowDown') movingY += dy
      movingX = Math.max(0, Math.min(100, movingX))
      movingY = Math.max(0, Math.min(100, movingY))
      const width = Math.max(_FIGURE_OVERLAY_MIN_SIZE_PCT, Math.abs(movingX - fixedX))
      const height = Math.max(_FIGURE_OVERLAY_MIN_SIZE_PCT, Math.abs(movingY - fixedY))
      imgPercent.left = Math.max(0, Math.min(movingX < fixedX ? fixedX - width : fixedX, 100 - width))
      imgPercent.top = Math.max(0, Math.min(movingY < fixedY ? fixedY - height : fixedY, 100 - height))
      imgPercent.width = width
      imgPercent.height = height
      overlay.style.left = `${imgPercent.left}%`
      overlay.style.top = `${imgPercent.top}%`
      overlay.style.width = `${width}%`
      overlay.style.height = `${height}%`
      announceA11y(t('viewer:a11y.previewSize', { width: Math.round(overlay.offsetWidth), height: Math.round(overlay.offsetHeight) }))
    })

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()

      const containerRect = inner.getBoundingClientRect()
      // 드래그하는 동안 고정되어야 할 반대쪽 모서리 (예: nw를 끌면 se가 고정점)
      const fixedX = pos.includes('w') ? imgPercent.left + imgPercent.width : imgPercent.left
      const fixedY = pos.includes('n') ? imgPercent.top + imgPercent.height : imgPercent.top

      // 드래그 중인 이 박스는 자동 감지된 bbox를 실제 그림/표 모양에 맞게 사용자가
      // 직접 보정하는 용도이므로, 가로/세로를 마우스 이동량 그대로 독립적으로
      // 반영해 자유롭게(비율 고정 없이) 모양을 바꿀 수 있어야 한다. 대신 이 드래그로
      // 달라진 "면적 증가율"만 별도로 계산해 다른 오버레이들에 전파한다(아래 onUp).
      const startWidthPct = imgPercent.width
      const startHeightPct = imgPercent.height

      overlay.classList.add('resizing')
      document.body.style.userSelect = 'none'

      const onMove = (moveEvent) => {
        let mx = ((moveEvent.clientX - containerRect.left) / containerRect.width) * 100
        let my = ((moveEvent.clientY - containerRect.top) / containerRect.height) * 100
        mx = Math.max(0, Math.min(100, mx))
        my = Math.max(0, Math.min(100, my))

        let width = Math.max(_FIGURE_OVERLAY_MIN_SIZE_PCT, Math.abs(mx - fixedX))
        let height = Math.max(_FIGURE_OVERLAY_MIN_SIZE_PCT, Math.abs(my - fixedY))
        let left = mx < fixedX ? fixedX - width : fixedX
        let top = my < fixedY ? fixedY - height : fixedY

        left = Math.max(0, Math.min(left, 100 - width))
        top = Math.max(0, Math.min(top, 100 - height))

        imgPercent.left = left
        imgPercent.top = top
        imgPercent.width = width
        imgPercent.height = height

        overlay.style.left = `${left}%`
        overlay.style.top = `${top}%`
        overlay.style.width = `${width}%`
        overlay.style.height = `${height}%`
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        overlay.classList.remove('resizing')
        document.body.style.userSelect = ''

        const growthFactor = (imgPercent.width * imgPercent.height) / (startWidthPct * startHeightPct)
        _propagateOverlayAreaGrowth(imgPercent, growthFactor)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })

    overlay.appendChild(handle)
  })
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
    overlay.tabIndex = 0
    overlay.setAttribute('role', 'button')
    overlay.setAttribute('aria-label', t('viewer:a11y.imageOverlay'))
    overlay.addEventListener('keydown', (event) => {
      if (event.target === overlay && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); overlay.click()
      }
    })

    overlay.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      globalAnalyticsTracker.trackInteraction('figureClick', pageNum)

      // Clear text selection
      window.getSelection().removeAllRanges()

      const canvas = inner.querySelector('canvas')
      if (!canvas) return

      try {
        const base64Img = cropFigureFromCanvas(canvas, imgPercent)
        // 감지된 박스를 클릭하면 곧장 채팅 인용으로 넣어 바로 질문을 타이핑할
        // 수 있게 한다 - 자유 드래그 캡처 도구(아래 initCropTool)와 동일한
        // 패턴. 예전에는 클릭 시 작은 선택 메뉴를 띄우고 그 안의 "AI에게
        // 질문" 버튼을 한 번 더 눌러야 했는데, 이 메뉴엔 그 버튼 하나뿐이라
        // 불필요한 중간 단계였다.
        toggleCropMode(false)
        askAIAssistantImage(base64Img, pageNum)
      } catch (err) {
        console.error("그림 크롭 실패:", err)
        showToast("캡처에 실패했습니다.", "error")
      }
    })

    _attachFigureOverlayResizeHandles(overlay, imgPercent, inner)

    layer.appendChild(overlay)
  })

  inner.appendChild(layer)
}

// 본문 인용 표기 네 스타일을 지원한다:
// 1) 번호 인용: [12], [12, 13], [12-14], [1,3,5-8](단일 번호와 범위 혼합)
// 2) 키워드 인용(alpha 스타일 BibTeX): [BCV13], [BCV13, Dev86] - 저자 이니셜+
//    연도 형태의 키(예: VAE 논문의 [BCV13], [Dev86])도 순수 숫자와 동일하게
//    대괄호 토큰으로 취급한다. 백엔드 reference_parser.py의 _BRACKET_ENTRY_RE도
//    동일한 키 형식을 파싱한다.
// 3) 괄호형 저자-연도 인용: (Smith, 2020), (Smith et al., 2020),
//    (Smith & Jones, 2020), (Smith, 2020; Jones, 2019) 등 - 백엔드
//    reference_parser.py의 _parse_author_year_entries와 동일하게 "저자
//    성(소문자)+연도"를 키로 매칭한다.
// 4) 서술형 저자-연도 인용: 저자가 괄호 밖에 오고 연도만 괄호 안에 있는
//    "Smith (2020)", "Li and Wang (2023)", "Smith et al. (2020)" 등.
//
// 대괄호 안 토큰 하나 - 순수 숫자(1~3자리) 또는 "BCV13"류 키워드 키(영문
// 1~6자 + 선택적 "+" + 숫자 2~4자리 + 선택적 소문자 접미사)만 인정한다.
// 백엔드 reference_parser.py의 _BRACKET_KEY_RE와 반드시 같은 모양을 유지할
// 것 - 숫자가 전혀 없는 순수 알파벳 키(예: 참고문헌 항목 안에 흔한
// "[Online]", "[Internet]" 같은 서지 매체 표기)까지 토큰으로 인정하면,
// 우연히 refMap에 같은 이름의 키가 있는 경우(드물지만 가능) 엉뚱한 곳에
// 오버레이가 걸릴 여지가 생긴다. 실제로 참고문헌 목록에 있는 키인지는 아래
// addCitationBox 호출부에서 refMap 존재 여부로 한 번 더 걸러진다.
const CITATION_TOKEN_SRC = '(?:\\d{1,3}|[A-Za-z]{1,6}\\+?\\d{2,4}[a-z]?)'
// 대괄호 목록의 항목 하나는 위 단일 키이거나, 숫자 범위("12-14")일 수 있다 -
// 범위는 CITATION_TOKEN_SRC 모양에 안 맞으므로(하이픈 포함) 마커 탐지
// 단계에서 별도 대안으로 허용해두고, 실제 펼치기는 extractBracketCitationItems가 한다.
const CITATION_LIST_ITEM_SRC = `(?:\\d{1,3}\\s*[-–]\\s*\\d{1,3}|${CITATION_TOKEN_SRC})`
const CITATION_MARKER_RE = new RegExp(
  `\\[\\s*${CITATION_LIST_ITEM_SRC}(?:\\s*,\\s*${CITATION_LIST_ITEM_SRC})*\\s*\\]`, 'g'
)
// 여는 괄호 바로 뒤 대문자로 시작하고, 닫는 괄호 전 20자 이내에 4자리 연도가
// 있어야 인용으로 인정한다(오탐 방지 - 그냥 "(그림 2020년 기준)" 같은 일반
// 괄호 문구가 걸리지 않도록 대문자 시작 + 연도 둘 다 요구).
const CITATION_AUTHOR_YEAR_MARKER_RE = /\([A-ZÀ-Ö][^()]{2,160}?\d{4}[a-z]?[^()]{0,20}\)/g
// 서술형 저자-연도: 저자명(과 "and"/"&"로 이어지는 공저자, 또는 "et al.")
// 뒤에 곧바로 "(2020)"류 연도만 담긴 괄호가 온다. 콤마나 이니셜이 중간에
// 끼면 REF_ENTRY_AUTHOR_YEAR_RE(참고문헌 목록 항목)이 담당할 형태이므로
// 여기서는 매칭하지 않는다 - 두 정규식이 References 섹션 안에서 같은
// 텍스트에 중복으로 걸리는 것을 방지.
const CITATION_NARRATIVE_AUTHOR_YEAR_RE =
  /\b([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ\-']+)(?:\s+(?:and|&)\s+[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ\-']+)?(?:\s+et\s+al\.?)?\s+\((\d{4})[a-z]?\)/g

// "[12, 14-16]", "[BCV13, Dev86]", "[1,3,5-8]" 형태의 대괄호 안 내용을
// 항목별 위치 정보와 함께 뽑아낸다. 쉼표로 나열된 각 항목은 독립적인
// 오버레이를 갖는다("[1, 2, 3]" -> 각 번호마다 별도 오버레이). 단, "5-8"
// 같은 범위 표기는 문서 상에서 하나로 붙어 있는 토큰이라 쪼갤 수 없으므로
// 범위 전체가 하나의 오버레이를 갖되, 그 안에 펼쳐진 모든 번호를 함께
// 담아 툴팁에서 전부 보여준다.
const CITATION_ITEM_RE = new RegExp(CITATION_LIST_ITEM_SRC, 'g')
function extractBracketCitationItems(fullText, match) {
  const innerStart = match.index + 1
  const innerEnd = match.index + match[0].length - 1
  const inner = fullText.slice(innerStart, innerEnd)
  const items = []
  CITATION_ITEM_RE.lastIndex = 0
  let m
  while ((m = CITATION_ITEM_RE.exec(inner)) !== null) {
    const start = innerStart + m.index
    const end = start + m[0].length
    const range = m[0].match(/^(\d{1,3})\s*[-–]\s*(\d{1,3})$/)
    if (range) {
      const rangeStart = parseInt(range[1], 10)
      const rangeEnd = parseInt(range[2], 10)
      // 비정상적으로 넓은 범위(오탐 - 예: 페이지/연도 범위 오인)는 무시
      const keys = (rangeEnd >= rangeStart && rangeEnd - rangeStart <= 50)
        ? Array.from({ length: rangeEnd - rangeStart + 1 }, (_, i) => String(rangeStart + i))
        : []
      items.push({ start, end, keys })
    } else {
      items.push({ start, end, keys: [m[0]] })
    }
  }
  return items
}

// 참고문헌 목록 항목 자체의 "시작 표기"를 찾기 위한 정규식들(대괄호가 없는
// 스타일 전용 - 대괄호 스타일은 위 CITATION_MARKER_RE가 위치와 무관하게 이미
// 잡아낸다). References 섹션 안에서만 적용되므로(위 renderCitationOverlayLayer
// 참고), 본문 절 번호("2. Introduction")나 서술형 인용("Smith (2020)는...")과
// 헷갈릴 걱정 없이 폭넓게 잡아도 된다.
//
// 번호형: "12. Author..." / "12) Author..." - 백엔드의 _PLAIN_NUMBERED_ENTRY_RE와
// 동일한 형태를, 뒤에 대문자(또는 한글)로 시작하는 저자명이 이어질 때만 인정한다.
const REF_ENTRY_PLAIN_NUMBER_RE = /\b(\d{1,3})[.)]\s+(?=[A-Z가-힣])/g
// 저자-연도형: "Author, A. ... (2020)." - 백엔드의 _AUTHOR_YEAR_ENTRY_START_RE
// (성+쉼표로 시작) 와 _YEAR_RE(괄호 안 4자리 연도)를 하나로 합친 형태. 본문
// 인용 표기와 달리 연도가 그 자체로 괄호에 싸여 있고 저자 이름은 괄호 밖에
// 있는 문헌 목록 서식(APA류)을 겨냥한다.
const REF_ENTRY_AUTHOR_YEAR_RE = /\b([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ\-']+),\s[^()]{0,160}?\((\d{4})[a-z]?\)/g

// "(Smith, 2020; Jones et al., 2019)" 형태를 세미콜론 기준으로 나눠, 각
// 항목의 위치 정보와 함께 반환한다 - 항목마다 독립적인 오버레이를 걸기
// 위함이다("(Morrill et al., 2021; Kidger et al., 2020)" -> 각 인용마다
// 별도 오버레이). 공저자 나열/"et al." 등 세부 내용은 굳이 파싱하지 않고
// 앞쪽 저자 성과 끝쪽 연도만 앵커로 뽑는다.
function extractAuthorYearClauses(fullText, match) {
  const innerStart = match.index + 1
  const innerEnd = match.index + match[0].length - 1
  const inner = fullText.slice(innerStart, innerEnd)
  const clauses = []
  let cursor = 0
  inner.split(';').forEach(rawPart => {
    const partStart = cursor
    cursor += rawPart.length + 1 // ';' 구분자 1글자만큼 다음 조각 시작 위치를 밀어줌
    const leading = rawPart.match(/^\s*/)[0].length
    const trailing = rawPart.match(/\s*$/)[0].length
    const text = rawPart.slice(leading, rawPart.length - trailing)
    if (!text) return
    const surnameMatch = text.match(/^([A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ\-']+)/)
    const yearMatch = text.match(/(\d{4})[a-z]?/)
    if (!surnameMatch || !yearMatch) return
    clauses.push({
      start: innerStart + partStart + leading,
      end: innerStart + partStart + rawPart.length - trailing,
      key: `${surnameMatch[1].toLowerCase()}${yearMatch[1]}`,
    })
  })
  return clauses
}

// 참고문헌 맵의 키 형식(순수 숫자 vs "저자성+연도")으로 이 논문이 Number
// Citation 스타일인지 Author-Year 스타일인지 판단한다. 스타일을 미리
// 알면 반대 스타일 정규식은 아예 돌리지 않아, "Dimension = [64, 128, 256]"
// 같은 숫자 배열이 Author-Year 논문에서 대괄호 인용으로 오인되는 등의
// 오탐을 원천적으로 줄일 수 있다. 두 스타일이 섞여 있거나 아직 참고문헌이
// 없으면(null) 두 스타일을 모두 검사하는 기존 동작으로 안전하게 폴백한다.
function detectCitationStyle(refMap) {
  const keys = Object.keys(refMap)
  if (keys.length === 0) return null
  let numeric = 0, authorYear = 0
  keys.forEach(k => { /^\d+$/.test(k) ? numeric++ : authorYear++ })
  if (numeric > 0 && authorYear === 0) return 'number'
  if (authorYear > 0 && numeric === 0) return 'author-year'
  return 'mixed'
}

// References/Bibliography/참고문헌 섹션 헤더 판별 - 백엔드 reference_parser.py의
// _HEADER_PREFIX_RE와 같은 키워드를 인정한다(문단 시작 위치에서만 - 본문 중간에
// "...자세한 내용은 References를 참고하라" 같은 일반 문장이 섹션 시작으로
// 오인되지 않도록 fullText 시작 또는 문단 구분자 \n\n 뒤에서만 매칭한다).
const REFERENCES_HEADER_RE = /(?:^|\n\n)\s*\**\s*(?:References|Bibliography|참고문헌)\b/i

// vtm.fullText에서 References 헤더를 찾아 이 페이지를 문서의 참고문헌 섹션
// 시작 페이지로 state에 기록한다. 페이지는 스크롤에 따라 순서 없이(뒤늦게)
// 렌더링될 수 있어, 이미 더 이른 페이지 번호가 기록돼 있으면 덮어쓰지 않는다.
// 반환값은 "이 페이지에서 참고문헌 섹션이 시작하는 문자 오프셋"이다:
// 아직 섹션을 못 찾았거나 이 페이지가 섹션 이전이면 -1, 헤더가 있던 페이지보다
// 뒤 페이지면(전체가 참고문헌 섹션) 0, 헤더가 있는 페이지 자신이면 헤더 위치.
function detectReferencesSectionStart(vtm, pageNum) {
  const m = REFERENCES_HEADER_RE.exec(vtm.fullText)
  if (m && (state.referencesHeaderPageNum === null || pageNum < state.referencesHeaderPageNum)) {
    state.referencesHeaderPageNum = pageNum
  }
  if (state.referencesHeaderPageNum === null || pageNum < state.referencesHeaderPageNum) return -1
  if (pageNum > state.referencesHeaderPageNum) return 0
  return m ? m.index : 0
}

// 본문 인용 표기 오버레이 - 참고문헌 목록에 실제로 존재하는 항목을 가리키는
// 표기만 클릭 가능하게 만든다(오탐/미매칭 표기까지 다 클릭되게 하면 클릭할
// 때마다 404 토스트만 뜨는 경험이 되므로).
function renderCitationOverlayLayer(textLayerDiv, pageNum) {
  const pageWrapper = textLayerDiv.closest('.pdf-page-wrapper')
  if (!pageWrapper) return

  const overlay = getOrCreateOverlay(pageWrapper)
  overlay.querySelectorAll('.citation-marker-box').forEach(el => el.remove())
  if (state.disableCitationOverlay) return

  const refMap = state.referenceMap || {}
  if (Object.keys(refMap).length === 0) return

  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
  if (!vtm || !vtm.fullText) return

  const docId = state.currentDocId
  if (!docId) return

  const referencesSectionStart = detectReferencesSectionStart(vtm, pageNum)

  // 이 문서가 Number 스타일인지 Author-Year 스타일인지 미리 알면, 반대
  // 스타일 정규식은 아예 돌리지 않는다 - 예를 들어 문서가 Author-Year
  // 스타일이면 "[64, 128, 256]" 같은 순수 숫자 배열은 애초에 대괄호 인용
  // 후보로 검사조차 하지 않으므로 오탐 여지가 없다. 스타일이 섞여 있거나
  // (mixed) 아직 판별하지 못했으면(null) 기존처럼 두 스타일 모두 검사한다.
  const citationStyle = state.citationStyle
  const checkNumberStyle = citationStyle !== 'author-year'
  const checkAuthorYearStyle = citationStyle !== 'number'

  // refKeys(여러 개일 수 있음)를 받아 하나의 오버레이 박스를 그린다. 툴팁에는
  // refMap에 실제로 존재하는 키의 원문을 전부 이어붙여 보여준다("[66-69]"
  // 같은 범위 인용이 여러 참고문헌을 한 번에 가리키는 경우를 위함).
  const addCitationBox = (charStart, charEnd, refKeys) => {
    const validKeys = refKeys.filter(k => refMap[k])
    if (validKeys.length === 0) return
    const rects = getSentenceRects({ charStart, charEnd }, vtm, textLayerDiv)
    rects.forEach(r => {
      const box = document.createElement('div')
      box.className = 'citation-marker-box'
      box.style.left   = `${r.left}px`
      box.style.top    = `${r.top}px`
      box.style.width  = `${r.width}px`
      box.style.height = `${r.height}px`
      box.dataset.refNum = validKeys.join(',')
      box.tabIndex = 0
      box.setAttribute('role', 'button')
      box.setAttribute('aria-haspopup', 'dialog')
      box.setAttribute('aria-expanded', 'false')
      box.setAttribute('aria-label', t('viewer:a11y.citationTrigger', { references: validKeys.join(', ') }))
      box.addEventListener('mouseenter', () => showCitationTooltip(docId, validKeys, refMap, box))
      box.addEventListener('mouseleave', scheduleCitationTooltipHide)
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation()
          showCitationTooltip(docId, validKeys, refMap, box, { focus: true })
        } else if (event.key === 'Escape') {
          event.preventDefault(); hideCitationTooltip(); box.focus()
        }
      })
      // 클릭도 항상 툴팁을 띄운다(호버가 없는 터치 기기 대응). 실제 마우스
      // 클릭은 브라우저가 클릭 직전에 mouseenter를 먼저 쏘므로, 여기서 굳이
      // "이미 열려 있으면 닫기" 토글을 넣으면 방금 호버가 연 툴팁을 클릭이
      // 곧바로 다시 닫아버리는 문제가 있어 단순히 show만 호출한다. 닫기는
      // 바깥 클릭/스크롤/mouseleave로 처리한다.
      box.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        globalAnalyticsTracker.trackInteraction('citationClick', pageNum)
        showCitationTooltip(docId, validKeys, refMap, box)
      })
      overlay.appendChild(box)
    })
  }

  let match

  if (checkNumberStyle) {
    // "[1, 2, 3]"은 번호마다, "[66-69]"는 범위 전체가 하나로(내부에 66~69
    // 전부 담아) 독립적인 오버레이를 갖는다. "[1,3,5-8]" 같은 혼합 표현도
    // 항목 단위로 처리되므로 자연스럽게 지원된다.
    CITATION_MARKER_RE.lastIndex = 0
    while ((match = CITATION_MARKER_RE.exec(vtm.fullText)) !== null) {
      extractBracketCitationItems(vtm.fullText, match).forEach(item => {
        addCitationBox(item.start, item.end, item.keys)
      })
    }
  }

  if (checkAuthorYearStyle) {
    // "(Morrill et al., 2021; Kidger et al., 2020; Walker et al., 2024)"처럼
    // 세미콜론으로 묶인 여러 인용도 각각 독립적인 오버레이를 갖는다.
    CITATION_AUTHOR_YEAR_MARKER_RE.lastIndex = 0
    while ((match = CITATION_AUTHOR_YEAR_MARKER_RE.exec(vtm.fullText)) !== null) {
      extractAuthorYearClauses(vtm.fullText, match).forEach(clause => {
        addCitationBox(clause.start, clause.end, [clause.key])
      })
    }

    // "Smith (2020)", "Li and Wang (2023)" 같은 서술형 인용
    CITATION_NARRATIVE_AUTHOR_YEAR_RE.lastIndex = 0
    while ((match = CITATION_NARRATIVE_AUTHOR_YEAR_RE.exec(vtm.fullText)) !== null) {
      const key = `${match[1].toLowerCase()}${match[2]}`
      addCitationBox(match.index, match.index + match[0].length, [key])
    }
  }

  // 참고문헌 목록 자체(대괄호가 없는 스타일)에도 오버레이를 건다 - 위 정규식들은
  // 대괄호 인용([12]) 또는 괄호/서술형 저자-연도 인용((Smith, 2020), Smith
  // (2020))만 잡아내는데, 참고문헌 목록의 각 항목 시작 표기는 스타일에 따라
  // 그 어느 쪽에도 안 걸리는 경우가 있다("12. Author..." 같은 번호형, "Author,
  // A. (2020). Title..." 같은 저자-연도형). 참고문헌 목록을 훑어보다가 바로
  // 그 자리에서 원문 링크/Scholar 검색을 쓸 수 있도록, References 헤더 이후
  // 영역에서만 이 두 표기도 추가로 인용 표기로 인정한다(섹션 밖에서 걸면
  // "2. Introduction" 같은 절 번호나 "Smith (2020)는..." 같은 서술형 문장까지
  // 오탐될 위험이 크다).
  if (referencesSectionStart >= 0) {
    if (checkNumberStyle) {
      REF_ENTRY_PLAIN_NUMBER_RE.lastIndex = 0
      while ((match = REF_ENTRY_PLAIN_NUMBER_RE.exec(vtm.fullText)) !== null) {
        if (match.index < referencesSectionStart) continue
        addCitationBox(match.index, match.index + match[0].length, [match[1]])
      }
    }

    if (checkAuthorYearStyle) {
      REF_ENTRY_AUTHOR_YEAR_RE.lastIndex = 0
      while ((match = REF_ENTRY_AUTHOR_YEAR_RE.exec(vtm.fullText)) !== null) {
        if (match.index < referencesSectionStart) continue
        const key = `${match[1].toLowerCase()}${match[2]}`
        addCitationBox(match.index, match.index + match[0].length, [key])
      }
    }
  }
}

// 본문 중 "Figure 1", "Figs. 3-5", "Table 2", "Eq. (3)" 같은 표기를 감지해,
// 호버 시 실제 해당 그림/표/수식을 오버레이로 미리 보여준다(멀리 떨어진
// 페이지로 매번 스크롤해서 찾아보러 가야 하는 불편을 줄이기 위함). 인용 표기
// 오버레이와 동일한 원칙으로, 백엔드가 좌표+라벨을 뽑아낸(=documentImages에
// 실제로 존재하는) 대상을 가리키는 표기만 호버 가능한 박스로 그린다.
//
// 일부 논문은 Figure/Table/수식 번호를 아라비아 숫자 대신 로마 숫자(I, II, III...)로
// 매긴다(부록 표/수식에 흔함). backend(pdf_parser.py)의 _ROMAN_NUMERAL_RE와 동일한
// 표준 로마 숫자(1~3999) 검증 패턴 - "IVX" 같은 무효한 조합은 배제한다. 맨 앞의
// lookahead는 그룹이 전부 빈 문자열로 매칭되어 공백이 "로마 숫자"로 인정되는 것을 막는다.
const ROMAN_NUMERAL_SRC = '(?=[MDCLXVI])M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})'

const FIGURE_TABLE_NUM_SRC = `(?:\\d+|${ROMAN_NUMERAL_SRC})`
// 숫자 본체 하나: "(1)"처럼 괄호로 감싼 형태(Equation 표기에 흔함) 또는 맨 숫자.
const FIGURE_TABLE_NUM_CORE_SRC = `(?:\\(\\s*${FIGURE_TABLE_NUM_SRC}\\s*\\)|${FIGURE_TABLE_NUM_SRC})`
// Subfigure 접미사: 숫자 바로 뒤에 공백 없이 붙는 글자 하나("Fig. 2f", "Figure 5B")
// 또는 괄호로 묶인 글자 목록("Fig. 4(a,b,c)", "Fig. 2(a)"). 뒤에 글자/숫자가 더
// 이어지면("Fig. 2nd"의 "nd") 서수 등 참조와 무관한 단어의 일부일 수 있으므로
// 매칭하지 않는다(다음 문자가 알파벳/숫자가 아닐 때만 인정).
const FIGURE_TABLE_SUBFIG_SUFFIX_SRC =
  `(?:[a-zA-Z](?![a-zA-Z0-9])|\\(\\s*[a-zA-Z](?:\\s*[-–,]\\s*[a-zA-Z])*\\s*\\))`
// 숫자 하나 + (있다면) subfigure 접미사. 접미사가 없다면 바로 뒤에 글자/숫자가
// 이어지면 안 된다("Fig 2nd"처럼 서수나 다른 단어의 일부인 경우를 배제).
const FIGURE_TABLE_NUM_ITEM_SRC =
  `${FIGURE_TABLE_NUM_CORE_SRC}(?:${FIGURE_TABLE_SUBFIG_SUFFIX_SRC}|(?![a-zA-Z0-9]))`
// 새 숫자를 잇는 느슨한 연결어(공백 허용): "Figs. 1 and 2", "Tables 1, 2", "Figs. 3-5".
const FIGURE_TABLE_LOOSE_CONNECTOR_SRC = `\\s*(?:[-–—,]|and|&)\\s*`
// subfigure 글자만 이어붙이는 빡빡한 연결어(공백 없음): "Fig. 6a,c"의 ",c",
// "Fig. 2a-d"의 "-d". 공백이 있으면("Fig. 3, a detailed...") 일반 문장의 일부일
// 가능성이 높으므로, subfigure 이어붙이기는 반드시 공백이 없는 경우만 인정한다.
// 이렇게 tight/loose를 구분해두면, subfigure 글자가 로마 숫자 알파벳(I/V/X/L/C/D/M)과
// 겹치는 경우("Fig. 3b,d,e"의 "d") 새 로마 숫자 대상이 아니라 subfigure로
// 해석하는 쪽을 우선할 수 있다 - 실제 로마 숫자 다중 나열(예: "Tables I and V")은
// 항상 공백이 있는 연결어를 쓰기 때문에 이 우선순위가 서로 충돌하지 않는다.
const FIGURE_TABLE_TIGHT_CONNECTOR_SRC = `[,\\-–—]`
const FIGURE_TABLE_BARE_LETTER_ITEM_SRC = `[a-zA-Z](?![a-zA-Z0-9])`
const FIGURE_TABLE_CONT_ITEM_SRC =
  `(?:${FIGURE_TABLE_TIGHT_CONNECTOR_SRC}${FIGURE_TABLE_BARE_LETTER_ITEM_SRC}` +
  `|${FIGURE_TABLE_LOOSE_CONNECTOR_SRC}${FIGURE_TABLE_NUM_ITEM_SRC})`
// 키워드 뒤에 \b를 둔 이유: "Tab"이 실제로는 "Table"/"Tablet" 같은 더 긴 단어의
// 일부인데, 뒤에 남은 글자(예: "Table tennis"의 "le")가 우연히 로마 숫자+subfigure
// 접미사로 파싱되어 "Tab"만 키워드로 잘못 채택되는 경우가 있다(Tables?가 실패하면
// 엔진이 Tabs? 같은 더 짧은 대안으로 백트래킹하기 때문). \b를 두면 "Tab"과 그
// 다음 글자 사이에 실제 단어 경계가 없는 이상 이 대안 자체가 거부된다.
const FIGURE_TABLE_REF_RE = new RegExp(
  `\\b(Figures?|Figs?|Tables?|Tabs?|Equations?|Eqns?|Eqs?)\\b\\.?\\s*` +
  `(${FIGURE_TABLE_NUM_ITEM_SRC}(?:${FIGURE_TABLE_CONT_ITEM_SRC})*)`,
  'gi'
)

function normalizeFigureTableKind(keyword) {
  const kw = keyword.toLowerCase()
  if (kw.startsWith('fig')) return 'Figure'
  if (kw.startsWith('tab')) return 'Table'
  return 'Equation'
}

// FIGURE_TABLE_REF_RE가 캡처한 payload(예: "6a,c", "3-5", "(4) and (5)")를
// 개별 Figure/Table/Equation 번호 목록으로 펼친다.
// - 숫자 뒤에 공백 없이 붙는 subfigure 접미사(글자, "(a,b,c)")는 무시한다
//   (backend가 여러 subfigure 패널을 하나의 bbox로 병합해 저장하므로
//   documentImages 매칭에는 상위 Figure 번호만 있으면 된다).
// - 빡빡한 연결어(공백 없는 ','/'-') 뒤에 오는 글자 하나는 새 숫자가 아니라
//   직전 숫자의 subfigure 이어붙이기로 보고 무시한다.
// - 공백이 있는 연결어(", "/" and "/" & ") 뒤에 오는 숫자는 새로운 대상이다.
// - 대시로 이어진 순수 아라비아 숫자 두 개("3-5")는 그 사이 숫자를 모두 포함하는
//   범위로 펼친다(로마 숫자 범위는 흔치 않아 지원하지 않음).
function parseFigureTableNumberList(payload) {
  const numbers = []
  let i = 0
  const s = payload

  function matchHere(re) {
    re.lastIndex = i
    const m = re.exec(s)
    return (m && m.index === i) ? m : null
  }

  const numCoreRe = new RegExp(`\\(?\\s*(\\d+|${ROMAN_NUMERAL_SRC})\\s*\\)?`, 'iy')
  const subfigSkipRe = new RegExp(FIGURE_TABLE_SUBFIG_SUFFIX_SRC, 'iy')
  const tightConnRe = new RegExp(FIGURE_TABLE_TIGHT_CONNECTOR_SRC, 'y')
  const looseConnRe = new RegExp(`\\s*(?:([-–—])|,|and|&)\\s*`, 'iy')
  const bareLetterRe = new RegExp(FIGURE_TABLE_BARE_LETTER_ITEM_SRC, 'y')

  function readNumber() {
    const m = matchHere(numCoreRe)
    if (!m) return null
    i += m[0].length
    const raw = m[1]
    const isRoman = !/^\d+$/.test(raw)
    const value = isRoman ? raw.toUpperCase() : raw
    const sm = matchHere(subfigSkipRe) // subfigure 접미사는 건너뛰기만 함
    if (sm) i += sm[0].length
    return { value, isRoman }
  }

  const first = readNumber()
  if (!first) return []
  numbers.push(first.value)
  let lastWasPlainDecimal = !first.isRoman

  while (i < s.length) {
    const save = i
    // 1) 빡빡한 연결어 + subfigure 글자 (새 숫자로 추가하지 않고 건너뛴다)
    const tm = matchHere(tightConnRe)
    if (tm) {
      i += tm[0].length
      const bm = matchHere(bareLetterRe)
      if (bm) { i += bm[0].length; continue }
      i = save // 글자가 아니면 되돌리고 느슨한 연결어 시도로 넘어감
    }
    // 2) 느슨한 연결어 + 새 숫자
    const lm = matchHere(looseConnRe)
    if (lm) {
      const isDash = !!lm[1]
      i += lm[0].length
      const next = readNumber()
      if (next) {
        if (isDash && lastWasPlainDecimal && !next.isRoman) {
          const start = parseInt(numbers[numbers.length - 1], 10)
          const end = parseInt(next.value, 10)
          if (end >= start && end - start <= 50) {
            for (let n = start + 1; n <= end; n++) numbers.push(String(n))
          } else {
            numbers.push(next.value)
          }
        } else {
          numbers.push(next.value)
        }
        lastWasPlainDecimal = !next.isRoman
        continue
      }
      i = save
    }
    break
  }

  return numbers
}

function renderFigureRefOverlayLayer(textLayerDiv, pageNum) {
  const pageWrapper = textLayerDiv.closest('.pdf-page-wrapper')
  if (!pageWrapper) return

  const overlay = getOrCreateOverlay(pageWrapper)
  overlay.querySelectorAll('.figure-ref-marker-box').forEach(el => el.remove())
  if (state.disableFigureOverlay) return

  const images = state.documentImages || []
  if (images.length === 0) return

  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
  if (!vtm || !vtm.fullText) return

  FIGURE_TABLE_REF_RE.lastIndex = 0
  let match
  while ((match = FIGURE_TABLE_REF_RE.exec(vtm.fullText)) !== null) {
    // 로마 숫자 대안 분기는 lookahead만으로 빈 문자열 매칭을 완전히 막지 못해
    // "Table Introduction..."처럼 로마 숫자 글자로 시작하는 일반 단어도 숫자 그룹이
    // 빈 문자열로 매칭될 수 있다 - 이런 경우는 실제 참조 표기가 아니므로 건너뛴다.
    if (!match[2]) continue
    const kind = normalizeFigureTableKind(match[1])
    const numbers = parseFigureTableNumberList(match[2])
    const targets = numbers
      .map(n => images.find(img => img.label === `${kind} ${n}`))
      .filter(Boolean)
    if (targets.length === 0) continue

    const rects = getSentenceRects({ charStart: match.index, charEnd: match.index + match[0].length }, vtm, textLayerDiv)
    rects.forEach(r => {
      const box = document.createElement('div')
      box.className = 'figure-ref-marker-box'
      box.style.left   = `${r.left}px`
      box.style.top    = `${r.top}px`
      box.style.width  = `${r.width}px`
      box.style.height = `${r.height}px`
      box.tabIndex = 0
      box.setAttribute('role', 'button')
      box.setAttribute('aria-haspopup', 'dialog')
      box.setAttribute('aria-expanded', 'false')
      box.setAttribute('aria-label', t('viewer:a11y.figureTrigger', { label: targets.map(target => target.label).join(', ') }))
      box.addEventListener('mouseenter', () => showFigurePreviewTooltip(targets, box))
      box.addEventListener('mouseleave', scheduleFigurePreviewTooltipHide)
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation()
          showFigurePreviewTooltip(targets, box, { focus: true })
        } else if (event.key === 'Escape') {
          event.preventDefault(); hideFigurePreviewTooltip(); box.focus()
        }
      })
      // 클릭하면 해당 그림/표/수식이 실제로 있는 페이지로 이동한다. 여러 개를
      // 한 번에 가리키는 표기("Figures 1 and 2")는 첫 번째 대상 기준으로
      // 이동하고, 나머지는 미리보기 툴팁 안의 각 항목을 클릭해 개별 이동한다.
      box.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        window.getSelection().removeAllRanges()
        const interactionType = kind === 'Table' ? 'tableClick' : (kind === 'Equation' ? 'equationClick' : 'figureClick')
        globalAnalyticsTracker.trackInteraction(interactionType, pageNum)
        hideFigurePreviewTooltip()
        scrollToPage(viewerScrollContainer, targets[0].page)
      })
      overlay.appendChild(box)
    })
  }
}

// ── Figure/Table/Equation 참조 호버 미리보기 툴팁 ──────────
let figurePreviewTooltipEl = null
let figurePreviewHideTimer = null
let figurePreviewBoxEl = null
let figurePreviewRequestId = 0
// 리사이즈 드래그 도중, 아직 커지지 않은 박스 경계를 커서가 순간적으로
// 벗어나 mouseleave가 튀는 경우가 있다 - 드래그 중엔 hide 스케줄 자체를
// 완전히 무시해 박스가 리사이즈 도중 사라지는 것을 막는다.
let figurePreviewIsResizing = false

// showFigurePreviewTooltip이 마지막으로 그린 targets 배열 - 툴팁 안 개별
// 항목을 클릭했을 때 어느 페이지로 이동할지 idx로 되찾기 위해 보관한다.
let figurePreviewCurrentTargets = []

// 이미지가 실제 그림/표보다 작아 보인다는 피드백에 따라, 참조 호버
// 미리보기 툴팁 자체를 사용자가 드래그로 키울 수 있게 한다. 한 번 조절한
// 크기는 localStorage에 저장해 다음 호버부터도 유지된다.
const _FIGURE_PREVIEW_SIZE_KEY = 'easypaper_figure_preview_size'
const _FIGURE_PREVIEW_MIN_WIDTH = 220
const _FIGURE_PREVIEW_MIN_HEIGHT = 140

function getOrCreateFigurePreviewTooltip() {
  if (figurePreviewTooltipEl) return figurePreviewTooltipEl
  const el = document.createElement('div')
  el.className = 'figure-preview-tooltip hidden'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', t('viewer:a11y.figureTrigger', { label: '' }))
  el.innerHTML = `<div class="figure-preview-tooltip-items"></div><button type="button" class="figure-preview-tooltip-resize-handle" title="${t('viewer:a11y.figureResize')}" aria-label="${t('viewer:a11y.figureResize')}"></button>`
  document.body.appendChild(el)

  try {
    // 너비만 기억해둔다 - 높이까지 고정해서 복원하면, 이전에 열었던 그림/표와
    // 비율이 다른 대상을 열었을 때 옛 높이가 그대로 남아 이미지+캡션 아래로
    // 빈 여백이 생긴다. 높이는 항상 CSS(height: auto)에 맡겨 그 순간의
    // 콘텐츠 크기에 맞게 정해지도록 둔다.
    const saved = JSON.parse(localStorage.getItem(_FIGURE_PREVIEW_SIZE_KEY) || 'null')
    if (saved && saved.w >= _FIGURE_PREVIEW_MIN_WIDTH) {
      el.style.width = `${saved.w}px`
    }
  } catch {}

  el.addEventListener('mouseenter', () => {
    if (figurePreviewHideTimer) { clearTimeout(figurePreviewHideTimer); figurePreviewHideTimer = null }
  })
  el.addEventListener('mouseleave', scheduleFigurePreviewTooltipHide)
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    const trigger = figurePreviewBoxEl
    hideFigurePreviewTooltip()
    trigger?.focus()
  })
  // 여러 대상이 한 툴팁에 쌓여 있을 때, 특정 항목을 클릭하면 그 항목의
  // 페이지로 이동한다 (내용은 매번 innerHTML로 다시 그려지므로 이벤트
  // 위임으로 한 번만 등록해둔다).
  el.querySelector('.figure-preview-tooltip-items').addEventListener('click', (e) => {
    const itemEl = e.target.closest('.figure-preview-tooltip-item')
    if (!itemEl) return
    const target = figurePreviewCurrentTargets[parseInt(itemEl.dataset.idx, 10)]
    if (!target) return
    hideFigurePreviewTooltip()
    scrollToPage(viewerScrollContainer, target.page)
  })

  const figureResizeHandle = el.querySelector('.figure-preview-tooltip-resize-handle')
  figureResizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startWidth = el.offsetWidth
    const startHeight = el.offsetHeight
    // 이미지는 CSS에서 width:100%; height:auto로 표시되므로 컨테이너 너비가
    // scale배 될 때 이미지의 실제 렌더링 높이도 같은 비율로 커진다. 반면
    // 레이블/캡션 같은 텍스트 영역(chromeHeight)은 너비가 바뀌어도 높이가
    // 거의 그대로다. 너비/높이를 마우스 이동량으로 각각 독립적으로 정하면
    // 이미지 비율과 무관하게 박스 크기가 고정되어 이미지 아래로 빈 공간이
    // 남거나 이미지가 잘려 스크롤이 생기는 문제가 있었다 - 높이를 "이미지
    // 비율을 유지한 채 늘어난 이미지 높이 + 고정된 chromeHeight"로 다시
    // 계산해 너비를 끌면 이미지 비율에 맞게 박스 전체가 adaptive하게
    // 커지고 작아지도록 한다.
    const loadedImgs = Array.from(el.querySelectorAll('.figure-preview-tooltip-img:not(.hidden)'))
    const startImagesHeight = loadedImgs.reduce((sum, img) => sum + img.getBoundingClientRect().height, 0)
    const chromeHeight = startHeight - startImagesHeight
    const maxWidth = Math.min(window.innerWidth * 0.9, 900)
    const maxHeight = Math.min(window.innerHeight * 0.9, 900)
    el.classList.add('resizing')
    figurePreviewIsResizing = true
    if (figurePreviewHideTimer) { clearTimeout(figurePreviewHideTimer); figurePreviewHideTimer = null }

    const onMove = (moveEvent) => {
      const newWidth = Math.max(_FIGURE_PREVIEW_MIN_WIDTH, Math.min(maxWidth, startWidth + (moveEvent.clientX - startX)))
      const scale = startWidth > 0 ? newWidth / startWidth : 1
      const newHeight = Math.max(_FIGURE_PREVIEW_MIN_HEIGHT, Math.min(maxHeight, chromeHeight + startImagesHeight * scale))
      el.style.width = `${newWidth}px`
      el.style.height = `${newHeight}px`
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      el.classList.remove('resizing')
      figurePreviewIsResizing = false
      // 드래그 중엔 실시간 피드백을 위해 높이를 직접 계산해 인라인으로 고정했지만,
      // 드래그가 끝나면 그 고정값을 지워 다시 CSS의 height: auto로 돌려놓는다 -
      // 그래야 이후 다른 비율의 그림/표로 내용이 바뀌어도 높이가 자동으로
      // 맞춰지고, 지금 안 맞는 빈 여백이 남지 않는다. 너비만 기억해둔다.
      el.style.height = ''
      localStorage.setItem(_FIGURE_PREVIEW_SIZE_KEY, JSON.stringify({ w: el.offsetWidth }))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
  figureResizeHandle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 20 : 4
    const maxWidth = Math.min(window.innerWidth * 0.9, 900)
    const maxHeight = Math.min(window.innerHeight * 0.9, 900)
    let width = el.offsetWidth
    let height = el.offsetHeight
    if (event.key === 'ArrowLeft') width -= step
    if (event.key === 'ArrowRight') width += step
    if (event.key === 'ArrowUp') height -= step
    if (event.key === 'ArrowDown') height += step
    width = Math.round(Math.max(_FIGURE_PREVIEW_MIN_WIDTH, Math.min(maxWidth, width)))
    height = Math.round(Math.max(_FIGURE_PREVIEW_MIN_HEIGHT, Math.min(maxHeight, height)))
    el.style.width = `${width}px`
    el.style.height = `${height}px`
    localStorage.setItem(_FIGURE_PREVIEW_SIZE_KEY, JSON.stringify({ w: width }))
    announceA11y(t('viewer:a11y.previewSize', { width, height }))
  })

  figurePreviewTooltipEl = el
  return el
}

function positionFigurePreviewTooltip() {
  if (!figurePreviewTooltipEl || !figurePreviewBoxEl) return
  // 사용자가 리사이즈 핸들을 드래그하는 도중에는 위치를 다시 계산하지 않는다 -
  // 그 사이 이미지 로딩이 끝나 재배치가 걸리면(아래 showFigurePreviewTooltip의
  // imgEl.onload) 커서 아래에서 박스가 튀어 리사이즈가 끊기는 문제가 있었다.
  if (figurePreviewTooltipEl.classList.contains('resizing')) return
  const rect = figurePreviewBoxEl.getBoundingClientRect()
  const tw = figurePreviewTooltipEl.offsetWidth || 280
  const th = figurePreviewTooltipEl.offsetHeight || 160
  let left = rect.left + rect.width / 2 - tw / 2
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8))
  let top = rect.top - th - 10
  if (top < 8) top = rect.bottom + 10
  figurePreviewTooltipEl.style.left = `${left}px`
  figurePreviewTooltipEl.style.top = `${top}px`
}

// targets: documentImages 항목 배열(1개 이상 - "Figures 1 and 2"처럼 여러 개를
// 한 번에 가리키는 표기는 각각을 세로로 쌓아 보여준다)
async function showFigurePreviewTooltip(targets, boxEl, { focus = false } = {}) {
  // 텍스트 드래그 선택 중에 마우스가 마커 박스 위를 스쳐 지나가도(mouseenter)
  // 미리보기가 뜨지 않도록 막는다 - 다른 호버 오버레이들과 동일한 가드.
  if (state.isSelectionDragging) return
  if (figurePreviewHideTimer) { clearTimeout(figurePreviewHideTimer); figurePreviewHideTimer = null }
  if (figurePreviewBoxEl && figurePreviewBoxEl !== boxEl) figurePreviewBoxEl.setAttribute('aria-expanded', 'false')
  figurePreviewBoxEl = boxEl
  boxEl?.setAttribute('aria-expanded', 'true')
  figurePreviewCurrentTargets = targets
  const requestId = ++figurePreviewRequestId

  const tooltip = getOrCreateFigurePreviewTooltip()
  const itemsEl = tooltip.querySelector('.figure-preview-tooltip-items')
  itemsEl.innerHTML = targets.map((target, idx) => `
    <button type="button" class="figure-preview-tooltip-item" data-idx="${idx}" aria-label="${escapeHtml(t('viewer:a11y.figureItem', { label: target.label, page: target.page }))}">
      <div class="figure-preview-tooltip-label">${escapeHtml(target.label)} · p.${target.page}</div>
      <div class="figure-preview-tooltip-loading">${icon('refreshCw', 14, 'style="vertical-align:-2px;margin-right:4px"')}불러오는 중...</div>
      <img class="figure-preview-tooltip-img hidden" alt="" />
      ${target.caption ? `<div class="figure-preview-tooltip-caption">${renderBoldText(target.caption)}</div>` : ''}
    </button>
  `).join('')

  tooltip.classList.remove('hidden')
  positionFigurePreviewTooltip()
  if (focus) window.requestAnimationFrame(() => itemsEl.querySelector('.figure-preview-tooltip-item')?.focus())

  targets.forEach(async (t, idx) => {
    const itemEl = itemsEl.querySelector(`.figure-preview-tooltip-item[data-idx="${idx}"]`)
    if (!itemEl) return
    const loadingEl = itemEl.querySelector('.figure-preview-tooltip-loading')
    const imgEl = itemEl.querySelector('.figure-preview-tooltip-img')
    try {
      const dataUrl = await renderFigureCrop(t.page, t)
      // 그 사이 다른 표기로 호버가 옮겨갔거나 툴팁이 닫혔으면 결과를 버린다
      if (requestId !== figurePreviewRequestId || figurePreviewTooltipEl.classList.contains('hidden')) return
      if (!dataUrl) throw new Error('empty crop')
      imgEl.onload = () => positionFigurePreviewTooltip()
      imgEl.src = dataUrl
      loadingEl.classList.add('hidden')
      imgEl.classList.remove('hidden')
    } catch (e) {
      console.warn('그림/표/수식 미리보기 렌더 실패:', e)
      if (requestId !== figurePreviewRequestId) return
      loadingEl.innerHTML = '미리보기를 불러올 수 없습니다.'
    }
  })
}

function hideFigurePreviewTooltip() {
  if (figurePreviewHideTimer) { clearTimeout(figurePreviewHideTimer); figurePreviewHideTimer = null }
  if (figurePreviewTooltipEl) figurePreviewTooltipEl.classList.add('hidden')
  figurePreviewBoxEl?.setAttribute('aria-expanded', 'false')
  figurePreviewBoxEl = null
}

function scheduleFigurePreviewTooltipHide() {
  if (figurePreviewIsResizing) return
  if (figurePreviewHideTimer) clearTimeout(figurePreviewHideTimer)
  figurePreviewHideTimer = setTimeout(hideFigurePreviewTooltip, 220)
}

document.addEventListener('scroll', () => {
  if (figurePreviewTooltipEl && !figurePreviewTooltipEl.classList.contains('hidden')) hideFigurePreviewTooltip()
}, true)

// ── 인용 표기 호버 툴팁: 참고문헌 원문 + 외부 링크 찾기 + Google Scholar 검색 ──
let citationTooltipEl = null
let citationTooltipHideTimer = null
let citationTooltipDocId = null
let citationTooltipReferences = []
let citationTooltipBoxEl = null

// Tauri 데스크탑 webview는 보안상 window.open()/target="_blank"로 외부
// URL을 새 탭으로 열어주지 않는다(웹 브라우저와 달리 시스템 기본 브라우저를
// 열 권한이 없음) - Google Scholar 검색/참고문헌 링크가 데스크탑 앱에서만
// 아무 반응 없던 원인. @tauri-apps/plugin-opener의 openUrl()로 시스템 기본
// 브라우저를 명시적으로 열어준다. 웹 배포에서는 isTauriDesktop이 항상
// false라 기존 window.open 그대로 동작(동일 frontend/dist 재사용).
async function openExternalUrl(url) {
  if (isTauriDesktop) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
      return
    } catch (err) {
      console.warn('데스크탑에서 외부 링크 열기 실패, 브라우저 방식으로 재시도:', err)
    }
  }
  window.open(url, '_blank', 'noopener')
}

function getOrCreateCitationTooltip() {
  if (citationTooltipEl) return citationTooltipEl
  const el = document.createElement('div')
  el.className = 'citation-tooltip hidden'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', t('viewer:a11y.citationTrigger', { references: '' }))
  el.innerHTML = `
    <div class="citation-tooltip-text"></div>
    <div class="citation-tooltip-result hidden"></div>
    <div class="citation-tooltip-scholar-results hidden"></div>
    <div class="citation-tooltip-actions">
      <button type="button" class="citation-tooltip-action-btn citation-tooltip-resolve-btn">${icon('search', 12, 'style="vertical-align:-2px;margin-right:4px"')}원문 링크 찾기</button>
      <button type="button" class="citation-tooltip-action-btn citation-tooltip-scholar-btn">${icon('externalLink', 12, 'style="vertical-align:-2px;margin-right:4px"')}Google Scholar 검색</button>
    </div>
  `
  document.body.appendChild(el)

  el.addEventListener('mouseenter', () => {
    if (citationTooltipHideTimer) { clearTimeout(citationTooltipHideTimer); citationTooltipHideTimer = null }
  })
  el.addEventListener('mouseleave', scheduleCitationTooltipHide)
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    const trigger = citationTooltipBoxEl
    hideCitationTooltip()
    trigger?.focus()
  })
  el.querySelector('.citation-tooltip-resolve-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    resolveCitationTooltip()
  })
  el.querySelector('.citation-tooltip-scholar-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    const searchableRefs = citationTooltipReferences
      .map(ref => ({ ...ref, title: extractCitationTitle(ref.text) }))
      .filter(ref => ref.title)
    if (searchableRefs.length <= 1) {
      if (searchableRefs.length) openExternalUrl(buildScholarSearchUrl(searchableRefs[0].text))
      return
    }

    const scholarResultsEl = el.querySelector('.citation-tooltip-scholar-results')
    scholarResultsEl.className = 'citation-tooltip-scholar-results'
    scholarResultsEl.innerHTML = searchableRefs.map(ref =>
      `<div class="citation-tooltip-result-item"><span class="citation-tooltip-multi-key">[${escapeHtml(ref.key)}]</span><a href="${escapeHtml(buildScholarSearchUrl(ref.text))}" target="_blank" rel="noopener">${icon('externalLink', 12, 'style="vertical-align:-2px;margin-right:4px;flex-shrink:0"')}<span>${escapeHtml(ref.title)}</span></a></div>`
    ).join('')
    positionCitationTooltip()
  })
  // resolveCitationTooltip()이 innerHTML로 채워 넣는 "원문 링크 찾기" 결과의
  // <a> 태그는 그때그때 새로 생기므로, 매번 리스너를 다는 대신 이 안정적인
  // 부모 요소에 위임해서 한 번만 등록한다.
  el.addEventListener('click', (e) => {
    const anchor = e.target.closest('a[href]')
    if (anchor && isTauriDesktop) {
      e.preventDefault()
      openExternalUrl(anchor.href)
    }
  })

  citationTooltipEl = el
  return el
}

function positionCitationTooltip() {
  if (!citationTooltipEl || !citationTooltipBoxEl) return
  const rect = citationTooltipBoxEl.getBoundingClientRect()
  const tw = citationTooltipEl.offsetWidth || 300
  const th = citationTooltipEl.offsetHeight || 100
  let left = rect.left + rect.width / 2 - tw / 2
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8))
  let top = rect.top - th - 10
  if (top < 8) top = rect.bottom + 10
  top = Math.max(8, Math.min(top, window.innerHeight - th - 8))
  citationTooltipEl.style.left = `${left}px`
  citationTooltipEl.style.top = `${top}px`
}

// refKeys가 여러 개면(예: "[66-69]" 범위 인용, "(A, 2020; B, 2019)" 나열)
// 각 항목을 "[키] 원문" 형태로 구분해 전부 보여준다.
function buildCitationTooltipHtml(refKeys, refMap) {
  if (refKeys.length === 1) return renderBoldText(refMap[refKeys[0]] || '')
  return refKeys
    .map(k => `<div class="citation-tooltip-multi-item"><span class="citation-tooltip-multi-key">[${escapeHtml(k)}]</span> ${renderBoldText(refMap[k] || '')}</div>`)
    .join('\n')
}

function showCitationTooltip(docId, refKeys, refMap, boxEl, { focus = false } = {}) {
  // 텍스트 드래그 선택 중에 마우스가 마커 박스 위를 스쳐 지나가도(mouseenter)
  // 미리보기가 뜨지 않도록 막는다 - 다른 호버 오버레이들과 동일한 가드.
  if (state.isSelectionDragging) return
  if (citationTooltipHideTimer) { clearTimeout(citationTooltipHideTimer); citationTooltipHideTimer = null }
  if (citationTooltipBoxEl && citationTooltipBoxEl !== boxEl) citationTooltipBoxEl.setAttribute('aria-expanded', 'false')
  citationTooltipDocId = docId
  citationTooltipReferences = refKeys.map(key => ({ key, text: refMap[key] || '' }))
  citationTooltipBoxEl = boxEl
  boxEl?.setAttribute('aria-expanded', 'true')

  const tooltip = getOrCreateCitationTooltip()
  tooltip.querySelector('.citation-tooltip-text').innerHTML = buildCitationTooltipHtml(refKeys, refMap)
  const resultEl = tooltip.querySelector('.citation-tooltip-result')
  resultEl.className = 'citation-tooltip-result hidden'
  resultEl.innerHTML = ''
  const scholarResultsEl = tooltip.querySelector('.citation-tooltip-scholar-results')
  scholarResultsEl.className = 'citation-tooltip-scholar-results hidden'
  scholarResultsEl.innerHTML = ''
  const resolveBtn = tooltip.querySelector('.citation-tooltip-resolve-btn')
  resolveBtn.disabled = false
  resolveBtn.innerHTML = `${icon('search', 12, 'style="vertical-align:-2px;margin-right:4px"')}원문 링크 찾기`
  const scholarBtn = tooltip.querySelector('.citation-tooltip-scholar-btn')
  const scholarLabel = refKeys.length > 1 ? 'Google Scholar 개별 검색' : 'Google Scholar 검색'
  scholarBtn.innerHTML = `${icon('externalLink', 12, 'style="vertical-align:-2px;margin-right:4px"')}${scholarLabel}`

  tooltip.classList.remove('hidden')
  positionCitationTooltip()
  if (focus) window.requestAnimationFrame(() => tooltip.querySelector('button:not([disabled]), a[href]')?.focus())
}

function hideCitationTooltip() {
  if (citationTooltipHideTimer) { clearTimeout(citationTooltipHideTimer); citationTooltipHideTimer = null }
  if (citationTooltipEl) citationTooltipEl.classList.add('hidden')
  citationTooltipBoxEl?.setAttribute('aria-expanded', 'false')
  citationTooltipBoxEl = null
}

function scheduleCitationTooltipHide() {
  if (citationTooltipHideTimer) clearTimeout(citationTooltipHideTimer)
  citationTooltipHideTimer = setTimeout(hideCitationTooltip, 220)
}

async function resolveCitationTooltip() {
  if (!citationTooltipEl || !citationTooltipDocId || !citationTooltipReferences.length) return
  const resolveBtn = citationTooltipEl.querySelector('.citation-tooltip-resolve-btn')
  const resultEl = citationTooltipEl.querySelector('.citation-tooltip-result')
  if (resolveBtn.disabled) return

  const requestedDocId = citationTooltipDocId
  const requestedRefs = citationTooltipReferences.map(ref => ({ ...ref }))
  const isCurrentRequest = () => citationTooltipDocId === requestedDocId &&
    citationTooltipReferences.map(ref => ref.key).join('\u0000') === requestedRefs.map(ref => ref.key).join('\u0000')

  resolveBtn.disabled = true
  resolveBtn.innerHTML = `${icon('refreshCw', 12, 'style="vertical-align:-2px;margin-right:4px"')}찾는 중...`

  try {
    const results = await Promise.all(requestedRefs.map(async ref => {
      try {
        return { ...ref, result: await resolveLibraryReference(requestedDocId, ref.key) }
      } catch (error) {
        console.warn(`참고문헌 [${ref.key}] 조회 실패:`, error)
        return { ...ref, result: null, error: true }
      }
    }))

    if (!isCurrentRequest()) return

    const successes = results.filter(item => item.result && item.result.url)
    if (requestedRefs.length === 1 && successes.length) {
      const result = successes[0].result
      resultEl.className = 'citation-tooltip-result'
      const label = result.title ? `${result.title}${result.year ? ` (${result.year})` : ''}` : result.url
      resultEl.innerHTML = `<a href="${escapeHtml(result.url)}" target="_blank" rel="noopener">${icon('externalLink', 12, 'style="vertical-align:-2px;margin-right:4px;flex-shrink:0"')}<span>${escapeHtml(label)}</span></a>`
    } else if (requestedRefs.length > 1) {
      resultEl.className = `citation-tooltip-result${successes.length ? '' : ' citation-tooltip-result-empty'}`
      resultEl.innerHTML = results.map(({ key, result, error }) => {
        if (result && result.url) {
          const label = result.title ? `${result.title}${result.year ? ` (${result.year})` : ''}` : result.url
          return `<div class="citation-tooltip-result-item"><span class="citation-tooltip-multi-key">[${escapeHtml(key)}]</span><a href="${escapeHtml(result.url)}" target="_blank" rel="noopener">${icon('externalLink', 12, 'style="vertical-align:-2px;margin-right:4px;flex-shrink:0"')}<span>${escapeHtml(label)}</span></a></div>`
        }
        const message = error ? '조회 중 오류가 발생했습니다.' : '원문 링크를 찾지 못했습니다.'
        return `<div class="citation-tooltip-result-item citation-tooltip-result-empty"><span class="citation-tooltip-multi-key">[${escapeHtml(key)}]</span><span>${message}</span></div>`
      }).join('')
    } else {
      resultEl.className = 'citation-tooltip-result citation-tooltip-result-empty'
      resultEl.textContent = '원문 링크를 찾지 못했습니다. Google Scholar 검색을 이용해보세요.'
    }
  } catch (e) {
    console.warn('참고문헌 조회 실패:', e)
    resultEl.className = 'citation-tooltip-result citation-tooltip-result-empty'
    resultEl.textContent = '조회 중 오류가 발생했습니다.'
  } finally {
    if (!isCurrentRequest()) return
    resolveBtn.disabled = false
    resolveBtn.innerHTML = `${icon('search', 12, 'style="vertical-align:-2px;margin-right:4px"')}다시 찾기`
    positionCitationTooltip()
  }
}

// PDF 스크롤 중에는 인용 박스와 툴팁의 상대 위치가 계속 바뀌므로, 스크롤이
// 시작되면 곧바로 닫는다(매 스크롤 이벤트마다 재계산하는 것보다 훨씬 가볍다).
document.addEventListener('scroll', (event) => {
  // 참고문헌이 많아 툴팁 자체를 스크롤한 경우에는 열린 상태를 유지한다.
  if (citationTooltipEl && event.target && citationTooltipEl.contains(event.target)) return
  if (citationTooltipEl && !citationTooltipEl.classList.contains('hidden')) hideCitationTooltip()
}, true)

// 툴팁/인용 표기 바깥을 클릭하면 닫는다 - 호버가 없는 터치 기기에서 닫는
// 유일한 방법이라 필요하다.
document.addEventListener('click', (e) => {
  if (!citationTooltipEl || citationTooltipEl.classList.contains('hidden')) return
  if (citationTooltipEl.contains(e.target)) return
  if (citationTooltipBoxEl && citationTooltipBoxEl.contains(e.target)) return
  hideCitationTooltip()
})

// ── AI Chat Sidebar ──────────────────────────────
function toggleChatSidebar() {
  if (!state.sessionId) {
    showToast('논문을 먼저 업로드하거나 선택해주세요.', 'error')
    return
  }
  const isHidden = chatSidebar.classList.toggle('hidden')
  if (chatResizer) chatResizer.classList.toggle('hidden', isHidden)
  chatToggleBtn.classList.toggle('active', !isHidden)
  if (isHidden) {
    chatToggleBtn.focus()
  } else {
    chatInput.focus()
    setTimeout(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight
    }, 100)
  }
}

// 라이브러리의 채팅 세션 조회 목록에서 AI 어시스턴트 대화를 클릭해 들어올 때
// 처럼, 이미 사이드바가 열려 있는지와 무관하게 "펼쳐진 상태"를 보장해야 하는
// 경우 사용한다 (toggleChatSidebar는 매번 상태를 반전시켜 이미 열려 있으면
// 오히려 닫혀버린다).
function openChatSidebar() {
  if (!state.sessionId || !chatSidebar) return
  if (!chatSidebar.classList.contains('hidden')) return
  chatSidebar.classList.remove('hidden')
  if (chatResizer) chatResizer.classList.remove('hidden')
  chatToggleBtn.classList.add('active')
  chatInput.focus()
  setTimeout(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight
  }, 100)
}

function buildChatWelcomeHtml() {
  const isResearch = state.currentDocumentMode === 'research'
  const examples = isResearch
    ? [t('chat:suggestions.research.summary'), t('chat:suggestions.research.method'), t('chat:suggestions.research.results')]
    : [t('chat:suggestions.general.summary'), t('chat:suggestions.general.procedure'), t('chat:suggestions.general.cautions')]
  const welcome = isResearch ? t('chat:welcome.research') : t('chat:welcome.general')
  return `<div class="chat-message assistant"><div class="message-bubble">${escapeHtml(welcome)}<br><br><strong>${icon('info', 13, 'style="vertical-align:-2px;margin-right:3px"')}${escapeHtml(t('chat:suggestions.label'))}</strong><ul>${examples.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div></div>`
}

function attachEvidenceToBubble(bubble, evidenceItems = []) {
  if (!bubble || !evidenceItems.length) return
  const byPage = new Map()
  evidenceItems.forEach(item => {
    const page = Number(item.page_num)
    if (!byPage.has(page)) byPage.set(page, [])
    byPage.get(page).push(item)
  })
  bubble.querySelectorAll("[data-page-citation]").forEach(button => {
    const page = Number(button.dataset.pageCitation)
    const item = byPage.get(page)?.shift()
    if (!item) return
    button.dataset.evidenceId = item.evidence_id
    button.dataset.evidenceQuote = item.quote || ""
    button.dataset.evidenceOccurrence = String(item.occurrence || 1)
    const card = document.createElement("span")
    card.className = "chat-evidence-card"
    const heading = document.createElement("strong")
    heading.textContent = item.section || t("chat:evidence.source")
    const quote = document.createElement("span")
    quote.textContent = (item.quote || "").slice(0, 360)
    card.append(heading, quote)
    if (item.translation_quote) {
      const translationHeading = document.createElement("strong")
      translationHeading.className = "chat-evidence-translation-heading"
      translationHeading.textContent = t("chat:evidence.translation")
      const translation = document.createElement("span")
      translation.textContent = item.translation_quote.slice(0, 360)
      card.append(translationHeading, translation)
    }
    button.appendChild(card)
  })
}

function renderVerificationBadge(messageElement, verification) {
  if (!messageElement || !verification) return
  const badge = document.createElement("div")
  const hasRisk = Array.isArray(verification.risks) && verification.risks.length > 0
  badge.className = "chat-verification-badge " + (hasRisk ? "risk" : "verified")
  badge.textContent = hasRisk
    ? t("chat:evidence.risk", { count: verification.risks.length })
    : t("chat:evidence.verified")
  messageElement.appendChild(badge)
}

function resetChatUI() {
  chatMessages.innerHTML = buildChatWelcomeHtml()
  chatInput.value = ''
  chatInput.style.height = 'auto'
}

function formatChatHtml(text, totalPages = state.totalPages) {
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

  // 5.5. AI가 생성한(신뢰할 수 없는) 텍스트이므로 innerHTML에 꽂기 전에 반드시 살균
  html = sanitizeMarkedHtml(html)

  // 6. 수식 플레이스홀더 복원
  html = html.replace(/MATHBLOCK(\d+)/g, (_, idStr) => {
    const item = mathBlocks[parseInt(idStr)]
    if (!item) return _
    if (window.katex) {
      try {
        const r = window.katex.renderToString(item.formula, { displayMode: item.display, throwOnError: false, output: 'htmlAndMathml' })
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

  // sanitizer를 통과한 뒤 숫자로 검증한 단일·범위 페이지 근거만 링크한다.
  return linkPageCitations(html, totalPages)
}

// 인용 이미지를 로컬/서버 어디서도 복원하지 못했을 때(<img onerror>에서 호출)
// 기존과 동일한 텍스트 placeholder로 자연스럽게 대체한다.
window.__quoteImgFallback = function(imgEl, pageInfoText) {
  const span = document.createElement('span')
  span.className = 'quote-body'
  span.style.fontSize = '11px'
  span.style.opacity = '0.85'
  span.innerHTML = `${icon('image', 12, 'style="vertical-align:-2px;margin-right:2px"')}${escapeHtml(pageInfoText)}`
  imgEl.replaceWith(span)
}

function formatUserChatHtml(content, sessionId = state.sessionId) {
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
      let pageInfo = content.substring(1, markerIdx)
      const questionText = content.substring(markerIdx + marker.length)

      // "(Page N)|quoteId" 형태면 quoteId로 먼저 로컬(같은 브라우저)에 저장해둔
      // 실제 이미지를 복원하고, 없으면(다른 기기/브라우저에서 열람 중) 서버
      // (문서별 디렉터리)에 저장된 이미지를 대신 요청한다 - 그마저도 없으면
      // (옛 형식이거나 저장에 실패했던 경우) onerror가 기존과 동일한 텍스트
      // placeholder로 자연스럽게 대체한다.
      let imgSrc = null
      const sepIdx = pageInfo.lastIndexOf('|')
      if (sepIdx !== -1) {
        const quoteId = pageInfo.substring(sepIdx + 1)
        pageInfo = pageInfo.substring(0, sepIdx)
        imgSrc = getChatQuoteImage(sessionId, quoteId)
        if (!imgSrc && sessionId) {
          imgSrc = `/api/library/${encodeURIComponent(sessionId)}/chat-image/${encodeURIComponent(quoteId)}`
        }
      }

      const quoteBodyHtml = imgSrc
        ? `<img class="message-quote-img" src="${imgSrc}" alt="Quoted Figure" onerror="${escapeHtml(`window.__quoteImgFallback(this, ${JSON.stringify(pageInfo)})`)}" />`
        : `<span class="quote-body" style="font-size: 11px; opacity: 0.85;">${icon('image', 12, 'style="vertical-align:-2px;margin-right:2px"')}${escapeHtml(pageInfo)}</span>`
      return `<div class="message-quote"><span class="quote-symbol">❝</span>${quoteBodyHtml}</div><div class="message-text">${escapeHtml(questionText)}</div>`
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

  clearSuggestedQuestions();
  appendTypingIndicator();

  chatInput.disabled = true;
  updateChatSendBtnIcon(true);

  let accumulatedText = '';
  let replyBubble = null;
  let firstToken = true;
  let responseEvidence = [];
  let responseVerification = null;

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
        attachEvidenceToBubble(replyBubble, responseEvidence);
        applyKatexToElement(replyBubble);
        if (replyBubble.parentElement) {
          renderVerificationBadge(replyBubble.parentElement, responseVerification);
          appendActionButtons(replyBubble.parentElement, 'assistant', accumulatedText);
          renderSuggestedQuestions(replyBubble.parentElement);
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
        appendChatMessage('assistant', `<span class="chat-error-text">${icon('alertTriangle', 13, 'style="vertical-align:-2px;margin-right:3px"')}답변 중 오류가 발생했습니다: ${escapeHtml(err.message)}</span>`, true);
      } else if (replyBubble) {
        replyBubble.innerHTML += `<br><br><span style="color: var(--error);">[오류: ${err.message}]</span>`;
      }
      chatInput.disabled = false;
      updateChatSendBtnIcon(false);
      chatInput.focus();
    },
    null,
    {
      currentPage: state.currentPage,
      screenContext: {
        mode: "viewer", page_num: state.currentPage,
        include_visual: null,
      },
    },
    (eventName, payload) => {
      if (eventName === "evidence") responseEvidence = payload?.items || [];
      if (eventName === "verification") responseVerification = payload;
    }
  );
}

function appendActionButtons(msgEl, role, content) {
  if (!content || content.includes('chat-error-text')) return

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
  copyBtn.innerHTML = `${icon('clipboard', 12, 'style="vertical-align:-2px;margin-right:3px"')}복사`
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
    regenBtn.innerHTML = `${icon('refreshCw', 12, 'style="vertical-align:-2px;margin-right:3px"')}다시 받기`
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

    const verifyBtn = document.createElement("button")
    verifyBtn.type = "button"
    verifyBtn.className = "msg-action-btn"
    verifyBtn.innerHTML = icon("checkCircle", 12, 'style="vertical-align:-2px;margin-right:3px"') + escapeHtml(t("chat:evidence.verifyAction"))
    verifyBtn.style.background = "none"
    verifyBtn.style.border = "none"
    verifyBtn.style.color = "var(--text-muted)"
    verifyBtn.style.fontSize = "11px"
    verifyBtn.style.cursor = "pointer"
    verifyBtn.title = t("chat:evidence.verifyAction")
    verifyBtn.addEventListener("click", () => {
      if (state.chatActiveStream) return
      chatInput.value = t("chat:evidence.verifyPrompt")
      sendChatMessage()
    })
    actionsEl.appendChild(verifyBtn)
  }

  msgEl.appendChild(actionsEl)
}

// ── 추천 질문 로컬 캐시 ─────────────────────────────────
// 추천 질문은 보조 UI라서 채팅 기록(백엔드 DB)에는 저장되지 않는다 - 그
// 결과 새로고침 후 히스토리를 다시 불러오면 마지막 답변에 붙어있던 칩이
// 사라지는 문제가 있었다. 인용 이미지(easypaper_chat_quote_images_*)와
// 동일한 방식으로 문서별 로컬 스토리지에 마지막 추천 질문 세트만 캐싱해두고,
// 히스토리 복원 시 마지막 메시지가 여전히 어시스턴트 답변이면 다시 붙인다.
function saveSuggestedQuestionsCache(sessionId, questions) {
  if (!sessionId) return
  try {
    localStorage.setItem(`easypaper_suggested_questions_${sessionId}`, JSON.stringify(questions))
  } catch (e) {
    console.warn('추천 질문 로컬 저장 실패:', e)
  }
}

function loadSuggestedQuestionsCache(sessionId) {
  if (!sessionId) return null
  try {
    const raw = localStorage.getItem(`easypaper_suggested_questions_${sessionId}`)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

function clearSuggestedQuestionsCache(sessionId) {
  if (!sessionId) return
  localStorage.removeItem(`easypaper_suggested_questions_${sessionId}`)
}

// 대화가 이어지면 예전 답변에 달렸던 추천 질문은 더 이상 "다음에 물어볼 질문"이
// 아니게 되므로, 새 질문을 보내거나 답변을 다시 받을 때마다 기존 칩을 모두 지운다.
function clearSuggestedQuestions() {
  chatMessages.querySelectorAll('.suggested-questions').forEach(el => el.remove())
  clearSuggestedQuestionsCache(state.sessionId)
}

// 추천 질문 칩 목록을 메시지 엘리먼트 아래에 그려 넣는다. API 응답을 받은
// 직후와, 새로고침 후 캐시에서 복원할 때 모두 사용하는 공통 렌더링 로직.
function renderSuggestedQuestionChips(msgEl, questions) {
  const wrap = document.createElement('div')
  wrap.className = 'suggested-questions'
  questions.forEach(q => {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'suggested-question-chip'
    // 추천 질문에 LaTeX 수식($...$ 등)이 섞여 나오는 경우가 있어, 일반
    // 채팅 메시지와 동일하게 마크다운/KaTeX 파이프라인을 태운다. marked가
    // 단일 문장을 <p>로 감싸는데 <button> 안에 블록 요소가 들어가면 접근성
    // 트리가 깨지므로 감싸는 <p> 태그는 제거한다.
    chip.innerHTML = formatChatHtml(q).replace(/^<p>([\s\S]*)<\/p>\s*$/, '$1')
    applyKatexToElement(chip)
    chip.addEventListener('click', () => {
      if (state.chatActiveStream) return
      chatInput.value = q
      sendChatMessage()
    })
    wrap.appendChild(chip)
  })
  msgEl.appendChild(wrap)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

// 어시스턴트 답변이 끝난 직후, 논문/대화 내용을 참고한 후속 질문 3개를 chat
// bubble 아래에 클릭 가능한 칩으로 붙인다. 클릭하면 바로 그 질문으로 다음
// 메시지를 보낸다.
async function renderSuggestedQuestions(msgEl) {
  if (!state.sessionId) return
  try {
    const questions = await getSuggestedQuestionsAPI(state.sessionId, state.chatHistory)
    if (!questions.length) return
    // 응답을 기다리는 사이 사용자가 이미 다음 질문을 보냈다면(이 메시지가 더
    // 이상 마지막 어시스턴트 메시지가 아니라면) 뒤늦게 붙이지 않는다.
    if (!msgEl.isConnected || msgEl !== chatMessages.lastElementChild) return

    renderSuggestedQuestionChips(msgEl, questions)
    saveSuggestedQuestionsCache(state.sessionId, questions)
  } catch (err) {
    console.warn('추천 질문 생성 실패:', err)
  }
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
  globalAnalyticsTracker.trackInteraction('question', state.currentPage)

  chatInput.value = ''
  chatInput.style.height = 'auto'
  clearSuggestedQuestions()

  // 캡처 이미지로 질문하는 경우, 이번 턴에 한해 실제 이미지를 AI에게 함께
  // 전달하기 위한 raw base64(data URL 접두사 제거) - DB/히스토리에는 여전히
  // 텍스트 placeholder만 저장되고, 이건 이번 요청에서만 사용된다.
  let imageForThisTurn = null
  let selectedTextForThisTurn = null

  if (state.quotedText) {
    selectedTextForThisTurn = typeof state.quotedText === 'string' ? state.quotedText : state.quotedText?.text
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
    // 실제 이미지 데이터는 DB에 저장되지 않으므로, 새로고침 후에도 복원할 수
    // 있도록 로컬 스토리지에 별도 보관하고 메시지에는 참조 ID만 남긴다.
    const quoteId = `qimg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    saveChatQuoteImage(state.sessionId, quoteId, state.quotedImage)
    const fullPayload = `[인용된 이미지 (Page ${state.quotedImagePage})|${quoteId}]\n\n질문:\n${text}`
    imageForThisTurn = state.quotedImage.replace(/^data:image\/\w+;base64,/, '')

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
  let responseEvidence = []
  let responseVerification = null
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
        attachEvidenceToBubble(replyBubble, responseEvidence)
        if (replyBubble.parentElement) {
          renderVerificationBadge(replyBubble.parentElement, responseVerification)
          appendActionButtons(replyBubble.parentElement, 'assistant', accumulatedText)
          renderSuggestedQuestions(replyBubble.parentElement)
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
        appendChatMessage('assistant', `<span class="chat-error-text">${icon('alertTriangle', 13, 'style="vertical-align:-2px;margin-right:3px"')}답변 중 오류가 발생했습니다: ${escapeHtml(err.message)}</span><button type="button" class="chat-retry-message-btn" data-chat-retry="${encodeURIComponent(text)}">${t('chat:retrySameQuestion')}</button>`, true)
      } else if (replyBubble) {
        replyBubble.innerHTML += `<br><br><span style="color: var(--error);">[오류: ${err.message}]</span>`
      }

      chatInput.disabled = false
      updateChatSendBtnIcon(false)
      chatInput.focus()
    },
    imageForThisTurn,
    {
      currentPage: state.currentPage,
      selectedText: selectedTextForThisTurn,
      screenContext: {
        mode: "viewer",
        page_num: state.currentPage,
        include_visual: null,
      },
      verifyEvidence: /근거\s*검증|verify\s+(?:the\s+)?evidence/i.test(text),
    },
    (eventName, payload) => {
      if (eventName === "evidence") responseEvidence = payload?.items || []
      if (eventName === "verification") responseVerification = payload
    }
  )
}

function initChatListeners() {
  chatMessages?.addEventListener('click', event => {
    const retryButton = event.target.closest('[data-chat-retry]')
    if (retryButton) {
      chatInput.value = decodeURIComponent(retryButton.dataset.chatRetry || '')
      sendChatMessage()
      return
    }
    const citation = event.target.closest('[data-page-citation]')
    if (!citation) return
    const page = Number(citation.dataset.pageCitation)
    if (Number.isInteger(page) && page >= 1 && page <= state.totalPages) {
      const quote = citation.dataset.evidenceQuote
      const occurrence = Number(citation.dataset.evidenceOccurrence || 1)
      if (quote) locateTermInPdf(page, quote, occurrence)
      else scrollToPage(viewerScrollContainer, page)
    }
  })

  // 어시스턴트 패널의 실측 폭을 --chat-sidebar-offset으로 반영해, 우측 하단
  // floating-scroll-nav가 패널과 겹치지 않고 뷰어 쪽으로 비켜서게 한다.
  // 열림/닫힘(width: 0 ↔ 390px)과 리사이저 드래그 모두 이 하나의 관찰로 처리된다.
  if (chatSidebar) {
    const chatSidebarWidthObserver = new ResizeObserver((entries) => {
      const width = entries[0].contentRect.width
      document.documentElement.style.setProperty('--chat-sidebar-offset', `${width}px`)
    })
    chatSidebarWidthObserver.observe(chatSidebar)
  }

  if (chatToggleBtn) {
    chatToggleBtn.addEventListener('click', toggleChatSidebar)
  }

  if (chatCloseBtn) {
    chatCloseBtn.addEventListener('click', toggleChatSidebar)
  }
  chatSidebar?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    if (!chatSidebar.classList.contains("hidden")) toggleChatSidebar()
  })


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

  if (chatInputExpandBtn && chatInput) {
    chatInputExpandBtn.addEventListener('click', () => {
      const inputBox = chatInput.closest('.chat-input-box')
      if (!inputBox) return

      const expanded = inputBox.classList.toggle('expanded')
      const labelKey = expanded ? 'common:chatInput.collapse' : 'common:chatInput.expand'
      const label = expanded ? t('common:chatInput.collapse') : t('common:chatInput.expand')
      chatInputExpandBtn.dataset.i18nAriaLabel = labelKey
      chatInputExpandBtn.dataset.i18nTitle = labelKey
      chatInputExpandBtn.setAttribute('aria-expanded', String(expanded))
      chatInputExpandBtn.setAttribute('aria-label', label)
      chatInputExpandBtn.title = label
      chatInputExpandBtn.innerHTML = expanded
        ? icon('shrink', 15)
        : icon('expand', 15)

      if (!expanded) {
        chatInput.style.height = 'auto'
        chatInput.style.height = `${chatInput.scrollHeight}px`
      }
      chatInput.focus()
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

  const CHAT_DEFAULT_WIDTH = 390
  const chatMaxWidth = () => Math.round(Math.min(800, window.innerWidth * 0.8))
  const applyChatWidth = (requestedWidth, { persist = false, announce = false } = {}) => {
    const width = Math.round(Math.max(280, Math.min(chatMaxWidth(), requestedWidth)))
    chatSidebar.style.width = `${width}px`
    chatResizer.setAttribute('aria-valuemax', String(chatMaxWidth()))
    chatResizer.setAttribute('aria-valuenow', String(width))
    if (persist) localStorage.setItem('easypaper_chat_sidebar_width', String(width))
    if (announce) announceA11y(t('viewer:a11y.panelWidth', { width }))
    return width
  }

  const savedWidth = Number(localStorage.getItem('easypaper_chat_sidebar_width'))
  if (chatResizer && chatSidebar) {
    applyChatWidth(Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : CHAT_DEFAULT_WIDTH)
    let isDragging = false
    chatResizer.addEventListener('mousedown', (e) => {
      e.preventDefault()
      isDragging = true
      chatResizer.classList.add('dragging')
      chatSidebar.classList.add('resizing')
      if (floatingScrollNav) floatingScrollNav.classList.add('resizing')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    })
    document.addEventListener('mousemove', (e) => {
      if (isDragging) applyChatWidth(window.innerWidth - e.clientX)
    })
    document.addEventListener('mouseup', () => {
      if (!isDragging) return
      isDragging = false
      chatResizer.classList.remove('dragging')
      chatSidebar.classList.remove('resizing')
      if (floatingScrollNav) floatingScrollNav.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      applyChatWidth(chatSidebar.offsetWidth, { persist: true })
    })
    chatResizer.addEventListener('keydown', (event) => {
      if (event.key === 'Home') {
        event.preventDefault(); applyChatWidth(CHAT_DEFAULT_WIDTH, { persist: true, announce: true }); return
      }
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const step = event.shiftKey ? 40 : 10
      const direction = event.key === 'ArrowLeft' ? 1 : -1
      applyChatWidth(Number(chatResizer.getAttribute('aria-valuenow')) + direction * step, { persist: true, announce: true })
    })
  }

  // 지식 그래프 상세 패널 리사이저
  const GRAPH_DEFAULT_WIDTH = 260
  const graphMaxWidth = () => {
    const rowWidth = libraryGraphRow.getBoundingClientRect().width || 1028
    return Math.max(220, Math.round(Math.min(720, rowWidth * 0.7)))
  }
  const applyGraphWidth = (requestedWidth, { persist = false, announce = false } = {}) => {
    const width = Math.round(Math.max(220, Math.min(graphMaxWidth(), requestedWidth)))
    libraryGraphDetailPanel.style.width = `${width}px`
    libraryGraphResizer.setAttribute('aria-valuemax', String(graphMaxWidth()))
    libraryGraphResizer.setAttribute('aria-valuenow', String(width))
    if (persist) localStorage.setItem('easypaper_graph_detail_panel_width', String(width))
    if (announce) announceA11y(t('viewer:a11y.panelWidth', { width }))
    return width
  }
  const savedGraphPanelWidth = Number(localStorage.getItem('easypaper_graph_detail_panel_width'))
  if (libraryGraphResizer && libraryGraphDetailPanel && libraryGraphRow) {
    applyGraphWidth(Number.isFinite(savedGraphPanelWidth) && savedGraphPanelWidth > 0 ? savedGraphPanelWidth : GRAPH_DEFAULT_WIDTH)
    let isDraggingGraphPanel = false
    libraryGraphResizer.addEventListener('mousedown', (e) => {
      e.preventDefault()
      isDraggingGraphPanel = true
      libraryGraphResizer.classList.add('dragging')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    })
    document.addEventListener('mousemove', (e) => {
      if (!isDraggingGraphPanel) return
      applyGraphWidth(libraryGraphRow.getBoundingClientRect().right - e.clientX)
    })
    document.addEventListener('mouseup', () => {
      if (!isDraggingGraphPanel) return
      isDraggingGraphPanel = false
      libraryGraphResizer.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      applyGraphWidth(libraryGraphDetailPanel.offsetWidth, { persist: true })
    })
    libraryGraphResizer.addEventListener('keydown', (event) => {
      if (event.key === 'Home') {
        event.preventDefault(); applyGraphWidth(GRAPH_DEFAULT_WIDTH, { persist: true, announce: true }); return
      }
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const step = event.shiftKey ? 40 : 10
      const direction = event.key === 'ArrowLeft' ? 1 : -1
      applyGraphWidth(Number(libraryGraphResizer.getAttribute('aria-valuenow')) + direction * step, { persist: true, announce: true })
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

// ── 스크롤 방향에 따른 상단 툴바 자동 숨김/표시 ─────────
// 설정에서 켜져 있을 때만: 아래로 스크롤하면 툴바를 위로 슬라이드시켜 숨기고,
// 위로 스크롤하면 다시 보여준다. 맨 위 근처(툴바 높이 이내)에서는 방향과
// 무관하게 항상 보이게 해, 페이지 맨 위로 돌아왔는데 툴바가 없는 어색한
// 상태를 방지한다.
function setToolbarHidden(hidden) {
  if (viewerTopbar) viewerTopbar.classList.toggle('toolbar-hidden', hidden)
  // body에도 반영해 .panels/.outline-sidebar 등이 툴바가 비운 공간만큼
  // CSS만으로 확장/축소되도록 한다 (아래 style.css의 body.toolbar-hidden 규칙 참고).
  document.body.classList.toggle('toolbar-hidden', hidden)
}

if (viewerScrollContainer && viewerTopbar) {
  let lastToolbarScrollTop = viewerScrollContainer.scrollTop
  const TOOLBAR_HIDE_THRESHOLD = 8   // 이보다 작은 이동은 잔떨림으로 보고 무시
  const TOOLBAR_TOP_ZONE = 64        // 이 안쪽이면 방향과 무관하게 항상 표시

  viewerScrollContainer.addEventListener('scroll', () => {
    if (!state.toolbarAutoHide) return

    const currentScrollTop = viewerScrollContainer.scrollTop
    const delta = currentScrollTop - lastToolbarScrollTop

    if (currentScrollTop <= TOOLBAR_TOP_ZONE) {
      setToolbarHidden(false)
    } else if (delta > TOOLBAR_HIDE_THRESHOLD) {
      setToolbarHidden(true)
    } else if (delta < -TOOLBAR_HIDE_THRESHOLD) {
      setToolbarHidden(false)
    }

    lastToolbarScrollTop = currentScrollTop
  })
}

// 문장 중간에 섞여 있는 짧은 인라인 수식 조각인지 휴리스틱으로 판단.
// findDisplayEquationsFromVTM은 줄 전체가 수식인 "독립 수식 줄"만 찾아내므로,
// "The extracted representation Fenc(Φmodal(...)) will..." 처럼 영문 산문 문장
// 한가운데에 끼어 있는 짧은 수식 조각은 isEquation으로 표시되지 않는다. 선택된
// 조각 자체가 그리스 문자/수학 기호 위주이고 영단어가 거의 없으면 수식으로 간주한다.
function looksLikeEquationFragment(text) {
  const t = text.trim();
  if (!t || t.length >= 100) return false;
  // 앞뒤가 모두 글자인 하이픈(영어 복합어 하이픈, 예: "state-of-the-art")은
  // 수학 기호로 치지 않는다 - findDisplayEquationsFromVTM과 동일한 이유.
  const hasMathSymbol = /[=<>+−⋅Ͱ-Ͽ∀-⋿*/×÷_\^\\]/.test(t)
    || /(?<![a-zA-Z])-(?![a-zA-Z])/.test(t);
  if (!hasMathSymbol) return false;
  const words = t.split(/\s+/);
  const engWordCount = words.filter(w => {
    const c = w.replace(/[^a-zA-Z]/g, '');
    return c.length >= 3 && !w.startsWith('\\');
  }).length;
  return engWordCount <= 2;
}

// 유니코드 수식 텍스트를 LaTeX 문법으로 변환하는 휴리스틱 헬퍼 함수
function convertRawTextToLatex(text, inline = false) {
  let clean = text.trim();

  // 그리스 문자 및 수학 기호 매핑
  const replacements = {
    'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\epsilon',
    'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ι': '\\iota', 'κ': '\\kappa',
    'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'ο': 'o', 'π': '\\pi',
    'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi',
    'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
    'Α': 'A', 'Β': 'B', 'Γ': '\\Gamma', 'Δ': '\\Delta', 'Ε': 'E', 'Ζ': 'Z',
    'Η': 'H', 'Θ': '\\Theta', 'Ι': 'I', 'Κ': 'K', 'Λ': '\\Lambda', 'Μ': 'M',
    'Ν': 'N', 'Ξ': '\\Xi', 'Ο': 'O', 'Π': '\\Pi', 'Ρ': 'P', 'Σ': '\\Sigma',
    'Τ': 'T', 'Υ': '\\Upsilon', 'Φ': '\\Phi', 'Χ': 'X', 'Ψ': '\\Psi', 'Ω': '\\Omega',
    '−': '-', '–': '-', '—': '-',
    '×': '\\times', '÷': '\\div', '±': '\\pm', '∓': '\\mp',
    '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '≈': '\\approx',
    '≡': '\\equiv', '∝': '\\propto', '∞': '\\infty',
    '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊃': '\\supset',
    '⊆': '\\subseteq', '⊇': '\\supseteq', '∩': '\\cap', '∪': '\\cup',
    '∀': '\\forall', '∃': '\\exists', '∇': '\\nabla', '∂': '\\partial',
    '||': '\\parallel', '‖': '\\parallel'
  };

  for (const [key, value] of Object.entries(replacements)) {
    clean = clean.split(key).join(value);
  }

  // 다중 문자 수학 함수/상수 치환
  clean = clean.replace(/\bDKL\b/g, 'D_{\\text{KL}}');
  clean = clean.replace(/\bDKL\(/g, 'D_{\\text{KL}}(');
  clean = clean.replace(/\bEq\b/g, '\\mathbb{E}_q');
  clean = clean.replace(/\bEp\b/g, '\\mathbb{E}_p');
  clean = clean.replace(/\bE_([a-zA-Z\\]+)/g, '\\mathbb{E}_{$1}');
  clean = clean.replace(/\blog\b/g, '\\log');
  clean = clean.replace(/\bsin\b/g, '\\sin');
  clean = clean.replace(/\bcos\b/g, '\\cos');
  clean = clean.replace(/\btan\b/g, '\\tan');
  clean = clean.replace(/\bexp\b/g, '\\exp');

  // 아래첨자 자동 교정 (예: p\theta -> p_\theta)
  clean = clean.replace(/([a-zA-Z])(\\theta|\\phi|\\mu|\\sigma|\\alpha|\\beta|\\lambda)/g, '$1_$2');

  return inline ? `$ ${clean} $` : `$$ ${clean} $$`;
}

// ── LaTeX 스마트 클립보드 인터셉터 ────────────────────────────────────────
// VirtualTextMap 기반으로 선택 영역을 문장 범위로 역산하고,
// 수식 부분은 LaTeX($...$ / $$...$$)로 변환하여 클립보드에 쓰는 방식.
// 기존 .pdf-sentence DOM 분할에 의존하지 않습니다.

// 선택 영역과 텍스트 노드가 화면상 기하학적으로 겹치는지 감지.
// range.intersectsNode()는 DOM 트리 순서를 기준으로 판단하는데, 수식은 첨자·분수·
// 적분 기호 등이 PDF 콘텐츠 스트림 순서상 시각적 순서와 다르게 기록되는 경우가 흔해서
// DOM 순서 기반 판정은 선택 범위 밖의 노드까지 끌어들이거나(과다 포함) 반대로
// 선택 범위 안의 노드를 누락시킬 수 있다. 대신 실제 렌더링된 사각형끼리의 겹침으로 판단한다.
// 단순 "겹침"(rectsOverlap)은 줄간격이 촘촘한 학술 논문에서 바로 아래/위 줄의
// 사각형과 경계선이 살짝 스치기만 해도 참으로 판정되어 인접 줄의 텍스트까지
// 끌려 들어온다. 대신 노드 사각형의 중심점이 선택 사각형 "안"에 실제로 들어있는지로
// 판단하면 애매하게 스치는 인접 줄은 배제되고 실제로 선택된 줄만 남는다.
function rectContainsPoint(r, x, y) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function getNodeClientRect(node) {
  try {
    const r = document.createRange();
    r.selectNode(node);
    const rects = r.getClientRects();
    return rects.length > 0 ? rects[0] : r.getBoundingClientRect();
  } catch (e) {
    return null;
  }
}

document.addEventListener('copy', (e) => {
  try {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    let startEl = range.startContainer;
    if (startEl.nodeType === 3) startEl = startEl.parentElement;
    if (!startEl) return;

    // PDF textLayer 내 복사인지 확인
    const textLayer = startEl.closest('.textLayer');
    if (!textLayer) return;

    const pageWrapper = startEl.closest('.pdf-page-wrapper');
    if (!pageWrapper) return;
    const pageNum = parseInt(pageWrapper.dataset.page, 10);
    if (isNaN(pageNum)) return;

    const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum];
    const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum];

    // VirtualTextMap 없이는 기본 텍스트 복사로 폴백 (브라우저 기본 동작 허용)
    if (!vtm || !sentenceRanges) return;

    // 1. 선택된 텍스트의 charStart/charEnd 계산 (nodeRanges 기반, 화면 좌표 겹침으로 판정)
    let selRects = Array.from(range.getClientRects()).filter(r => r.width > 0 || r.height > 0);
    if (selRects.length === 0) {
      const bounding = range.getBoundingClientRect();
      if (bounding.width > 0 || bounding.height > 0) selRects = [bounding];
    }
    if (selRects.length === 0) return;

    let selCharStart = Infinity, selCharEnd = 0;
    for (const nr of vtm.nodeRanges) {
      // 선택의 시작/끝 컨테이너는 브라우저가 이미 정확한 오프셋을 알려주므로 항상 포함한다.
      // PDF.js는 일반 본문을 한 줄 전체를 하나의 텍스트 노드로 렌더링하는 경우가 많아,
      // 그 줄의 일부만 드래그해도 노드 자체의 중심점은 선택 영역 바깥에 있을 수 있기
      // 때문에(노드 전체 폭 > 실제 선택 폭), 기하학적 필터를 시작/끝 노드에는 적용하지 않는다.
      const isBoundaryNode = nr.node === range.startContainer || nr.node === range.endContainer;
      if (!isBoundaryNode) {
        const nodeRect = getNodeClientRect(nr.node);
        if (!nodeRect || (nodeRect.width === 0 && nodeRect.height === 0)) continue;
        const cx = (nodeRect.left + nodeRect.right) / 2;
        const cy = (nodeRect.top + nodeRect.bottom) / 2;
        if (!selRects.some(r => rectContainsPoint(r, cx, cy))) continue;
      }

      const nodeStart = nr.node === range.startContainer ? range.startOffset : 0;
      const nodeEnd   = nr.node === range.endContainer   ? range.endOffset   : nr.node.length;
      const absStart  = nr.start + nodeStart;
      const absEnd    = nr.start + nodeEnd;
      if (absStart < selCharStart) selCharStart = absStart;
      if (absEnd   > selCharEnd)   selCharEnd   = absEnd;
    }
    if (selCharStart === Infinity || selCharEnd <= selCharStart) return;

    // 2. 선택 범위에 걸치는 sentenceRanges 수집
    const overlappingSentences = sentenceRanges.filter(r =>
      r.charStart < selCharEnd && r.charEnd > selCharStart
    );
    if (overlappingSentences.length === 0) return;

    // 3. 각 sentenceRange에 대해 선택된 텍스트 조각을 추출하고 수식 변환 적용
    // alignSentencesToText의 정렬 결과가 드물게 서로 겹치는 범위를 만들어낼 수 있는데
    // (예: 전역 검색 폴백이 이미 다른 문장이 차지한 구간보다 앞쪽에서 매칭되는 경우),
    // 그대로 두면 겹치는 부분의 텍스트가 두 번 복사된다. 겹치는 후보 중에서는 더
    // 넓은(구체적인) 범위를 우선 채택한다 - 폭이 1~2자뿐인 잔여 조각이 먼저 선택되어
    // 실제로 맞는 넓은 범위를 밀어내는 것을 방지하기 위함이다. 채택된 범위만 다시
    // 위치 순으로 정렬해 읽는 순서대로 이어붙인다.
    const candidates = overlappingSentences
      .map(r => ({ r, partStart: Math.max(r.charStart, selCharStart), partEnd: Math.min(r.charEnd, selCharEnd) }))
      .filter(c => c.partStart < c.partEnd)
      .sort((a, b) => (b.partEnd - b.partStart) - (a.partEnd - a.partStart));

    const kept = [];
    for (const c of candidates) {
      if (kept.some(k => c.partStart < k.partEnd && c.partEnd > k.partStart)) continue;
      kept.push(c);
    }
    kept.sort((a, b) => a.partStart - b.partStart);

    const parts = [];
    for (const { r, partStart, partEnd } of kept) {
      let text = vtm.fullText.substring(partStart, partEnd);

      if (r.isEquation) {
        // 수식: latexData 사용 또는 convertRawTextToLatex 폴백
        let latex = r.latexData || convertRawTextToLatex(text);

        // 수식 전체가 선택되었는지 여부에 따라 인라인/블록 구분
        const isFullEquation = (partStart <= r.charStart + 2 && partEnd >= r.charEnd - 2);
        if (isFullEquation) {
          // 전체 수식: 이미 $$...$$ 또는 $...$가 있으면 그대로, 없으면 $$ 감싸기
          if (!latex.startsWith('$')) latex = `$$\n${latex.trim()}\n$$`;
          parts.push('\n\n' + latex + '\n\n');
        } else {
          // 부분 수식: inline $...$ 포맷
          if (!latex.startsWith('$')) latex = `$ ${latex.trim()} $`;
          parts.push(' ' + latex + ' ');
        }
      } else if (looksLikeEquationFragment(text)) {
        // 산문 문장 중간에 섞인 짧은 인라인 수식 조각 (독립 수식 줄 감지에는 걸리지 않음)
        parts.push(' ' + convertRawTextToLatex(text, true) + ' ');
      } else {
        // 일반 텍스트: 그대로 사용
        parts.push(text);
      }
    }

    const result = parts.join('').trim();
    if (!result) return;

    e.clipboardData.setData('text/plain', result);
    e.preventDefault();
  } catch (err) {
    console.warn("Copy intercept failed:", err);
  }
});

document.addEventListener('mousedown', (e) => {
  state.isSelectionDragging = true;
  if (viewerScrollContainer) {
    viewerScrollContainer.classList.add('selection-dragging');
  }
  state.hoverSelectedPdfElements = null;
  state.hoverSelectedPageNum = null;
  state.hoverSelectedSentenceIdx = null;
  if (sentenceHoverTimer) {
    clearTimeout(sentenceHoverTimer);
    sentenceHoverTimer = null;
  }
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

document.addEventListener('mouseup', () => {
  state.isSelectionDragging = false;
});

// KaTeX 로드 완료 후 페이지 내 pending 수식 전부 재처리
document.addEventListener('katex-ready', () => {
  // 번역 패널의 모든 .math-pending 요소 처리
  document.querySelectorAll('.trans-text, .message-bubble, .notes-card-text, .aic-preview, .aic-card-preview').forEach(el => {
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

  // 모든 문장 미리 전처리 - null/undefined 방어, LaTeX 명령어 제거 및 그리스 문자 대응
  const GREEK_MAP = {
    'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'epsilon': 'ε',
    'zeta': 'ζ', 'eta': 'η', 'theta': 'θ', 'iota': 'ι', 'kappa': 'κ',
    'lambda': 'λ', 'mu': 'μ', 'nu': 'ν', 'xi': 'ξ', 'pi': 'π',
    'rho': 'ρ', 'sigma': 'σ', 'tau': 'τ', 'upsilon': 'υ', 'phi': 'φ',
    'chi': 'χ', 'psi': 'ψ', 'omega': 'ω'
  };

  const cleanSents = (sentencesList || []).map(s => {
    let text = s || '';

    // LaTeX 그리스 문자 명령어를 유니코드 문자로 변환
    for (const [name, unicode] of Object.entries(GREEK_MAP)) {
      text = text.replace(new RegExp('\\\\' + name, 'g'), unicode);
    }

    // 기타 백슬래시로 시작하는 LaTeX 명령어 제거 (예: \sum, \int 등)
    text = text.replace(/\\[a-zA-Z]+/g, '');

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

    // 2. 접두어 기반 검색 시도 (사소한 문자 오차 해결) - searchStart 이후에서만 찾는다.
    // 예전에는 이 단계에서 실패하면 fromIndex 없이(처음부터) 다시 검색하는 "전역
    // 폴백"이 있었는데, indexOf(x, searchStart)가 이미 -1을 반환한 상태에서
    // indexOf(x)(전체 검색)가 뭔가를 찾는다면 그 위치는 수학적으로 반드시
    // searchStart보다 앞쪽일 수밖에 없다(그렇지 않다면 위 순차 검색이 이미 찾았을
    // 것이므로). 즉 이 전역 폴백은 실행될 때마다 예외 없이 직전 문장이 이미 차지한
    // 구간을 다시 가리켜, 인접한 두 문장의 하이라이트가 겹치는 버그로 항상 이어졌다.
    // 실패한 문장은 대신 아래 Gap Partitioning이 겹치지 않게 처리하도록 둔다.
    if (idx === -1) {
      const prefix = cleanSent.substring(0, Math.min(15, cleanSent.length));
      idx = cleanText.indexOf(prefix, searchStart);
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

  // 매칭 실패(길이 0)인 문장들의 범위를 주변 매칭 성공 문장들 사이의 간격으로 분할 보간(Gap Partitioning)
  // 수식 등의 기호만 있는 문장들이 누락 없이 서로 겹치지 않고 PDF 텍스트 레이어에 균등 분할 마킹되도록 지원.
  //
  // 실패한 문장들 사이의 간격을 "개수로 균등 분할"하면 위험하다 - 그림 캡션처럼 원문
  // 추출 텍스트와 번역 문장 목록이 잘 안 맞는 구간에서 매칭이 연쇄적으로 실패하면,
  // prevEnd와 nextStart 사이의 간격이 그림이 차지하는 공백이나 전혀 무관한 다른
  // 단락까지 포함할 정도로 커질 수 있다(실측: 캡션 문장 하나가 수백 자 떨어진 다른
  // 컬럼의 무관한 문단까지 하이라이트로 끌어옴). 그 큰 간격을 실패한 문장 "개수"로만
  // 나누면 문장의 실제 길이와 무관하게 넓은 범위가 배정되므로, 대신 (1) 각 문장
  // 원문(sText) 길이 비율로 나누고, (2) 간격이 실패한 문장들의 원문 길이 합보다
  // 비정상적으로 크면(그림 등으로 인한 진짜 공백일 가능성) 간격 전체를 억지로 채우지
  // 않고 prevEnd부터 필요한 만큼만 촘촘히 배정한 뒤 나머지는 어느 문장에도 배정하지
  // 않고 비워 둔다.
  const GAP_SAFETY_MULTIPLIER = 2.5;
  let walkIdx = 0;
  while (walkIdx < sentenceRanges.length) {
    if (sentenceRanges[walkIdx].start === sentenceRanges[walkIdx].end) {
      let k_start = walkIdx;
      let k_end = walkIdx;
      while (k_end + 1 < sentenceRanges.length && sentenceRanges[k_end + 1].start === sentenceRanges[k_end + 1].end) {
        k_end++;
      }

      let prevEnd = 0;
      for (let i = k_start - 1; i >= 0; i--) {
        if (sentenceRanges[i].end > sentenceRanges[i].start) {
          prevEnd = sentenceRanges[i].end;
          break;
        }
      }

      let nextStart = fullText.length;
      for (let i = k_end + 1; i < sentenceRanges.length; i++) {
        if (sentenceRanges[i].end > sentenceRanges[i].start) {
          nextStart = sentenceRanges[i].start;
          break;
        }
      }

      if (prevEnd < nextStart) {
        const gapSize = nextStart - prevEnd;
        const lens = [];
        let totalLen = 0;
        for (let i = k_start; i <= k_end; i++) {
          const len = Math.max(1, (sentenceRanges[i].text || '').length);
          lens.push(len);
          totalLen += len;
        }
        const usedGap = Math.min(gapSize, totalLen * GAP_SAFETY_MULTIPLIER);
        let cursor = prevEnd;
        for (let idx = 0; idx < lens.length; idx++) {
          const i = k_start + idx;
          const share = Math.round((lens[idx] / totalLen) * usedGap);
          sentenceRanges[i].start = cursor;
          sentenceRanges[i].end = Math.min(nextStart, cursor + share);
          cursor = sentenceRanges[i].end;
        }
      }

      walkIdx = k_end + 1;
    } else {
      walkIdx++;
    }
  }

  // 최종 안전장치: 인접한 두 문장의 범위가 여전히 겹치면(접두어 폴백이 원문
  // 오차로 실제보다 넓게 잡거나, 위 두 보정 단계가 손대지 않는 경계에서 우연히
  // 겹치는 경우) 겹친 구간의 중간 지점에서 서로 맞닿도록 잘라 겹침을 제거한다.
  // 어느 한쪽이 항상 옳다고 볼 근거가 없으므로 중간 지점에서 공평하게 나눈다.
  for (let i = 1; i < sentenceRanges.length; i++) {
    const prev = sentenceRanges[i - 1];
    const cur = sentenceRanges[i];
    if (cur.start < prev.end) {
      const mid = Math.floor((cur.start + prev.end) / 2);
      prev.end = Math.max(prev.start, mid);
      cur.start = Math.min(cur.end, mid);
    }
  }

  return sentenceRanges;
}

// ── PDF 텍스트 레이어 비파괴 가상 오버레이 기반 문장 매핑 시스템 ───────────────
//
// 설계 원칙:
//  1. Non-Invasive: PDF.js가 생성한 .textLayer 내의 <span>을 절대 쪼개거나 감싸지 않음
//  2. Virtual Coordinate Overlay: 하이라이트는 별도 .pdf-highlight-overlay div에 드로잉
//  3. Native Selection 보존: 브라우저 기본 텍스트 드래그/선택 완전 보존
//
// buildVirtualTextMap: textLayer 내부 스팬을 읽어 가상 텍스트 인덱스 맵 구성 (DOM 비수정)
function buildVirtualTextMap(container, pageNum) {
  const allElements = Array.from(container.children).filter(el => el.nodeType === 1);
  if (allElements.length === 0) return null;

  // left/top을 el.style.left/top 문자열(px, %, calc() 등 PDF.js 버전·문서마다 다를 수
  // 있음)로 역산하는 대신, 브라우저가 실제로 계산한 렌더링 좌표(getBoundingClientRect)를
  // 컨테이너 기준 상대좌표로 직접 사용한다. 이전에 퍼센트 단위를 컨테이너 크기 기준으로
  // 환산하는 방식을 썼었는데, 일부 문서에서는 그 환산값이 실제 렌더링 위치와 수십~백
  // px씩 어긋났다(원인 불명 - 아마도 PDF.js가 퍼센트의 기준으로 삼는 상자와 textLayer의
  // clientWidth/Height가 문서에 따라 정확히 일치하지 않는 경우가 있는 듯하다). 실제
  // 렌더링 좌표를 직접 읽으면 이런 불일치가 원천적으로 발생하지 않는다.
  const containerRect = container.getBoundingClientRect();
  const pageWidth  = container.clientWidth  || containerRect.width  || 600;

  // 줄 번호 필터링 + 노드 메타데이터 수집
  const spans = [];
  allElements.forEach(el => {
    const text = el.textContent.trim();
    // 텍스트가 없는(공백뿐이거나 빈) 요소는 건너뛴다. PDF.js가 줄마다 끼워 넣는
    // 빈 마커/공백 전용 스팬은 어차피 fullText에 아무 글자도 보태지 않는데,
    // getBoundingClientRect()가 0,0 같은 퇴화된 좌표를 반환하는 경우가 있어
    // 그대로 두면 줄 안의 최대 간격(gap) 계산이 이 가짜 좌표에 낚여 엉뚱한
    // 위치를 거터로 오판하게 만든다(실측: 실제 텍스트는 left=88부터 시작하는데
    // 빈 스팬이 left=0에 끼어들어 "0~88" 사이를 간격으로 오인).
    if (!text) return;
    const rect = el.getBoundingClientRect();
    const leftVal   = rect.left - containerRect.left;
    const topVal    = rect.top  - containerRect.top;
    const fsMatch   = el.style.fontSize?.match(/([\d.]+)/);
    const fsVal     = fsMatch   ? parseFloat(fsMatch[1])   : (rect.height || 10);
    const ratio     = leftVal / pageWidth;

    // 줄 번호: 3~4자리 숫자, 좌측 마진 8% 이내
    if (ratio < 0.08 && /^\d{3,4}$/.test(text)) {
      el.style.userSelect = 'none';
      el.style.webkitUserSelect = 'none';
      el.style.pointerEvents = 'none';
      el.classList.add('pdf-line-number-noise');
      return;
    }

    spans.push({ el, left: leftVal, top: topVal, fontSize: fsVal, isLineNumber: false });
  });

  if (spans.length === 0) return null;

  // spans는 pdf.js가 만든 DOM 순서(=PDF 콘텐츠 스트림 순서) 그대로 담겨 있다. 2단
  // 논문이라도 LaTeX 등 조판 엔진은 왼쪽 컬럼 전체를 위에서 아래로 다 쓴 뒤에
  // 오른쪽 컬럼을 쓰므로, 이 순서 자체가 이미 올바른 읽기 순서다(실측 확인: 페이지
  // 앞쪽 수십 개 스팬이 전부 왼쪽 컬럼이고 top이 정확히 오름차순으로 이어지며,
  // 오른쪽 컬럼 내용은 전혀 섞여 있지 않았다). 예전에는 이 순서를 무시하고 top
  // 좌표만으로 전체를 다시 정렬한 뒤 거터를 추정해 좌/우로 재조립하는 로직을
  // 썼는데, 그 재정렬 자체가 왼쪽 컬럼 맨 아래 줄과 오른쪽 컬럼 맨 위 줄처럼 top이
  // 우연히 비슷한 두 스팬을 섞어버리는 원인이었다(수식·헤딩이 섞인 페이지에서
  // 특히 잦고, 기하학적 방법만으로는 "우연히 가까움"과 "진짜 같은 줄"을 구분할
  // 수 없었다). 따라서 원래 순서를 그대로 신뢰하고, "같은 시각적 줄"인지만 그
  // 순서를 따라가며 판정한다.
  //
  // 세로 구간이 겹치는 동안 줄을 이어붙이는 구간 병합(interval merging)은 그대로
  // 쓰되, 순서를 따라갈 때 위험한 지점이 하나 있다: 왼쪽 컬럼의 마지막 줄에서
  // 오른쪽 컬럼의 첫 줄로 넘어갈 때 top이 페이지 하단에서 상단으로 "역행"한다.
  // 이 역행한 top이 마침 직전 줄의 늘어난 세로 구간(envelope) 안에 들어가면 두
  // 컬럼이 하나의 줄로 잘못 합쳐진다. 그래서 세로 구간이 겹치는지 뿐 아니라, 그
  // 줄이 시작된 top에서 위로 크게 벗어나지 않는지도 함께 확인한다 - 첨자는
  // 기준선보다 위/아래로 살짝만(~6~8px) 벗어나지만, 컬럼 전환은 수백 px씩
  // 역행하므로 이 둘은 확실히 구분된다.
  const LINE_ENVELOPE_REACH = 8;
  const lineGroups = [];
  let currentLine = [];
  let lineTop = null;
  let envelopeBottom = -Infinity;
  for (const s of spans) {
    const sBottom = s.top + LINE_ENVELOPE_REACH;
    const withinLine = currentLine.length > 0
      && s.top < envelopeBottom
      && s.top > lineTop - LINE_ENVELOPE_REACH;
    if (currentLine.length === 0 || withinLine) {
      if (currentLine.length === 0) lineTop = s.top;
      currentLine.push(s);
      envelopeBottom = Math.max(envelopeBottom, sBottom);
    } else {
      lineGroups.push(currentLine);
      currentLine = [s];
      lineTop = s.top;
      envelopeBottom = sBottom;
    }
  }
  if (currentLine.length > 0) lineGroups.push(currentLine);

  lineGroups.forEach((line, idx) => line.forEach(s => { s.lineIndex = idx; }));
  const sortedSpans = lineGroups.flat();

  // 줄간격 중앙값 및 폰트 크기 중앙값 계산
  const gaps = [];
  for (let i = 1; i < sortedSpans.length; i++) {
    const gap = sortedSpans[i].top - sortedSpans[i - 1].top;
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
  const paraGapThreshold = medianGap * 1.8;

  const fontSizes = sortedSpans.map(n => n.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 10;
  const headerFsThreshold = medianFontSize * 1.15;

  // 텍스트 노드 수집 (KaTeX 등 제외)
  function collectTextNodes(el) {
    const nodes = [];
    function walk(node) {
      if (node.nodeType === 3) {
        if (node.nodeValue && node.nodeValue.trim()) nodes.push(node);
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
    return nodes;
  }

  // fullText 구성 (DOM 수정 없이 가상 인덱스만 구성)
  let fullText = '';
  const nodeRanges = []; // { node, spanInfo, start, end }
  let prevTop = null;
  let prevFontSize = medianFontSize;

  for (let i = 0; i < sortedSpans.length; i++) {
    const spanInfo = sortedSpans[i];
    const { el, top, fontSize } = spanInfo;
    const textNodes = collectTextNodes(el);
    if (textNodes.length === 0) continue;

    if (fullText.length > 0) {
      const gap = prevTop !== null ? top - prevTop : 0;
      const isPrevHeader = prevFontSize > headerFsThreshold;
      const isCurrentHeader = fontSize > headerFsThreshold;
      const isLargeGap = gap > paraGapThreshold;
      const prevText = collectTextNodes(sortedSpans[i - 1].el).map(n => n.nodeValue).join('').trim();
      const isPrevSectionNum = /^(?:[IVXLCDM\d]+(?:\.[IVXLCDM\d]+)*\.?|[A-Z]\.?)$/i.test(prevText);

      if (!isPrevSectionNum && (isPrevHeader || isCurrentHeader || isLargeGap || gap < -50)) {
        if (!fullText.endsWith('\n\n')) fullText += '\n\n';
      } else {
        const prevChar = fullText[fullText.length - 1];
        const nextChar = textNodes[0].nodeValue[0];
        if (prevChar !== ' ' && nextChar !== ' ' && prevChar !== '\n') fullText += ' ';
      }
    }

    spanInfo.charStart = fullText.length;
    for (let j = 0; j < textNodes.length; j++) {
      const node = textNodes[j];
      if (j > 0) {
        const prevChar = fullText[fullText.length - 1];
        const nextChar = node.nodeValue[0];
        if (prevChar !== ' ' && nextChar !== ' ') fullText += ' ';
      }
      const start = fullText.length;
      fullText += node.nodeValue;
      nodeRanges.push({ node, spanInfo, start, end: fullText.length });
    }
    spanInfo.charEnd = fullText.length;

    prevTop = top;
    prevFontSize = fontSize;
  }

  return { fullText, spans: sortedSpans, nodeRanges, pageNum };
}

// 독립 수식 검출 (VirtualTextMap 기반)
function findDisplayEquationsFromVTM(vtm) {
  const { fullText, spans } = vtm;
  const eqs = [];
  const lines = [];
  let currentLine = [];

  // top 값으로 줄 경계를 다시 판정하지 않는다: 2단 레이아웃에서는 좌단을 다 훑은 뒤
  // 우단으로 넘어가면서 top이 페이지 상단 값으로 되돌아가는데, 그 지점에서 직전 줄의
  // 늘어난 세로 구간(envelope) 안에 다음 컬럼의 첫 줄이 우연히 걸려버리면 두 컬럼
  //전체가 하나의 "줄"로 잘못 합쳐진다(실측: 문단 여러 개가 통째로 합쳐짐). 대신
  // buildVirtualTextMap이 이미 정확히 판정해 둔 lineIndex가 바뀔 때만 줄을 나눈다.
  let currentLineIndex = null;
  for (const spanInfo of spans) {
    if (spanInfo.charStart === undefined || spanInfo.charEnd === undefined) continue;
    if (currentLine.length === 0 || spanInfo.lineIndex === currentLineIndex) {
      currentLine.push(spanInfo);
    } else {
      lines.push(currentLine);
      currentLine = [spanInfo];
    }
    currentLineIndex = spanInfo.lineIndex;
  }
  if (currentLine.length > 0) lines.push(currentLine);

  for (const line of lines) {
    const lineText = line.map(s => fullText.substring(s.charStart, s.charEnd)).join(' ').trim();
    if (!lineText) continue;

    const hasEqNum = /[\(\[][\d\w\.]+[\]\)]\s*$/.test(lineText);
    // \uc77c\ubc18 ASCII \ud558\uc774\ud508(-)\uc740 \uc218\ud559 \uae30\ud638 \ud310\uc815\uc5d0\uc11c \ube7c\uace0, \uae00\uc790\ub85c \ub458\ub7ec\uc2f8\uc774\uc9c0 \uc54a\uc740
    // \uacbd\uc6b0\uc5d0\ub9cc(\uc608: "a - b", "x-1") \ubcc4\ub3c4\ub85c \uac80\uc0ac\ud55c\ub2e4. "state-of-the-art"\ucc98\ub7fc
    // \uc55e\ub4a4\uac00 \ubaa8\ub450 \uae00\uc790\uc778 \ud558\uc774\ud508\uc740 \uc601\uc5b4 \ubcf5\ud569\uc5b4 \ud558\uc774\ud508\uc77c \ubfd0\uc778\ub370, \uc774\ub97c \uc218\uc2dd \uae30\ud638\ub85c
    // \uc624\ud310\ud558\uba74 \uc774\ub7f0 \ub2e8\uc5b4\uac00 \ud3ec\ud568\ub41c \uc9e7\uc740 \uc904(\ud2b9\ud788 \uc904\ubc14\uafc8\uc73c\ub85c \ub2e8\uc5b4 \uc218\uac00 \uc801\uc5b4\uc9c0\ub294
    // \ub9c8\uc9c0\ub9c9 \uc904)\uc774 \uc218\uc2dd\uc73c\ub85c \uc798\ubabb \ubd84\ub958\ub418\uc5b4 \ubb38\uc7a5 \ubc94\uc704\uac00 \uc911\uac04\uc5d0 \uc798\ub824\ub098\uac04\ub2e4(\uc2e4\uce21).
    const hasMathSymbol = /[=<>+\u2212\u22c5\u0370-\u03ff\u2200-\u22ff*/\u00d7\u00f7_\^\\]/.test(lineText)
      || /(?<![a-zA-Z])-(?![a-zA-Z])/.test(lineText);
    const words = lineText.split(/\s+/);
    const engWordCount = words.filter(w => {
      const c = w.replace(/[^a-zA-Z]/g, '');
      return c.length >= 3 && !w.startsWith('\\');
    }).length;

    const isEquation = hasMathSymbol && (
      (hasEqNum && engWordCount <= 6) ||
      (!hasEqNum && lineText.length < 150 && engWordCount <= 4)
    );
    if (isEquation) {
      const lineStart = Math.min(...line.map(s => s.charStart));
      const lineEnd   = Math.max(...line.map(s => s.charEnd));
      eqs.push({ start: lineStart, end: lineEnd, text: lineText });
    }
  }
  return eqs;
}

// 문장 범위로부터 화면 좌표 Rects 계산 (getClientRects 기반, 라인별 개별 상자)
function getSentenceRects(sentenceRange, vtm, containerEl) {
  const { fullText, nodeRanges } = vtm;
  const containerRect = containerEl.getBoundingClientRect();
  const mergedRects = [];

  for (const nr of nodeRanges) {
    const overlapStart = Math.max(nr.start, sentenceRange.charStart);
    const overlapEnd   = Math.min(nr.end,   sentenceRange.charEnd);
    if (overlapStart >= overlapEnd) continue;

    const nodeOffsetStart = overlapStart - nr.start;
    const nodeOffsetEnd   = overlapEnd   - nr.start;

    try {
      const range = document.createRange();
      range.setStart(nr.node, nodeOffsetStart);
      range.setEnd(nr.node, nodeOffsetEnd);
      const rects = Array.from(range.getClientRects());

      for (const rect of rects) {
        if (rect.width < 1 || rect.height < 1) continue;
        const r = {
          left:   rect.left   - containerRect.left,
          top:    rect.top    - containerRect.top,
          width:  rect.width,
          height: rect.height,
        };
        // 같은 라인의 인접 상자 병합 (top ± 2px)
        const last = mergedRects[mergedRects.length - 1];
        if (last && Math.abs(last.top - r.top) < 3 && Math.abs((last.left + last.width) - r.left) < 4) {
          last.width = r.left + r.width - last.left;
          last.height = Math.max(last.height, r.height);
        } else {
          mergedRects.push({ ...r });
        }
      }
    } catch (e) { /* 범위 생성 실패 시 무시 */ }
  }

  return mergedRects;
}

// 오버레이 레이어에 하이라이트 상자를 드로잉
function renderSentenceOverlay(overlayEl, rects, boxClass) {
  for (const r of rects) {
    const box = document.createElement('div');
    box.className = boxClass;
    box.style.left   = `${r.left}px`;
    box.style.top    = `${r.top}px`;
    box.style.width  = `${r.width}px`;
    box.style.height = `${r.height}px`;
    overlayEl.appendChild(box);
  }
}

// 오버레이 레이어에서 특정 클래스 상자들만 제거
function clearOverlayBoxes(overlayEl, ...classes) {
  if (!overlayEl) return;
  classes.forEach(cls => {
    overlayEl.querySelectorAll(`.${cls}`).forEach(b => b.remove());
  });
}

// 오버레이 레이어를 반환 (없으면 생성)
function getOrCreateOverlay(pageWrapper) {
  let overlay = pageWrapper.querySelector('.pdf-highlight-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'pdf-highlight-overlay';
    // .pdf-page-wrapper 내에서 canvas/textLayer와 동일한 절대 좌표계
    const inner = pageWrapper.querySelector('.page') || pageWrapper;
    inner.appendChild(overlay);
  }
  return overlay;
}

// 키워드/단어 탭에서 용어를 클릭하면 PDF 원문에서 그 단어를 찾아 스크롤 + 펄스
// 하이라이트(citation 클릭 시 사용하는 것과 동일한 패턴 재사용)
// 문자열에서 영숫자/한글/한자/그리스 문자만 남기고 소문자화 - PDF 원문 추출 텍스트는
// 줄바꿈으로 끊긴 하이픈 단어, 공백 간격 등이 LLM이 본 정제된 텍스트와 다를 수 있어
// (alignSentencesToText와 동일한 방식) 순수 문자만 비교해야 안정적으로 매칭된다.
const INSIGHT_MATCH_CHAR_RE = /[a-zA-Z0-9ㄱ-힝一-鿿Ͱ-Ͽ]/

// 줌 변경 시 모든 페이지의 캔버스/텍스트 레이어가 파괴되고 뷰포트에 들어온
// 페이지만 지연 재렌더링되므로, 화면 밖으로 스크롤되어 있던 페이지의
// virtualTextMaps는 이미 DOM에서 제거된(detached) 노드를 계속 참조하게 된다.
// 그 상태로는 하이라이트 좌표를 계산할 수 없으므로 유효성을 먼저 확인한다.
function isVtmFresh(vtm) {
  return !!(vtm && vtm.nodeRanges && vtm.nodeRanges.length > 0 && document.contains(vtm.nodeRanges[0].node))
}

// 요소가 스크롤 컨테이너 뷰포트 안에 이미 충분히 들어와 있는지 확인 - 이미 보이는
// 위치라면 scrollIntoView가 사실상 아무것도 하지 않으므로 굳이 스크롤 완료를 기다릴
// 필요가 없다(불필요한 지연 방지).
function isElementReasonablyInView(el, container, marginPx = 40) {
  const elRect = el.getBoundingClientRect()
  const contRect = container.getBoundingClientRect()
  return elRect.top >= contRect.top - marginPx && elRect.bottom <= contRect.bottom + marginPx
}

// 'scrollend' 이벤트로 부드러운 스크롤이 실제로 끝나는 시점을 기다린다. 브라우저 지원이
// 없거나 스크롤이 예상보다 오래 걸리는 경우를 대비해 최대 대기 시간을 둔다.
function waitForScrollSettle(container, timeoutMs = 1000) {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      container.removeEventListener('scrollend', finish)
      clearTimeout(timer)
      resolve()
    }
    container.addEventListener('scrollend', finish, { once: true })
    const timer = setTimeout(finish, timeoutMs)
  })
}

async function locateTermInPdf(pageNum, term, occurrence = 1) {
  const pw = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`)
  if (!pw) {
    showToast('원문 위치를 찾을 수 없습니다.', 'warning')
    return
  }

  let vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
  if (!isVtmFresh(vtm)) {
    // 페이지로 스크롤해 지연 렌더링을 트리거한 뒤, 텍스트 레이어 재생성 및
    // 재세그멘테이션이 끝나 virtualTextMaps가 갱신될 때까지 잠시 대기한다.
    pw.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum]
      if (isVtmFresh(vtm)) break
    }
  }

  if (!isVtmFresh(vtm)) {
    showToast('원문 위치를 찾을 수 없습니다.', 'warning')
    return
  }

  const fullText = vtm.fullText
  const cleanToRaw = []
  let cleanText = ''
  for (let i = 0; i < fullText.length; i++) {
    const ch = fullText[i]
    if (INSIGHT_MATCH_CHAR_RE.test(ch)) {
      cleanToRaw.push(i)
      cleanText += ch.toLowerCase()
    }
  }

  let cleanTerm = ''
  for (const ch of term.trim()) {
    if (INSIGHT_MATCH_CHAR_RE.test(ch)) cleanTerm += ch.toLowerCase()
  }

  let cleanIdx = -1
  let searchFrom = 0
  for (let index = 0; index < Math.max(1, occurrence); index++) {
    cleanIdx = cleanTerm ? cleanText.indexOf(cleanTerm, searchFrom) : -1
    if (cleanIdx === -1) break
    searchFrom = cleanIdx + cleanTerm.length
  }
  if (cleanIdx === -1) {
    showToast('원문에서 해당 단어를 찾지 못했습니다.', 'warning')
    return
  }

  const rawStart = cleanToRaw[cleanIdx]
  const rawEnd = cleanToRaw[cleanIdx + cleanTerm.length - 1] + 1

  const textLayer = pw.querySelector('.textLayer')
  if (!textLayer) {
    showToast('원문 위치를 찾을 수 없습니다.', 'warning')
    return
  }
  const rects = getSentenceRects({ charStart: rawStart, charEnd: rawEnd }, vtm, textLayer)
  if (rects.length === 0) {
    showToast('원문 위치를 하이라이트하지 못했습니다.', 'warning')
    return
  }

  // 스크롤이 실제로 필요한 경우, 부드러운 스크롤 애니메이션이 끝나기 전에 하이라이트가
  // 먼저 그려져서 화면 밖에 있는 동안 다 사라져버리는 문제(그래서 두 번 클릭해야 겨우
  // 보이는 것처럼 느껴짐)를 막기 위해, 스크롤이 실제로 자리를 잡을 때까지 기다린 뒤에
  // 하이라이트를 그린다. 이미 화면에 보이는 위치라면(스크롤이 사실상 필요 없다면) 바로 그린다.
  const alreadyInView = isElementReasonablyInView(pw, viewerScrollContainer)
  pw.scrollIntoView({ behavior: 'smooth', block: 'center' })
  if (!alreadyInView) {
    await waitForScrollSettle(viewerScrollContainer)
  }
  const overlay = getOrCreateOverlay(pw)
  renderSentenceOverlay(overlay, rects, 'sentence-locate-pulse-box')
  setTimeout(() => clearOverlayBoxes(overlay, 'sentence-locate-pulse-box'), 1800)
}

// 메인 진입점: buildVirtualTextMap → alignSentencesToText → state 저장 → 메모 오버레이 렌더링
function segmentPdfElements(container, pageNum) {
  try {
    // 기존 DOM 분할 스팬 제거 (이전 버전 호환)
    container.querySelectorAll('.pdf-sentence').forEach(span => {
      const parent = span.parentNode;
      if (parent) {
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
      }
    });
    container.normalize();

    // 1. 가상 텍스트 맵 구축 (DOM 비수정)
    const vtm = buildVirtualTextMap(container, pageNum);
    if (!vtm || vtm.nodeRanges.length === 0) return;

    const { fullText, nodeRanges } = vtm;

    // 2. 문장 정렬 매핑
    let sentenceRanges;
    const sentences = state.translationSentences && state.translationSentences[pageNum];
    if (sentences && sentences.length > 0) {
      const srcSents = sentences.map(s => s.src);
      sentenceRanges = alignSentencesToText(fullText, srcSents, pageNum);
    } else {
      sentenceRanges = splitIntoSentences(fullText);
    }
    if (sentenceRanges.length === 0) return;

    // 3. 독립 수식 검출 및 sentenceIdx 부여
    const displayEqs = findDisplayEquationsFromVTM(vtm);
    sentenceRanges.forEach((r, idx) => { r.sentenceIdx = idx; r.charStart = r.start; r.charEnd = r.end; });

    // displayEqs(기하학적으로 검출된 수식 줄)와 sentenceRanges(번역 문장 정렬 결과)는
    // 서로 완전히 다른 방식으로 계산된 범위라 경계가 정확히 일치하는 경우가 드물고,
    // 대부분 부분적으로만 겹친다. "완전히 포함" 관계만 처리하면 실제로는 수식인
    // 구간의 상당수가 그냥 지나쳐져 isEquation이 설정되지 않으므로, 겹치는 부분이
    // 조금이라도 있으면 그 교집합만 수식으로 잘라내는 일반화된 겹침 처리로 바꾼다.
    let currentRanges = [...sentenceRanges];
    for (const eq of displayEqs) {
      const nextRanges = [];
      for (const sent of currentRanges) {
        // 이미 앞선 eq에서 수식으로 잘려나온 조각은 다시 잘라내지 않는다.
        // 그렇지 않으면 두 수식 줄의 정렬 경계가 서로 살짝 겹칠 때 아주 짧은(1~2자)
        // 잔여 조각이 다음 eq와 또 겹쳐 잘못된(이전) 수식의 latexData를 물려받는다.
        if (sent.isEquation) {
          nextRanges.push(sent);
          continue;
        }
        const overlapStart = Math.max(sent.charStart, eq.start);
        const overlapEnd   = Math.min(sent.charEnd, eq.end);
        if (overlapStart >= overlapEnd) {
          nextRanges.push(sent);
          continue;
        }
        if (sent.charStart < overlapStart) {
          nextRanges.push({ ...sent, charEnd: overlapStart, end: overlapStart, text: fullText.substring(sent.charStart, overlapStart) });
        }
        nextRanges.push({
          start: overlapStart, end: overlapEnd, charStart: overlapStart, charEnd: overlapEnd,
          sentenceIdx: 10000 + overlapStart, originalSentenceIdx: sent.sentenceIdx,
          text: fullText.substring(overlapStart, overlapEnd), isEquation: true
        });
        if (sent.charEnd > overlapEnd) {
          nextRanges.push({ ...sent, charStart: overlapEnd, start: overlapEnd, text: fullText.substring(overlapEnd, sent.charEnd) });
        }
      }
      currentRanges = nextRanges.filter(r => r.charStart < r.charEnd);
    }
    sentenceRanges = currentRanges;

    // 4. 수식 LaTeX 데이터 설정 (클립보드 복사용)
    sentenceRanges.forEach(r => {
      if (r.isEquation && r.originalSentenceIdx !== undefined) {
        const origIdx = r.originalSentenceIdx;
        const sents = state.translationSentences && state.translationSentences[pageNum];
        if (sents && sents[origIdx]) {
          const transText = sents[origIdx].trans || '';
          const srcText   = sents[origIdx].src   || '';
          const mathMatches = transText.match(/\$\$[\s\S]*?\$\$|\$[\s\S]*?\$/g)
                           || srcText.match(/\$\$[\s\S]*?\$\$|\$[\s\S]*?\$/g);
          r.latexData = mathMatches ? mathMatches.join(' ') : srcText;
        }
      }
    });

    // 5. state에 가상 텍스트 맵 및 문장 범위 저장
    if (!state.virtualTextMaps)   state.virtualTextMaps   = {};
    if (!state.pdfPageSentences)  state.pdfPageSentences  = {};
    state.virtualTextMaps[pageNum]  = vtm;
    state.pdfPageSentences[pageNum] = sentenceRanges;
    container.dataset.segmented = 'true';

    // 6. 오버레이 레이어 생성 (pageWrapper 기준)
    const pageWrapper = container.closest('.pdf-page-wrapper');
    if (pageWrapper) {
      const overlay = getOrCreateOverlay(pageWrapper);
      clearOverlayBoxes(overlay, 'sentence-hover-box', 'sentence-active-box', 'sentence-memo-box', 'sentence-equation-box', 'sentence-pulse-box');
      // 메모 카드/하이라이트 재렌더링 - 바로 위에서 방금 sentence-memo-box를
      // 지웠기 때문에, segmentPdfElements를 호출하는 곳(번역 완료, 최초 텍스트
      // 레이어 렌더링 등) 어디서든 이 시점에 반드시 다시 그려줘야 한다. 예전에는
      // easypaper_annotations_*(하이라이트/언더라인)에만 있는 "memos" 필드를
      // 잘못 참조하는 죽은 코드(renderMemoOverlay)가 대신 호출되고 있어서,
      // 이 함수를 호출하는 경로 중 memo 재호출을 별도로 챙기지 않는 곳에서는
      // 메모 하이라이트가 그대로 사라진 채 복구되지 않는 버그가 있었다.
      //
      // 다만 이미 번역된 적 있는 페이지인데 아직 번역 문장 데이터가 로드되지
      // 않아 위 2단계에서 정규식 기반 폴백(splitIntoSentences)으로 분할한
      // 상태라면, 여기서 그리는 위치는 번역이 로드된 뒤 alignSentencesToText로
      // 재분할되면서 곧 달라진다. 이 상태로 지금 그리면 메모가 잘못된 위치에
      // 표시됐다가 번역 로딩 완료 시 원래 위치로 튀어 보이므로, 이 경우엔
      // 건너뛰고 최종(정렬된) 세그멘테이션이 나온 뒤에만 그린다.
      const usedFallbackSegmentation = !(sentences && sentences.length > 0)
      if (!(usedFallbackSegmentation && state.translatedPages.has(pageNum))) {
        renderPageMemos(pageNum);
      }
    }
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

// ── 오버레이 기반 문장 호버/클릭 이벤트 시스템 ──────────────────────────────
// 설계: pdf-sentence DOM 클래스 조작 대신, 좌표 기반 hit-test로 문장 감지 후
//       .pdf-highlight-overlay 에 하이라이트 상자를 드로잉합니다.

// 현재 호버 중인 페이지/문장 인덱스
let currentHoverPage = null;
let currentHoverSentenceIdx = null;
// 현재 클릭 고정 중인 active 하이라이트
let activeHighlightPage = null;
let activeHighlightSentenceIdx = null;

// VirtualTextMap에서 특정 문자 위치에 해당하는 sentenceRange를 이진 탐색
// alignSentencesToText는 아주 드물게 서로 겹치는 두 문장 범위를 만들어낼 수 있다
// (전역/프리픽스 폴백 검색이 이미 다른 문장이 차지한 구간보다 앞에서 매칭되는 경우).
// 겹치는 두 범위 중 더 넓은 쪽이 먼저 반환되면, 실제로는 무관한 옆 문장까지 포함한
// 범위가 호버/드웰선택에 그대로 쓰여서 화면상 서로 떨어진 두 위치가 함께 강조되거나
// 선택되는 것처럼 보인다. charIdx를 포함하는 후보가 여럿이면 그 중 가장 좁은(가장
// 구체적인) 범위를 골라, 옆 문장의 여분 영역을 끌고 오지 않도록 한다.
function findSentenceAtChar(charIdx, sentenceRanges) {
  if (!sentenceRanges || sentenceRanges.length === 0) return null;
  let best = null;
  for (const r of sentenceRanges) {
    if (charIdx >= r.charStart && charIdx < r.charEnd) {
      if (!best || (r.charEnd - r.charStart) < (best.charEnd - best.charStart)) {
        best = r;
      }
    }
  }
  return best;
}

// 마우스 위치로부터 대략적인 charIdx를 추정 (caretRangeFromPoint 또는 비율 계산 폴백)
function estimateCharIdxFromPoint(x, y, vtm) {
  // 방법 1: caretRangeFromPoint (Chrome/Edge)
  let node = null, offset = 0;
  if (document.caretRangeFromPoint) {
    const cr = document.caretRangeFromPoint(x, y);
    if (cr) { node = cr.startContainer; offset = cr.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const cp = document.caretPositionFromPoint(x, y);
    if (cp) { node = cp.offsetNode; offset = cp.offset; }
  }

  if (node && node.nodeType === 3) {
    const nr = vtm.nodeRanges.find(r => r.node === node);
    if (nr) return nr.start + offset;
  }

  // 방법 2: 마우스 근처 nodeRange에서 비율로 추정
  for (const nr of vtm.nodeRanges) {
    try {
      const range = document.createRange();
      range.selectNode(nr.node);
      const rect = range.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const ratio = rect.width > 0 ? (x - rect.left) / rect.width : 0;
        const charLen = nr.end - nr.start;
        return nr.start + Math.round(ratio * charLen);
      }
    } catch(e) { /* no-op */ }
  }
  return -1;
}

// DOM Range(사용자가 실제로 드래그해서 선택한 범위)의 시작/끝 지점을 VTM
// 문자 인덱스로 변환한다. 문장 전체가 아니라 사용자가 고른 정확한 부분 범위를
// 그대로 보존하기 위한 용도 - estimateCharIdxFromPoint는 한 지점만 다루므로
// range의 시작과 끝 각각에 대해 호출한다.
function getVtmCharRangeFromSelection(range, vtm) {
  function resolveOffset(node, offset, isEnd) {
    if (node.nodeType === 3) {
      const nr = vtm.nodeRanges.find(r => r.node === node);
      if (nr) return nr.start + Math.min(offset, nr.node.length);
    }
    // 폴백: 텍스트 노드에 직접 매핑되지 않는 경계(예: 필터링된 노드, 요소 경계) -
    // 해당 지점의 화면 좌표로 근사한다.
    const boundary = range.cloneRange();
    boundary.collapse(!isEnd);
    let rect = boundary.getClientRects()[0];
    if (!rect) {
      const el = node.nodeType === 3 ? node.parentElement : node;
      rect = el ? el.getBoundingClientRect() : null;
    }
    if (!rect) return -1;
    return estimateCharIdxFromPoint(rect.left, rect.top + rect.height / 2, vtm);
  }

  const startIdx = resolveOffset(range.startContainer, range.startOffset, false);
  const endIdx = resolveOffset(range.endContainer, range.endOffset, true);
  if (startIdx < 0 || endIdx < 0 || startIdx === endIdx) return null;

  return { charStart: Math.min(startIdx, endIdx), charEnd: Math.max(startIdx, endIdx) };
}

// 오버레이에 호버 하이라이트를 그리고 번역 문장에 클래스를 적용
function applyHoverHighlight(pageNum, sentenceRange) {
  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum];
  if (!vtm) return;

  const pageWrapper = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
  if (!pageWrapper) return;

  const textLayer = pageWrapper.querySelector('.textLayer');
  if (!textLayer) return;

  const overlay = getOrCreateOverlay(pageWrapper);
  clearOverlayBoxes(overlay, 'sentence-hover-box');

  const rects = getSentenceRects(sentenceRange, vtm, textLayer);
  const boxClass = sentenceRange.isEquation ? 'sentence-equation-box' : 'sentence-hover-box';
  renderSentenceOverlay(overlay, rects, boxClass);

  // 번역 패널 하이라이트 (trans-sentence DOM 방식은 유지)
  viewerScrollContainer.querySelectorAll('.sentence-highlight').forEach(el => el.classList.remove('sentence-highlight'));
  const sentenceIdx = sentenceRange.sentenceIdx >= 10000 ? (sentenceRange.originalSentenceIdx ?? sentenceRange.sentenceIdx) : sentenceRange.sentenceIdx;
  viewerScrollContainer.querySelectorAll(
    `.trans-sentence[data-page="${pageNum}"][data-sentence-idx="${sentenceIdx}"]`
  ).forEach(el => el.classList.add('sentence-highlight'));
}

// 오버레이에 active 하이라이트를 그리고 번역 문장에 active 클래스를 적용
function applyActiveHighlight(pageNum, sentenceRange) {
  // 기존 active 하이라이트 클리어
  viewerScrollContainer.querySelectorAll('.pdf-page-wrapper').forEach(pw => {
    const ov = pw.querySelector('.pdf-highlight-overlay');
    if (ov) clearOverlayBoxes(ov, 'sentence-active-box', 'sentence-pulse-box');
  });
  viewerScrollContainer.querySelectorAll('.active-mapped-sentence').forEach(el => el.classList.remove('active-mapped-sentence'));

  if (!sentenceRange || !pageNum) return;

  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum];
  const pageWrapper = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
  if (!vtm || !pageWrapper) return;

  const textLayer = pageWrapper.querySelector('.textLayer');
  if (!textLayer) return;

  const overlay = getOrCreateOverlay(pageWrapper);
  const rects = getSentenceRects(sentenceRange, vtm, textLayer);
  renderSentenceOverlay(overlay, rects, 'sentence-active-box');

  const sentenceIdx = sentenceRange.sentenceIdx >= 10000 ? (sentenceRange.originalSentenceIdx ?? sentenceRange.sentenceIdx) : sentenceRange.sentenceIdx;
  viewerScrollContainer.querySelectorAll(
    `.trans-sentence[data-page="${pageNum}"][data-sentence-idx="${sentenceIdx}"]`
  ).forEach(el => el.classList.add('active-mapped-sentence'));
}

// PDF textLayer 위에서 마우스 위치로 sentenceRange 감지
function detectSentenceAtMouse(e) {
  const el = e.target;
  const pageWrapper = el.closest('.pdf-page-wrapper');
  if (!pageWrapper) return null;

  const textLayer = el.closest('.textLayer');
  if (!textLayer) return null;

  const pageNum = parseInt(pageWrapper.dataset.page, 10);
  if (isNaN(pageNum)) return null;

  const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum];
  const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum];
  if (!vtm || !sentenceRanges) return null;

  const charIdx = estimateCharIdxFromPoint(e.clientX, e.clientY, vtm);
  if (charIdx < 0) return null;

  const sRange = findSentenceAtChar(charIdx, sentenceRanges);
  return sRange ? { pageNum, sentenceRange: sRange } : null;
}

// 700ms 드웰 후 문장 전체를 자동 선택하고 선택 메뉴 표시하는 헬퍼
function startDwellSelection(pageNum, sentenceRange) {
  if (sentenceHoverTimer) { clearTimeout(sentenceHoverTimer); sentenceHoverTimer = null; }

  sentenceHoverTimer = setTimeout(() => {
    if (state.isSelectionDragging) return;
    const curSel = window.getSelection();
    if (curSel && !curSel.isCollapsed) return;

    const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum];
    if (!vtm) return;

    const { nodeRanges } = vtm;
    const srStart = sentenceRange.charStart;
    const srEnd   = sentenceRange.charEnd;

    // 시작 노드 찾기
    let startNode = null, startOff = 0;
    let endNode = null, endOff = 0;
    for (const nr of nodeRanges) {
      if (startNode === null && nr.end > srStart) {
        startNode = nr.node;
        startOff  = Math.max(0, srStart - nr.start);
      }
      if (nr.start < srEnd) {
        endNode = nr.node;
        endOff  = Math.min(nr.node.length, srEnd - nr.start);
      }
    }

    if (startNode && endNode) {
      try {
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        curSel.removeAllRanges();
        curSel.addRange(range);

        state.hoverSelectedPageNum = pageNum;
        state.hoverSelectedSentenceIdx = sentenceRange.sentenceIdx;

        const selRect = range.getBoundingClientRect();
        const pw = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
        const textLayerDiv = pw && pw.querySelector('.textLayer');
        const hasExistingAnnotation = textLayerDiv
          ? selectionOverlapsExistingAnnotation(range, textLayerDiv, pageNum)
          : true;
        showSelectionMenu(selRect, true, hasExistingAnnotation);
      } catch(e) { /* no-op */ }
    }
  }, 700);
}

if (viewerScrollContainer) {
  // mousemove: 드래그 상태 추적 + PDF textLayer 위에서 hover 감지
  viewerScrollContainer.addEventListener('mousemove', (e) => {
    // 드래그 상태 추적
    if (e.buttons === 0) {
      state.isSelectionDragging = false;
      viewerScrollContainer.classList.remove('selection-dragging');
    }
    state.hoverSelectionDisabled = false;

    if (state.isSelectionDragging) return;

    // 어노테이션 스팬 툴팁
    const annSpan = e.target.closest('.pdf-annotation-highlight, .pdf-annotation-underline');
    if (annSpan) showAnnHoverTooltipForSpan(annSpan);

    // 번역 패널 호버는 mouseover로 처리됨 (기존 trans-sentence 방식 유지)
    if (e.target.closest('.trans-page-block')) return;

    // PDF textLayer 위 문장 감지
    const detected = detectSentenceAtMouse(e);
    if (!detected) {
      // textLayer 밖으로 나가면 호버 클리어
      if (currentHoverPage !== null) {
        const pw = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${currentHoverPage}"]`);
        if (pw) {
          const ov = pw.querySelector('.pdf-highlight-overlay');
          if (ov) clearOverlayBoxes(ov, 'sentence-hover-box', 'sentence-equation-box');
        }
        viewerScrollContainer.querySelectorAll('.sentence-highlight').forEach(el => el.classList.remove('sentence-highlight'));
        currentHoverPage = null;
        currentHoverSentenceIdx = null;
        if (sentenceHoverTimer) { clearTimeout(sentenceHoverTimer); sentenceHoverTimer = null; }
      }
      if (!annSpan) hideAnnHoverTooltipWithDelay();
      return;
    }

    const { pageNum, sentenceRange } = detected;
    const isSame = (currentHoverPage === pageNum && currentHoverSentenceIdx === sentenceRange.sentenceIdx);

    // 하이라이트/밑줄 span 위가 아니면서 해당 문장에 메모가 있는 경우 - 메모 전용 호버 툴팁 노출
    // (메모는 pointer-events:none 오버레이로 그려지므로 span hover로는 감지할 수 없어 문장 단위로 감지)
    // isSame일 때는 이미 같은 문장에 대해 처리했으므로 매 mousemove마다 다시 조회하지 않는다.
    if (!annSpan && !isSame) {
      const sentenceIdx = sentenceRange.sentenceIdx >= 10000 ? (sentenceRange.originalSentenceIdx ?? 0) : sentenceRange.sentenceIdx;
      const memo = lookupMemoForSentence(pageNum, sentenceIdx);
      if (memo) {
        showAnnHoverTooltipForMemoSentence(pageNum, sentenceRange, sentenceIdx, memo);
      } else {
        hideAnnHoverTooltipWithDelay();
      }
    }

    if (isSame) return;

    // 이전 페이지 호버 클리어
    if (currentHoverPage !== null && currentHoverPage !== pageNum) {
      const pw = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${currentHoverPage}"]`);
      if (pw) {
        const ov = pw.querySelector('.pdf-highlight-overlay');
        if (ov) clearOverlayBoxes(ov, 'sentence-hover-box', 'sentence-equation-box');
      }
    }

    currentHoverPage = pageNum;
    currentHoverSentenceIdx = sentenceRange.sentenceIdx;

    applyHoverHighlight(pageNum, sentenceRange);

    // 700ms 드웰 선택 (수식 제외, 뷰어 설정에서 꺼져있지 않은 경우에만)
    if (!annSpan && !state.hoverSelectionDisabled && !state.disableHoverTooltip) {
      if (!sentenceRange.isEquation) {
        startDwellSelection(pageNum, sentenceRange);
      }
    }
  });

  // mouseover: trans-sentence 호버 처리 (기존 방식 유지)
  viewerScrollContainer.addEventListener('mouseover', (e) => {
    if (state.isSelectionDragging) return;
    try {
      const annSpan = e.target.closest('.pdf-annotation-highlight, .pdf-annotation-underline');
      if (annSpan) showAnnHoverTooltipForSpan(annSpan);

      const transSent = e.target.closest('.trans-sentence');
      if (!transSent) return;

      const pageWrapper = transSent.closest('.trans-page-block');
      if (!pageWrapper) return;
      const pageNum = parseInt(pageWrapper.dataset.page, 10);
      if (isNaN(pageNum)) return;
      const sentenceIdx = parseInt(transSent.dataset.sentenceIdx, 10);
      if (isNaN(sentenceIdx)) return;

      // 번역 패널 호버 → PDF 오버레이 하이라이트
      // 볼드(**...**) 등으로 한 문장이 여러 DOM 노드에 걸쳐 쪼개진 경우, 같은
      // sentenceIdx를 가진 .trans-sentence 조각이 여러 개 존재한다 - 커서 아래
      // 조각 하나만 하이라이트하면 문장의 나머지 조각이 하이라이트되지 않으므로,
      // 같은 문장에 속한 조각을 전부 찾아 함께 하이라이트한다.
      viewerScrollContainer.querySelectorAll('.sentence-highlight').forEach(el => el.classList.remove('sentence-highlight'));
      pageWrapper.querySelectorAll(`.trans-sentence[data-sentence-idx="${sentenceIdx}"]`).forEach(el => el.classList.add('sentence-highlight'));

      const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum];
      if (sentenceRanges) {
        const sRange = sentenceRanges.find(r => {
          const idx = r.sentenceIdx >= 10000 ? (r.originalSentenceIdx ?? r.sentenceIdx) : r.sentenceIdx;
          return idx === sentenceIdx;
        });
        if (sRange) {
          const pw = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
          if (pw) {
            const ov = getOrCreateOverlay(pw);
            clearOverlayBoxes(ov, 'sentence-hover-box', 'sentence-equation-box');
            const textLayer = pw.querySelector('.textLayer');
            if (textLayer) {
              const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum];
              if (vtm) {
                const rects = getSentenceRects(sRange, vtm, textLayer);
                renderSentenceOverlay(ov, rects, 'sentence-hover-box');
              }
            }
          }
        }
      }
    } catch(err) { /* no-op */ }
  });

  // mouseout: 호버 클리어
  viewerScrollContainer.addEventListener('mouseout', (e) => {
    if (state.isSelectionDragging) return;
    try {
      const annSpan = e.target.closest('.pdf-annotation-highlight, .pdf-annotation-underline');
      if (annSpan) {
        if (!e.relatedTarget || !e.relatedTarget.closest('#ann-hover-tooltip')) {
          hideAnnHoverTooltipWithDelay();
        }
      }
      // trans-sentence mouseout 처리
      const transSent = e.target.closest('.trans-sentence');
      if (transSent && !e.relatedTarget?.closest('.trans-sentence')) {
        viewerScrollContainer.querySelectorAll('.sentence-highlight').forEach(el => el.classList.remove('sentence-highlight'));
        if (currentHoverPage !== null) {
          const pw = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${currentHoverPage}"]`);
          if (pw) {
            const ov = pw.querySelector('.pdf-highlight-overlay');
            if (ov) clearOverlayBoxes(ov, 'sentence-hover-box', 'sentence-equation-box');
          }
        }
      }
    } catch (err) { /* no-op */ }
  });

  // 클릭: PDF textLayer 클릭 → active 하이라이트 + 번역 스크롤
  //        trans-sentence 클릭 → PDF 스크롤
  viewerScrollContainer.addEventListener('click', (e) => {
    try {
      state.hoverSelectionDisabled = true;
      if (sentenceHoverTimer) { clearTimeout(sentenceHoverTimer); sentenceHoverTimer = null; }

      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      // ── trans-sentence 클릭 ──
      const transSent = e.target.closest('.trans-sentence');
      if (transSent) {
        const pageWrapper = transSent.closest('.trans-page-block');
        if (!pageWrapper) return;
        const pageNum = parseInt(pageWrapper.dataset.page, 10);
        if (isNaN(pageNum)) return;
        const sentenceIdx = parseInt(transSent.dataset.sentenceIdx, 10);
        if (isNaN(sentenceIdx)) return;

        const sentenceRanges = state.pdfPageSentences && state.pdfPageSentences[pageNum];
        if (!sentenceRanges) return;

        const sRange = sentenceRanges.find(r => {
          const idx = r.sentenceIdx >= 10000 ? (r.originalSentenceIdx ?? r.sentenceIdx) : r.sentenceIdx;
          return idx === sentenceIdx;
        });
        if (!sRange) return;

        applyActiveHighlight(pageNum, sRange);

        // PDF 영역으로 스크롤
        const vtm = state.virtualTextMaps && state.virtualTextMaps[pageNum];
        const pw = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
        if (vtm && pw) {
          const textLayer = pw.querySelector('.textLayer');
          if (textLayer) {
            const rects = getSentenceRects(sRange, vtm, textLayer);
            if (rects.length > 0) {
              // 해당 pageWrapper가 뷰포트에 없으면 스크롤
              pw.scrollIntoView({ behavior: 'smooth', block: 'center' });

              // pulse 애니메이션
              const overlay = getOrCreateOverlay(pw);
              renderSentenceOverlay(overlay, rects, 'sentence-pulse-box');
              setTimeout(() => clearOverlayBoxes(overlay, 'sentence-pulse-box'), 900);
            }
          }
        }
        return;
      }

      // ── PDF textLayer 클릭 ──
      if (!e.target.closest('.textLayer')) {
        // 비어있는 곳 클릭 → active 클리어
        applyActiveHighlight(null, null);
        return;
      }

      const detected = detectSentenceAtMouse(e);
      if (!detected) {
        applyActiveHighlight(null, null);
        return;
      }

      const { pageNum, sentenceRange } = detected;
      applyActiveHighlight(pageNum, sentenceRange);
      activeHighlightPage = pageNum;
      activeHighlightSentenceIdx = sentenceRange.sentenceIdx;

      // 번역 패널로 스크롤
      // 볼드 등으로 문장이 여러 조각으로 쪼개져 있을 수 있으므로 같은
      // sentenceIdx를 가진 조각을 모두 찾아 함께 펄스 처리한다.
      const transIdx = sentenceRange.sentenceIdx >= 10000 ? (sentenceRange.originalSentenceIdx ?? -1) : sentenceRange.sentenceIdx;
      if (transIdx >= 0) {
        const matches = viewerScrollContainer.querySelectorAll(
          `.trans-sentence[data-page="${pageNum}"][data-sentence-idx="${transIdx}"]`
        );
        if (matches.length > 0) {
          matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
          matches.forEach(match => {
            match.classList.add('sentence-pulse');
            setTimeout(() => match.classList.remove('sentence-pulse'), 1000);
          });
        }
      }
    } catch (err) {
      console.warn("click handler failed:", err);
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
        updateMemoConnectorLine(wrapper, memo)
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

// 페이지 번역 및 인라인 접기/펴기 버튼 클릭 이벤트 바인딩 (이벤트 위임)
viewerScrollContainer.addEventListener('click', (e) => {
  const translateBtn = e.target.closest('.translate-page-btn')
  if (translateBtn) {
    e.stopPropagation()
    const pageNum = Number.parseInt(translateBtn.dataset.page, 10)
    if (Number.isInteger(pageNum)) translatePage(pageNum)
    return
  }

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
function viewerAnnotationTargetFromParams(params) {
  const page = parseInt(params.get('page'), 10)
  if (!Number.isInteger(page) || page < 1) return null
  const toOptionalInt = (key) => {
    const raw = params.get(key)
    if (raw === null) return null
    const value = parseInt(raw, 10)
    return Number.isInteger(value) && value >= 0 ? value : null
  }
  return {
    page,
    kind: params.get('kind') || null,
    memoId: params.get('memoId') || null,
    startOffset: toOptionalInt('start'),
    endOffset: toOptionalInt('end'),
    quote: params.get('quote') || null,
    occurrence: Math.max(1, parseInt(params.get('occurrence'), 10) || 1),
  }
}

function findViewerAnnotationElement(target) {
  const pageWrapper = viewerScrollContainer.querySelector(`.pdf-page-wrapper[data-page="${target.page}"]`)
  if (!pageWrapper) return null
  if (target.memoId) {
    const memoId = CSS.escape(target.memoId)
    return pageWrapper.querySelector(`.sentence-memo-box[data-memo-id="${memoId}"]`)
      || pageWrapper.querySelector(`.pdf-sentence-has-memo[data-memo-id="${memoId}"]`)
      || pageWrapper.querySelector(`.floating-memo[data-id="${memoId}"]`)
  }
  if ((target.kind === 'highlight' || target.kind === 'underline') && target.startOffset !== null) {
    const className = target.kind === 'highlight' ? 'pdf-annotation-highlight' : 'pdf-annotation-underline'
    return Array.from(pageWrapper.querySelectorAll(`.${className}[data-start-offset]`)).find(el => {
      if (Number(el.dataset.startOffset) !== target.startOffset) return false
      return target.endOffset === null || Number(el.dataset.endOffset) === target.endOffset
    }) || null
  }
  return null
}

async function navigateToViewerAnnotation(target) {
  if (!target || target.page > state.totalPages) return
  scrollToPage(viewerScrollContainer, target.page, { instant: true })
  if (target.quote) {
    await locateTermInPdf(target.page, target.quote, target.occurrence)
    return
  }

  const hasExactAnchor = target.memoId || target.startOffset !== null
  if (!hasExactAnchor) return
  const deadline = Date.now() + 4000
  let targetEl = findViewerAnnotationElement(target)
  while (!targetEl && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    targetEl = findViewerAnnotationElement(target)
  }
  if (!targetEl) return

  targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  targetEl.classList.add('viewer-note-jump-target')
  setTimeout(() => targetEl.classList.remove('viewer-note-jump-target'), 1800)
}

async function handleRouting() {
  try {
    const hash = location.hash
    console.log("[Router] handleRouting triggered. Current hash:", hash)

    if (hash.startsWith('#viewer?id=')) {
      const params = new URLSearchParams(hash.slice('#viewer?'.length))
      const docId = params.get('id')
      const wantChatOpen = params.get('chat') === '1'
      const annotationTarget = viewerAnnotationTargetFromParams(params)
      if (docId) {
        if (state.sessionId === docId && viewerScreen.classList.contains('active')) {
          console.log("[Router] Viewer already active for document:", docId)
          if (annotationTarget) await navigateToViewerAnnotation(annotationTarget)
          if (wantChatOpen) openChatSidebar()
          return
        }
        console.log("[Router] Routing to viewer for document:", docId)
        const doc = await fetchLibraryDoc(docId)
        if (doc) {
          await openFromLibrary(doc, false)
          if (annotationTarget && state.sessionId === docId) await navigateToViewerAnnotation(annotationTarget)
          if (wantChatOpen) openChatSidebar()
          return
        }
      }
      location.hash = 'library'
    } else if (hash.startsWith('#compare?ids=')) {
      const idsParam = hash.split('?ids=')[1]
      const ids = (idsParam || '').split(',').map(decodeURIComponent).filter(Boolean)
      if (ids.length >= COMPARE_MIN_DOCS && ids.length <= COMPARE_MAX_DOCS) {
        if (JSON.stringify(compareChatState.docIds) === JSON.stringify(ids) && compareScreen.classList.contains('active')) {
          return
        }
        try {
          const docs = await Promise.all(ids.map(id => fetchLibraryDoc(id)))
          if (docs.every(Boolean)) {
            await openCompareScreen(docs, false)
            return
          }
        } catch (err) {
          console.warn('[Router] 비교 문서 로드 실패:', err)
        }
      }
      showToast('비교할 논문 정보를 불러올 수 없습니다.', 'error')
      location.hash = 'library'
    } else if (hash.startsWith('#chat?id=')) {
      // AI Chats 목록의 "대화" 버튼이 이 해시로 바꾸면(hashchange) 여기로
      // 들어온다 - 드로어는 별도 화면이 아니라 AI Chats 페이지 위에 뜨는
      // 오버레이라서, 먼저 AI Chats 페이지가 보이는 상태를 만든 다음 그
      // 위에 드로어를 연다.
      const params = new URLSearchParams(hash.slice('#chat?'.length))
      const docId = params.get('id')
      if (docId) {
        if (chatDrawerState.docId === docId && chatDrawerEl.classList.contains('open')) {
          return
        }
        try {
          const doc = await fetchLibraryDoc(docId)
          if (doc) {
            if (viewerScreen.classList.contains('active') || !libraryScreen.classList.contains('active')) {
              await showLibraryScreen(false, 'chats')
            } else if (state.currentWorkspacePage !== 'chats') {
              await showWorkspacePage('chats', { pushState: false })
            }
            await openChatDrawer(doc)
            return
          }
        } catch (err) {
          console.warn('[Router] 논문 채팅 문서 로드 실패:', err)
        }
      }
      showToast('대화할 논문 정보를 불러올 수 없습니다.', 'error')
      location.hash = 'chats'
    } else {
      let rawPage = hash.replace('#', '') || 'dashboard'
      const queryIdx = rawPage.indexOf('?')
      let subviewParam = null
      if (queryIdx !== -1) {
        const queryStr = rawPage.slice(queryIdx + 1)
        rawPage = rawPage.slice(0, queryIdx)
        const params = new URLSearchParams(queryStr)
        subviewParam = params.get('subview') || params.get('view')
      }
      if (rawPage === 'heatmap') {
        rawPage = 'graph'
        subviewParam = 'heatmap'
      }
      if (subviewParam) {
        sessionStorage.setItem('easypaper_graph_subview', subviewParam)
      }
      const pageId = rawPage
      if (pageId === 'library' && history.state?.screen === 'library' && history.state?.page === 'library') {
        activeLibraryFolderId = history.state.libraryFolderId || null
        activeCategoryFilter = 'ALL'
      }
      console.log("[Router] Routing to workspace page:", pageId, "Viewer active:", viewerScreen.classList.contains('active'), "Library active:", libraryScreen.classList.contains('active'))
      if (viewerScreen.classList.contains('active') || !libraryScreen.classList.contains('active')) {
        await showLibraryScreen(false, WORKSPACE_PAGES.includes(pageId) ? pageId : 'dashboard')
      } else if (WORKSPACE_PAGES.includes(pageId) && (state.currentWorkspacePage !== pageId || subviewParam)) {
        await showWorkspacePage(pageId, { pushState: false })
      }
    }
  } catch (err) {
    console.error("[Router] Error in handleRouting:", err)
  }
}

window.addEventListener('popstate', (e) => {
  console.log("[Router] popstate fired. state:", e.state)
  const isLibraryHistory = e.state?.screen === 'library' && e.state?.page === 'library'
  const isLegacyLibraryRoot = !e.state && location.hash === '#library'
  if (isLibraryHistory || isLegacyLibraryRoot) {
    const requestedFolderId = e.state?.libraryFolderId || null
    const canValidateFolder = state.currentWorkspacePage === 'library'
    const folderExists = !requestedFolderId || !canValidateFolder || libraryFolders.some(folder => folder.id === requestedFolderId)
    activeLibraryFolderId = folderExists ? requestedFolderId : null
    if (requestedFolderId && !folderExists) {
      history.replaceState({ ...(e.state || {}), screen: 'library', page: 'library', libraryFolderId: null }, '', location.href)
    }
    activeCategoryFilter = 'ALL'
    clearDocSelection()
    if (state.currentWorkspacePage === 'library') {
      filterLibraryCards(currentLibraryDocs)
      renderFolderNavigation(currentLibraryDocs)
    }
  }
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
      infoMsg.innerHTML = `${icon('info', 12, 'style="vertical-align:-2px;margin-right:3px"')}${t('viewer:outline.noToc')}`
      outlineContent.appendChild(infoMsg)

      for (let p = 1; p <= state.totalPages; p++) {
        const div = document.createElement('button')
        div.type = 'button'
        div.className = 'outline-item depth-0'
        const iconSvg = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="opacity:0.6; margin-right:8px; flex-shrink:0;"><circle cx="12" cy="12" r="8"/></svg>`
        div.innerHTML = `${iconSvg}<span>${t('viewer:pageLabel', { page: p })}</span>`
        div.addEventListener('click', () => {
          scrollToPage(viewerScrollContainer, p)
        })
        div.title = t('viewer:goToPage', { page: p })
        outlineContent.appendChild(div)
      }
      return
    }

    function renderTree(items, depth = 0) {
      items.forEach(item => {
        const div = document.createElement('button')
        div.type = 'button'
        div.className = `outline-item depth-${depth}`
        const iconSvg = depth === 0
          ? `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="opacity:0.6; margin-right:8px; flex-shrink:0;"><circle cx="12" cy="12" r="8"/></svg>`
          : `<svg width="5" height="5" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.4; margin-right:8px; flex-shrink:0; margin-left:4px;"><circle cx="12" cy="12" r="10"/></svg>`
        div.innerHTML = `${iconSvg}<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.title)}</span>`
        if (item.pageNum) {
          div.addEventListener('click', () => {
            scrollToPage(viewerScrollContainer, item.pageNum)
          })
          div.title = t('viewer:goToPage', { page: item.pageNum })
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

function hideOutlineSidebar({ restoreFocus = false } = {}) {
  if (outlineSidebar) {
    outlineSidebar.classList.add('hidden')
    if (outlineToggleBtn) {
      outlineToggleBtn.classList.remove('active')
      outlineToggleBtn.setAttribute('aria-expanded', 'false')
      if (restoreFocus) outlineToggleBtn.focus()
    }
  }
}

function showOutlineSidebar() {
  if (outlineSidebar) {
    outlineSidebar.classList.remove('hidden')
    if (outlineToggleBtn) {
      outlineToggleBtn.classList.add('active')
      outlineToggleBtn.setAttribute('aria-expanded', 'true')
    }
    window.requestAnimationFrame(() => outlineContent?.querySelector('.outline-item:not(:disabled)')?.focus())
  }
}

// 목차 이벤트 바인딩
if (outlineToggleBtn) {
  outlineToggleBtn.setAttribute('aria-controls', 'outline-sidebar')
  outlineToggleBtn.setAttribute('aria-expanded', 'false')
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
  outlineCloseBtn.addEventListener('click', () => hideOutlineSidebar({ restoreFocus: true }))
  outlineSidebar?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); hideOutlineSidebar({ restoreFocus: true }) }
  })
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
