import i18next from 'i18next'
import { INITIAL_NAMESPACES, UI_LOCALES } from './locales/manifest.js'

const modules = typeof import.meta.glob === 'function' ? import.meta.glob('./locales/*/*.json') : {}
const loaded = new Set()
let currentLocale = null

function browserLocale() {
  const languages = typeof navigator === 'undefined' ? [] : (navigator.languages || [navigator.language])
  return languages.some((value) => String(value).toLowerCase().startsWith('ko')) ? 'ko' : 'en'
}

function normalizeLocale(locale) {
  return Object.hasOwn(UI_LOCALES, locale) ? locale : 'en'
}

async function loadBundle(locale, namespace) {
  const key = locale + ':' + namespace
  if (loaded.has(key)) return
  const loader = modules['./locales/' + locale + '/' + namespace + '.json']
  if (!loader) return
  const module = await loader()
  i18next.addResourceBundle(locale, namespace, module.default, true, true)
  loaded.add(key)
}

export async function loadNamespaces(namespaces) {
  const requested = [...new Set(namespaces)]
  await Promise.all([
    ...requested.map((namespace) => loadBundle('en', namespace)),
    ...requested.map((namespace) => loadBundle(currentLocale || 'en', namespace)),
  ])
  await i18next.loadNamespaces(requested)
}

export async function initI18n() {
  const stored = localStorage.getItem('easypaper_ui_locale')
  currentLocale = normalizeLocale(stored || browserLocale())
  await i18next.init({
    lng: currentLocale,
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: [],
    resources: {},
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
  })
  await loadNamespaces(INITIAL_NAMESPACES)
  applyDocumentLocale()
  translateDocument()
  document.documentElement.classList.remove('i18n-loading')
  document.dispatchEvent(new CustomEvent('easypaper:locale-changed', { detail: { locale: currentLocale } }))
  return currentLocale
}

export function getLocale() {
  return currentLocale || 'en'
}

export async function changeLocale(locale, { persist = true } = {}) {
  currentLocale = normalizeLocale(locale)
  const namespaces = [...new Set([...INITIAL_NAMESPACES, ...loaded].map((value) => value.split(':').pop()))]
  await loadNamespaces(namespaces)
  await i18next.changeLanguage(currentLocale)
  if (persist) localStorage.setItem('easypaper_ui_locale', currentLocale)
  applyDocumentLocale()
  translateDocument()
  document.dispatchEvent(new CustomEvent('easypaper:locale-changed', { detail: { locale: currentLocale } }))
}

function applyDocumentLocale() {
  const metadata = UI_LOCALES[currentLocale] || UI_LOCALES.en
  document.documentElement.lang = metadata.code
  document.documentElement.dir = metadata.direction
}

export function t(key, params = {}) {
  const value = i18next.t(key, params)
  if (value && value !== key) return value
  const fallback = i18next.t(key, { ...params, lng: 'en' })
  return fallback && fallback !== key ? fallback : params.fallback || ''
}

export function translateDocument(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((element) => {
    const value = t(element.dataset.i18n)
    if (value) element.textContent = value
  })
  const bindings = [
    ['placeholder', 'i18nPlaceholder', 'data-i18n-placeholder'],
    ['title', 'i18nTitle', 'data-i18n-title'],
    ['aria-label', 'i18nAriaLabel', 'data-i18n-aria-label'],
  ]
  for (const [attribute, dataName, selector] of bindings) {
    root.querySelectorAll('[' + selector + ']').forEach((element) => {
      const value = t(element.dataset[dataName])
      if (value) element.setAttribute(attribute, value)
    })
  }
}

export function formatNumber(value, options) {
  return new Intl.NumberFormat(getLocale(), options).format(value)
}

export function formatDate(value, options) {
  return new Intl.DateTimeFormat(getLocale(), options).format(new Date(value))
}

export function errorMessage(payload, fallback = '') {
  if (payload && typeof payload === 'object' && payload.code) {
    return t('errors:' + payload.code, { ...(payload.params || {}), fallback: payload.fallback })
  }
  if (payload?.detail && typeof payload.detail === 'object') {
    return errorMessage(payload.detail, fallback)
  }
  if (typeof payload?.detail === 'string') return payload.detail
  if (typeof payload?.message === 'string') return payload.message
  return fallback || t('errors:unknown')
}
