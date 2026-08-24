import i18next from 'i18next'
import { FEATURE_NAMESPACES, INITIAL_NAMESPACES, UI_LOCALES } from './locales/manifest.js'
import uiSourceMap from './locales/ui-source-map.json' with { type: 'json' }

const modules = import.meta.env ? import.meta.glob('./locales/*/*.json') : {}
const loaded = new Set()
let currentLocale = null
let domObserver = null
let translatingMutations = false
const localizedTextNodes = new WeakMap()
const localizedAttributes = new WeakMap()

export function browserLocale() {
  const languages = typeof navigator === 'undefined' ? [] : (navigator.languages || [navigator.language])
  return languages.some((value) => String(value).toLowerCase().startsWith('ko')) ? 'ko' : 'en'
}

export function normalizeLocale(locale) {
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

export async function loadFeatureNamespaces(feature) {
  await loadNamespaces(FEATURE_NAMESPACES[feature] || [])
  translateDocument()
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
  observeDynamicTranslations()
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
  const bareKey = key.includes(':') ? key.split(':').slice(1).join(':') : key
  if (value && value !== key && value !== bareKey) return value
  const fallback = i18next.t(key, { ...params, lng: 'en' })
  return fallback && fallback !== key && fallback !== bareKey ? fallback : params.fallback || ''
}

export function translateDocument(root = document) {
  const select = (selector) => [
    ...(root.matches?.(selector) ? [root] : []),
    ...(root.querySelectorAll?.(selector) || []),
  ]
  select('[data-i18n]').forEach((element) => {
    const value = t(element.dataset.i18n)
    if (value) element.textContent = value
  })
  const bindings = [
    ['placeholder', 'i18nPlaceholder', 'data-i18n-placeholder'],
    ['title', 'i18nTitle', 'data-i18n-title'],
    ['aria-label', 'i18nAriaLabel', 'data-i18n-aria-label'],
  ]
  for (const [attribute, dataName, selector] of bindings) {
    select('[' + selector + ']').forEach((element) => {
      const value = t(element.dataset[dataName])
      if (value && element.getAttribute(attribute) !== value) element.setAttribute(attribute, value)
    })
  }
  translateMappedUiText(root)
}

function normalizedUiText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function mappedKey(value) {
  return uiSourceMap[normalizedUiText(value)] || ''
}

function loadedTranslation(key) {
  if (!key) return ''
  const [namespace] = key.split(':')
  if (!i18next.hasResourceBundle(getLocale(), namespace) && !i18next.hasResourceBundle('en', namespace)) return ''
  return t(key)
}

function replaceTextPreservingOuterWhitespace(raw, value) {
  const leading = raw.match(/^\s*/)?.[0] || ''
  const trailing = raw.match(/\s*$/)?.[0] || ''
  return leading + value + trailing
}

function translateMappedUiText(root) {
  const translateTextNode = node => {
    const parent = node.parentElement
    if (!parent || parent.closest('script, style, [data-i18n], [data-i18n-skip]')) return
    const key = localizedTextNodes.get(node) || mappedKey(node.nodeValue)
    const value = loadedTranslation(key)
    if (!value) return
    localizedTextNodes.set(node, key)
    const translated = replaceTextPreservingOuterWhitespace(node.nodeValue, value)
    if (node.nodeValue !== translated) node.nodeValue = translated
  }
  if (root.nodeType === Node.TEXT_NODE) translateTextNode(root)
  const walkerRoot = root.nodeType === Node.DOCUMENT_NODE ? root.body : root
  if (walkerRoot) {
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) translateTextNode(node)
  }
  const elements = [
    ...(root.nodeType === Node.ELEMENT_NODE ? [root] : []),
    ...(root.querySelectorAll?.('[title], [placeholder], [aria-label]') || []),
  ]
  for (const element of elements) {
    const remembered = localizedAttributes.get(element) || {}
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      if (!element.hasAttribute(attribute) || element.hasAttribute('data-i18n-' + attribute)) continue
      const key = remembered[attribute] || mappedKey(element.getAttribute(attribute))
      const value = loadedTranslation(key)
      if (!value) continue
      remembered[attribute] = key
      if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value)
    }
    localizedAttributes.set(element, remembered)
  }
}

function observeDynamicTranslations() {
  if (domObserver || typeof MutationObserver === 'undefined' || !document.body) return
  domObserver = new MutationObserver(records => {
    if (translatingMutations) return
    translatingMutations = true
    try {
      for (const record of records) {
        if (record.type === 'attributes') {
          const remembered = localizedAttributes.get(record.target)
          const attribute = record.attributeName
          if (remembered?.[attribute] && record.target.getAttribute(attribute) !== loadedTranslation(remembered[attribute])) {
            const nextKey = mappedKey(record.target.getAttribute(attribute))
            if (nextKey) remembered[attribute] = nextKey
            else delete remembered[attribute]
          }
          translateDocument(record.target)
        }
        for (const node of record.addedNodes) if (node.nodeType === 1 || node.nodeType === 3) translateDocument(node)
      }
    } finally { translatingMutations = false }
  })
  domObserver.observe(document.body, { childList: true, attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'], subtree: true })
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
  // Legacy string details are often Korean. Never leak them into an English UI.
  if (getLocale() === 'ko' && typeof payload?.detail === 'string') return payload.detail
  if (getLocale() === 'ko' && typeof payload?.message === 'string') return payload.message
  return fallback || t('errors:unknown')
}

export function parseApiError(payload, fallback = '') {
  return new Error(errorMessage(payload, fallback))
}

export function formatRelativeTime(value, now = Date.now()) {
  const deltaSeconds = Math.round((new Date(value).getTime() - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' })
  const units = [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60]]
  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds) return formatter.format(Math.round(deltaSeconds / seconds), unit)
  }
  return formatter.format(deltaSeconds, 'second')
}
