const MODE_DEFAULTS = {
  research: {
    targetLang: 'ko',
    style: 'academic',
    translationMode: 'auto',
    ignoreMath: false,
    ignoreTable: true,
    ignoreRefs: false,
    keywordMode: 'manual',
    summaryMode: 'manual',
    disableInsights: false,
    disableCitationOverlay: false,
    disableFigureOverlay: false,
    disablePrimer: false,
  },
  general: {
    targetLang: 'ko',
    style: 'natural',
    translationMode: 'scroll',
    ignoreMath: false,
    ignoreTable: false,
    ignoreRefs: false,
    keywordMode: 'manual',
    summaryMode: 'manual',
    disableInsights: false,
    disableCitationOverlay: true,
    disableFigureOverlay: false,
    disablePrimer: true,
  },
}

const LEGACY_KEYS = {
  targetLang: 'easypaper_target_lang',
  style: 'easypaper_style',
  translationMode: 'easypaper_translation_mode',
  ignoreMath: 'easypaper_ignore_math',
  ignoreTable: 'easypaper_ignore_table',
  ignoreRefs: 'easypaper_ignore_refs',
  keywordMode: 'easypaper_keyword_mode',
  summaryMode: 'easypaper_summary_mode',
  disableInsights: 'easypaper_disable_insights',
  disableCitationOverlay: 'easypaper_disable_citation_overlay',
  disableFigureOverlay: 'easypaper_disable_figure_overlay',
  disablePrimer: 'easypaper_disable_primer',
}

const BOOLEAN_SETTINGS = new Set([
  'ignoreMath', 'ignoreTable', 'ignoreRefs', 'disableInsights',
  'disableCitationOverlay', 'disableFigureOverlay', 'disablePrimer',
])
const LEGACY_LANGUAGE_VALUES = {
  '한국어': 'ko', '영어': 'en', '일본어': 'ja', '중국어': 'zh-Hans',
}

export function migrateTargetLanguage(value) {
  return LEGACY_LANGUAGE_VALUES[value] || value
}


export function normalizeSettingsMode(mode) {
  return mode === 'general' ? 'general' : 'research'
}

export function modeSettingStorageKey(name, mode) {
  const normalizedMode = normalizeSettingsMode(mode)
  const snakeName = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
  return `easypaper_${snakeName}_${normalizedMode}`
}

export function getModeSetting(name, mode, storage = localStorage) {
  const normalizedMode = normalizeSettingsMode(mode)
  const fallback = MODE_DEFAULTS[normalizedMode][name]
  if (fallback === undefined) throw new Error(`Unknown mode setting: ${name}`)

  let raw = storage.getItem(modeSettingStorageKey(name, normalizedMode))
  // 기존 전역 설정은 연구 모드의 값으로 승계한다. 번역 대상 언어는 사용자의
  // 기본 선호도라 일반 문서도 첫 사용 시 기존 값을 승계한다.
  if (raw === null && (normalizedMode === 'research' || name === 'targetLang')) {
    raw = storage.getItem(LEGACY_KEYS[name])
  }
  if (raw === null) return fallback
  if (name === "targetLang") {
    const migrated = migrateTargetLanguage(raw)
    if (migrated !== raw) storage.setItem(modeSettingStorageKey(name, normalizedMode), migrated)
    return migrated
  }
  return BOOLEAN_SETTINGS.has(name) ? raw === 'true' : raw
}

export function setModeSetting(name, mode, value, storage = localStorage) {
  const key = modeSettingStorageKey(name, mode)
  storage.setItem(key, String(value))
  return value
}

export function getModeDefaults(mode) {
  return { ...MODE_DEFAULTS[normalizeSettingsMode(mode)] }
}
