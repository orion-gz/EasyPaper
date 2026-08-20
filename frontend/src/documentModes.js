export const WORKSPACE_MODE_KEY = 'easypaper_workspace_mode'
export const ONBOARDING_VERSION_KEY = 'easypaper_onboarding_version'
export const WORKSPACE_PURPOSE_SELECTED_KEY = 'easypaper_workspace_purpose_selected'
export const DOCUMENT_TYPE_OPTIONS_KEY = 'easypaper_document_type_options_v1'
export const CURRENT_ONBOARDING_VERSION = 1

export const FALLBACK_DOCUMENT_TYPES = {
  research: [
    ['research_paper', '연구 논문'], ['review_survey', '리뷰·서베이'],
    ['thesis', '학위 논문'], ['preprint', '프리프린트'], ['academic_report', '학술 보고서'],
  ],
  general: [
    ['technical', '기술 문서'], ['book', '책'], ['article', '아티클'],
    ['report', '보고서'], ['manual', '매뉴얼'], ['other', '기타'],
  ],
}

export function normalizeWorkspaceMode(value) {
  return value === 'general' ? 'general' : 'research'
}

export function getStoredWorkspaceMode(storage = localStorage) {
  return normalizeWorkspaceMode(storage.getItem(WORKSPACE_MODE_KEY))
}

export function storeWorkspaceMode(mode, storage = localStorage) {
  const normalized = normalizeWorkspaceMode(mode)
  storage.setItem(WORKSPACE_MODE_KEY, normalized)
  return normalized
}

export function getDocumentTypes(registry, mode) {
  const normalized = normalizeWorkspaceMode(mode)
  const found = registry?.modes?.find(item => item.value === normalized)?.types
  if (Array.isArray(found) && found.length) return found
  return FALLBACK_DOCUMENT_TYPES[normalized].map(([value, label]) => ({ value, label, mode: normalized }))
}

export function isWorkspaceModeAvailable(registry, mode) {
  const normalized = normalizeWorkspaceMode(mode)
  if (normalized === 'general' && registry?.rollout?.general_document_mode === false) return false
  return true
}

export function defaultDocumentType(mode) {
  return normalizeWorkspaceMode(mode) === 'general' ? 'other' : 'research_paper'
}

export function documentTypeLabel(registry, mode, type) {
  return getDocumentTypes(registry, mode).find(item => item.value === type)?.label || type
}

export function loadDocumentTypeOptions(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(DOCUMENT_TYPE_OPTIONS_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function saveDocumentTypeOptions(type, options, storage = localStorage) {
  const all = loadDocumentTypeOptions(storage)
  all[type] = { ...options }
  storage.setItem(DOCUMENT_TYPE_OPTIONS_KEY, JSON.stringify(all))
  return all[type]
}
