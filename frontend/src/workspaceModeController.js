import {
  CURRENT_ONBOARDING_VERSION,
  DOCUMENT_TYPE_OPTIONS_KEY,
  ONBOARDING_VERSION_KEY,
  defaultDocumentType,
  documentTypeLabel,
  getDocumentTypes,
  getStoredWorkspaceMode,
  storeWorkspaceMode,
} from './documentModes.js'


const MODE_COPY = {
  research: {
    title: '대시보드', library: '논문 라이브러리', history: '독서 기록',
    chats: 'AI Chats', notes: '연구 노트', search: '연구 문서에서 검색', add: '논문 추가',
  },
  general: {
    title: '문서 홈', library: '문서 라이브러리', history: '읽기 기록',
    chats: '문서 AI', notes: '문서 노트', search: '일반 문서에서 검색', add: '문서 추가',
  },
}


export function createWorkspaceModeController({
  fetchDocumentTypes, getWorkspaceSettings, patchWorkspaceSettings,
  onModeChange = () => {}, showToast = () => {},
}) {
  let mode = getStoredWorkspaceMode()
  let registry = null
  let pendingUpload = null
  let selectedType = null

  const modal = document.getElementById('document-type-modal')
  const optionRoot = document.getElementById('document-type-options')
  const confirmBtn = document.getElementById('document-type-confirm-btn')
  const summary = document.getElementById('document-upload-summary')
  const modeChip = document.getElementById('upload-mode-chip')
  const uploadModeSwitch = document.getElementById('document-upload-switch-mode-btn')

  function updateCopy() {
    const copy = MODE_COPY[mode]
    const labels = {
      dashboard: copy.title, library: copy.library, history: copy.history,
      chats: copy.chats, notes: copy.notes, graph: 'Research Graph',
    }
    document.body.dataset.workspaceMode = mode
    document.querySelectorAll('[data-workspace-mode]').forEach(button => {
      const selected = button.dataset.workspaceMode === mode
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    })
    document.querySelectorAll('.sidebar-nav-item[data-page]').forEach(button => {
      const label = labels[button.dataset.page]
      if (!label) return
      const text = button.querySelector('.sidebar-nav-label')
      const tooltip = button.querySelector('.sidebar-tooltip')
      if (text) text.textContent = label
      if (tooltip) tooltip.textContent = label
    })
    const search = document.getElementById('workspace-search-input')
    if (search) search.placeholder = copy.search
    const addLabel = document.querySelector('#lib-add-paper-btn .lib-add-label')
    if (addLabel) addLabel.textContent = copy.add
  }

  async function setMode(nextMode, { persist = true } = {}) {
    const normalized = storeWorkspaceMode(nextMode)
    if (normalized === mode && document.body.dataset.workspaceMode) return
    mode = normalized
    updateCopy()
    window.dispatchEvent(new CustomEvent('easypaper:workspace-mode', { detail: { mode } }))
    if (persist) {
      patchWorkspaceSettings({ preferred_workspace_mode: mode }).catch(() => {
        showToast('워크스페이스 모드를 서버에 저장하지 못했습니다.', 'warning')
      })
    }
    await onModeChange(mode)
  }

  document.querySelectorAll('[data-workspace-mode]').forEach(button => {
    button.addEventListener('click', () => setMode(button.dataset.workspaceMode))
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      setMode(mode === 'research' ? 'general' : 'research')
    })
  })

  async function initialize() {
    const [typesResult, settingsResult] = await Promise.allSettled([
      fetchDocumentTypes(), getWorkspaceSettings(),
    ])
    if (typesResult.status === 'fulfilled') registry = typesResult.value
    if (settingsResult.status === 'fulfilled') {
      const settings = settingsResult.value
      if (settings.preferred_workspace_mode) mode = storeWorkspaceMode(settings.preferred_workspace_mode)
      if (Number.isInteger(settings.onboarding_version)) {
        localStorage.setItem(ONBOARDING_VERSION_KEY, String(settings.onboarding_version))
      }
      if (settings.document_type_options && Object.keys(settings.document_type_options).length > 0) {
        localStorage.setItem(DOCUMENT_TYPE_OPTIONS_KEY, JSON.stringify(settings.document_type_options))
      }
    }
    updateCopy()
    return { mode, registry, onboardingVersion: Number(localStorage.getItem(ONBOARDING_VERSION_KEY) || 0) }
  }

  function closeUploadModal(result = null) {
    modal?.classList.remove('is-visible')
    modal?.classList.add('hidden')
    const resolve = pendingUpload
    pendingUpload = null
    selectedType = null
    if (resolve) resolve(result)
  }

  function renderUploadTypes() {
    selectedType = null
    confirmBtn.disabled = true
    modeChip.textContent = mode === 'research' ? '연구 모드' : '일반 문서 모드'
    if (uploadModeSwitch) uploadModeSwitch.textContent = mode === 'research' ? '일반 문서 모드로 전환' : '연구 모드로 전환'
    summary.textContent = ''
    optionRoot.innerHTML = ''
    getDocumentTypes(registry, mode).forEach(type => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'document-type-option'
      button.setAttribute('role', 'radio')
      button.setAttribute('aria-checked', 'false')
      button.innerHTML = `<strong>${type.label}</strong><span>${type.description || '문서 목적에 맞는 번역·AI 정책 적용'}</span>`
      button.addEventListener('click', () => {
        selectedType = type.value
        optionRoot.querySelectorAll('[role="radio"]').forEach(item => item.setAttribute('aria-checked', String(item === button)))
        confirmBtn.disabled = false
        summary.textContent = `${mode === 'research' ? '연구' : '일반 문서'} · ${type.label}`
      })
      optionRoot.appendChild(button)
    })
  }

  function chooseUploadClassification(files) {
    if (!modal || !optionRoot) {
      return Promise.resolve({ documentMode: mode, documentType: defaultDocumentType(mode), files })
    }
    if (pendingUpload) closeUploadModal(null)
    renderUploadTypes()
    modal.classList.remove('hidden')
    requestAnimationFrame(() => modal.classList.add('is-visible'))
    optionRoot.querySelector('button')?.focus()
    return new Promise(resolve => { pendingUpload = resolve })
  }

  confirmBtn?.addEventListener('click', () => {
    if (!selectedType) return
    closeUploadModal({ documentMode: mode, documentType: selectedType })
  })
  document.getElementById('document-type-close-btn')?.addEventListener('click', () => closeUploadModal(null))
  document.getElementById('document-type-cancel-btn')?.addEventListener('click', () => closeUploadModal(null))
  uploadModeSwitch?.addEventListener('click', async () => {
    await setMode(mode === 'research' ? 'general' : 'research')
    renderUploadTypes()
    optionRoot.querySelector('button')?.focus()
  })
  modal?.addEventListener('click', event => { if (event.target === modal) closeUploadModal(null) })

  return {
    initialize, setMode, chooseUploadClassification,
    getMode: () => mode,
    getRegistry: () => registry,
    getTypeLabel: (docMode, type) => documentTypeLabel(registry, docMode, type),
    markOnboardingComplete: selectedMode => {
      localStorage.setItem(ONBOARDING_VERSION_KEY, String(CURRENT_ONBOARDING_VERSION))
      return setMode(selectedMode, { persist: false })
    },
  }
}
