import {
  CURRENT_ONBOARDING_VERSION,
  DOCUMENT_TYPE_OPTIONS_KEY,
  ONBOARDING_VERSION_KEY,
  WORKSPACE_PURPOSE_SELECTED_KEY,
  defaultDocumentType,
  documentTypeLabel,
  getDocumentTypes,
  getStoredWorkspaceMode,
  isWorkspaceModeAvailable,
  storeWorkspaceMode,
} from './documentModes.js'
import { t } from './i18n.js'


function modeCopy(mode) {
  const copy = {
    research: {
      title: ['navigation:researchDashboard', t('navigation:researchDashboard')],
      library: ['navigation:researchLibrary', t('navigation:researchLibrary')],
      history: ['navigation:history', t('navigation:history')],
      chats: ['navigation:chats', t('navigation:chats')],
      notes: ['navigation:notes', t('navigation:notes')],
      search: ['navigation:researchSearch', t('navigation:researchSearch')],
      add: ['navigation:addPaper', t('navigation:addPaper')],
    },
    general: {
      title: ['navigation:generalDashboard', t('navigation:generalDashboard')],
      library: ['navigation:generalLibrary', t('navigation:generalLibrary')],
      history: ['navigation:history', t('navigation:history')],
      chats: ['navigation:generalChats', t('navigation:generalChats')],
      notes: ['navigation:generalNotes', t('navigation:generalNotes')],
      search: ['navigation:generalSearch', t('navigation:generalSearch')],
      add: ['navigation:addDocument', t('navigation:addDocument')],
    },
  }[mode]
  return Object.fromEntries(Object.entries(copy).map(([name, [key, value]]) => [name, { key, value }]))
}


export function createWorkspaceModeController({
  fetchDocumentTypes, getWorkspaceSettings, patchWorkspaceSettings,
  onModeChange = () => {}, showToast = () => {},
}) {
  let mode = getStoredWorkspaceMode()
  let registry = null
  let pendingUpload = null
  let selectedType = null
  let classificationMode = mode
  let classificationContext = ''

  const modal = document.getElementById('document-type-modal')
  const optionRoot = document.getElementById('document-type-options')
  const confirmBtn = document.getElementById('document-type-confirm-btn')
  const aiBtn = document.getElementById('document-type-ai-btn')
  const summary = document.getElementById('document-upload-summary')
  const modeChip = document.getElementById('upload-mode-chip')
  const uploadModeSwitch = document.getElementById('document-upload-switch-mode-btn')

  function getPageLabel(pageId) {
    const copy = modeCopy(mode)
    return {
      dashboard: copy.title.value, library: copy.library.value, history: copy.history.value,
      chats: copy.chats.value, notes: copy.notes.value, graph: 'Research Graph',
    }[pageId] || ''
  }

  function updateCopy() {
    const copy = modeCopy(mode)
    document.body.dataset.workspaceMode = mode
    document.querySelectorAll('[data-workspace-mode]').forEach(button => {
      const selected = button.dataset.workspaceMode === mode
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    })
    document.querySelectorAll('.sidebar-nav-item[data-page]').forEach(button => {
      const label = getPageLabel(button.dataset.page)
      if (!label) return
      const text = button.querySelector('.sidebar-nav-label')
      const tooltip = button.querySelector('.sidebar-tooltip')
      if (text) {
        const copyName = button.dataset.page === 'dashboard' ? 'title' : button.dataset.page
        if (copy[copyName]?.key) text.dataset.i18n = copy[copyName].key
        text.textContent = label
      }
      if (tooltip) tooltip.textContent = label
    })
    const search = document.getElementById('workspace-search-input')
    const librarySearch = document.getElementById('library-search-input')
    if (librarySearch) {
      librarySearch.placeholder = mode === 'general'
        ? '문서 제목, 파일명, 번역된 내용 검색...'
        : '논문 제목, 파일명, 번역된 내용 검색...'
    }

    if (search) {
      search.dataset.i18nPlaceholder = copy.search.key
      search.placeholder = copy.search.value
    }
    const addLabel = document.querySelector('#lib-add-paper-btn .lib-add-label')
    if (addLabel) {
      addLabel.dataset.i18n = copy.add.key
      addLabel.textContent = copy.add.value
    }
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

  document.addEventListener('easypaper:locale-changed', updateCopy)

  async function initialize() {
    const [typesResult, settingsResult] = await Promise.allSettled([
      fetchDocumentTypes(), getWorkspaceSettings(),
    ])
    if (typesResult.status === 'fulfilled') {
      registry = typesResult.value
      const generalEnabled = isWorkspaceModeAvailable(registry, 'general')
      document.querySelectorAll('[data-workspace-mode="general"]').forEach(button => {
        button.hidden = !generalEnabled
        button.disabled = !generalEnabled
      })
      if (!generalEnabled && mode === 'general') mode = storeWorkspaceMode('research')
    }
    if (settingsResult.status === 'fulfilled') {
      const settings = settingsResult.value
      if (settings.preferred_workspace_mode) mode = storeWorkspaceMode(settings.preferred_workspace_mode)
      if (Number.isInteger(settings.onboarding_version)) {
        localStorage.setItem(ONBOARDING_VERSION_KEY, String(settings.onboarding_version))
        if (settings.onboarding_version >= 1 && settings.preferred_workspace_mode) {
          localStorage.setItem(WORKSPACE_PURPOSE_SELECTED_KEY, '1')
        }
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
    modeChip.textContent = classificationMode === 'research' ? '연구 모드' : '일반 문서 모드'
    if (uploadModeSwitch) uploadModeSwitch.textContent = classificationMode === 'research' ? '일반 문서 모드로 전환' : '연구 모드로 전환'
    summary.textContent = classificationContext
    optionRoot.innerHTML = ''
    getDocumentTypes(registry, classificationMode).forEach(type => {
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
        const classification = `${classificationMode === 'research' ? '연구' : '일반 문서'} · ${type.label}`
        summary.textContent = classificationContext ? `${classificationContext} · ${classification}` : classification
      })
      optionRoot.appendChild(button)
    })
  }

  function chooseClassification(initialMode, purpose = 'upload', context = '') {
    classificationMode = initialMode === 'general' ? 'general' : 'research'
    classificationContext = context
    if (!modal || !optionRoot) {
      return Promise.resolve({ documentMode: classificationMode, documentType: defaultDocumentType(classificationMode), classificationMethod: 'manual' })
    }
    if (pendingUpload) closeUploadModal(null)
    const title = modal.querySelector('.modal-header h2')
    if (title) title.textContent = purpose === 'upload' ? 'PDF 업로드' : '문서 분류 변경'
    if (confirmBtn) confirmBtn.textContent = purpose === 'upload' ? '업로드' : '변경'
    if (aiBtn) aiBtn.classList.toggle('hidden', purpose !== 'upload')
    renderUploadTypes()
    modal.classList.remove('hidden')
    requestAnimationFrame(() => modal.classList.add('is-visible'))
    optionRoot.querySelector('button')?.focus()
    return new Promise(resolve => { pendingUpload = resolve })
  }

  function chooseUploadClassification(files) {
    const file = Array.from(files || [])[0]
    return chooseClassification(mode, 'upload', file?.name || '')
  }
  async function chooseUploadClassifications(files) {
    const selected = []
    const list = Array.from(files)
    for (let index = 0; index < list.length; index++) {
      const file = list[index]
      const pending = chooseClassification(mode, 'upload', `${index + 1}/${list.length} · ${file.name}`)
      if (confirmBtn) confirmBtn.textContent = index === list.length - 1 ? '업로드' : '다음'
      const result = await pending
      if (!result) return null
      selected.push({ file, classification: result })
    }
    return selected
  }
  function chooseDocumentClassification(currentMode) { return chooseClassification(currentMode, 'change') }

  confirmBtn?.addEventListener('click', () => {
    if (!selectedType) return
    closeUploadModal({ documentMode: classificationMode, documentType: selectedType, classificationMethod: 'manual' })
  })
  aiBtn?.addEventListener('click', () => {
    closeUploadModal({
      documentMode: classificationMode,
      documentType: defaultDocumentType(classificationMode),
      classificationMethod: 'ai',
    })
  })
  document.getElementById('document-type-close-btn')?.addEventListener('click', () => closeUploadModal(null))
  document.getElementById('document-type-cancel-btn')?.addEventListener('click', () => closeUploadModal(null))
  uploadModeSwitch?.addEventListener('click', () => {
    classificationMode = classificationMode === 'research' ? 'general' : 'research'
    renderUploadTypes()
    optionRoot.querySelector('button')?.focus()
  })
  modal?.addEventListener('click', event => { if (event.target === modal) closeUploadModal(null) })

  return {
    initialize, setMode, chooseUploadClassification, chooseUploadClassifications, chooseDocumentClassification, getPageLabel,
    getMode: () => mode,
    getRegistry: () => registry,
    getTypeLabel: (docMode, type) => documentTypeLabel(registry, docMode, type),
    markOnboardingComplete: selectedMode => {
      localStorage.setItem(ONBOARDING_VERSION_KEY, String(CURRENT_ONBOARDING_VERSION))
      localStorage.setItem(WORKSPACE_PURPOSE_SELECTED_KEY, '1')
      return setMode(selectedMode, { persist: false })
    },
  }
}
