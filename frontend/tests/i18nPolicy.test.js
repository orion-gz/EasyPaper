import test from 'node:test'
import assert from 'node:assert/strict'
import { browserLocale, normalizeLocale, formatNumber, formatDate, errorMessage, parseApiError } from '../src/i18n.js'

test('navigator.languages maps any ko locale to ko and everything else to en', () => {
  Object.defineProperty(globalThis, 'navigator', { value: { languages: ['fr-FR', 'ko-KR'] }, configurable: true }); assert.equal(browserLocale(), 'ko')
  Object.defineProperty(globalThis, 'navigator', { value: { languages: ['ja-JP', 'en-US'] }, configurable: true }); assert.equal(browserLocale(), 'en')
})
test('unsupported UI locale safely normalizes to English', () => { assert.equal(normalizeLocale('ko'), 'ko'); assert.equal(normalizeLocale('ar'), 'en') })
test('Intl number and date helpers return localized values', () => { assert.equal(formatNumber(1234), '1,234'); assert.match(formatDate('2026-08-24T00:00:00Z', { year: 'numeric' }), /2026/) })


test('structured and SSE errors preserve safe fallback metadata', () => {
  const payload = { code: 'generation_failed', params: {}, fallback: 'Generation failed safely.' }
  assert.equal(errorMessage(payload), 'Generation failed safely.')
  assert.equal(errorMessage({ error: payload }.error), 'Generation failed safely.')
})

test('legacy localized API detail is not leaked into an English UI', () => {
  assert.equal(errorMessage({ detail: '한국어 서버 오류' }, 'Safe generic error.'), 'Safe generic error.')
  assert.equal(parseApiError({ detail: '한국어 서버 오류' }, 'Safe generic error.').message, 'Safe generic error.')
})
