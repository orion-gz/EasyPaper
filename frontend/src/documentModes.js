import { t } from './i18n.js'

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
    ['technical', '기술 문서'], ['academic_book', () => t('common:documentTypes.academicBook', { fallback: '전공 서적·학술 문서' })],
    ['general_book', () => t('common:documentTypes.generalBook', { fallback: '일반·교양서' })], ['literary_work', () => t('common:documentTypes.literaryWork', { fallback: '문학·서사' })],
    ['article', () => t('common:documentTypes.article', { fallback: '기사·칼럼' })], ['report', () => t('common:documentTypes.report', { fallback: '분석 보고서' })],
    ['manual', () => t('common:documentTypes.manual', { fallback: '매뉴얼·가이드' })], ['legal_policy', () => t('common:documentTypes.legalPolicy', { fallback: '법률·정책 문서' })],
    ['presentation', () => t('common:documentTypes.presentation', { fallback: '발표·강의 자료' })], ['other', '기타'],
    ['book', () => t('common:documentTypes.legacyBook', { fallback: '책(재분류 필요)' }), false],
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

function allDocumentTypes(registry, mode) {
  const normalized = normalizeWorkspaceMode(mode)
  const found = registry?.modes?.find(item => item.value === normalized)?.types
  if (Array.isArray(found) && found.length) return found
  return FALLBACK_DOCUMENT_TYPES[normalized].map(([value, label, selectable = true]) => ({ value, label: typeof label === 'function' ? label() : label, mode: normalized, selectable }))
}

export function getDocumentTypes(registry, mode) {
  return allDocumentTypes(registry, mode).filter(type => type.selectable !== false)
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
  return allDocumentTypes(registry, mode).find(item => item.value === type)?.label || type
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
