import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
}
function setup(mode = 'scroll') {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set()
      elements.set(id, { innerHTML: 'old', textContent: '', classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle: (value, on) => on ? classes.add(value) : classes.delete(value),
      } })
    }
    return elements.get(id)
  }
  const context = vm.createContext({
    state: { sessionId: 'doc', totalPages: 2, currentPage: 1, translatedPages: new Set([1]),
      translatingPages: new Set(), translationCache: { 1: 'old' }, translationSentences: {}, pollingTimer: null },
    mode, $: element, t: key => key, setTimeout, clearTimeout, clearInterval,
    translateDocumentBtn: element('full'), translationScopeBtn: element('scope'),
    resumeTransBtn: element('resume'), cancelTransBtn: element('cancel'),
    getTranslationMode: () => context.mode, getEffectiveTranslationMode: () => context.mode,
    getTranslationPlaceholderHtml: () => context.mode,
    isLongDocument: () => false,
    clearTranslationCacheAPI: async () => {}, updateProgressMiniRaw: () => {},
    startJobPolling: () => {}, getTranslationOptions: () => ({}),
    renderTransContent: () => {}, escapeHtml: value => value,
    streamTranslation: (...args) => { context.callbacks = args; return () => { context.aborted = true } },
  })
  vm.runInContext(section('const visibleTranslationTimers =', '// ── 스크롤 뷰어 초기화'), context)
  vm.runInContext(section('function translatePage(pageNum)', '// ── 코드 블록 외부'), context)
  vm.runInContext(section('async function resetViewerTranslations', "retranslateBtn.addEventListener"), context)
  return { context, element }
}

test('menu and empty panes follow all three modes immediately', () => {
  const { context, element } = setup()
  for (const mode of ['pane', 'auto', 'scroll', 'pane']) {
    context.mode = mode
    context.syncTranslationActions()
    assert.equal(element('full').classList.contains('hidden'), mode !== 'auto')
    assert.equal(element('scope').classList.contains('hidden'), mode !== 'auto')
    assert.equal(element('trans-content-2').innerHTML, mode)
  }
})

test('reset aborts streams and ignores their late completion', async () => {
  const { context } = setup()
  context.translatePage(2)
  const callback = context.callbacks[4]
  assert.equal(await context.resetViewerTranslations('doc'), true)
  assert.equal(context.aborted, true)
  callback(false, [])
  assert.equal(context.state.translatedPages.size, 0)
  assert.deepEqual(Object.keys(context.state.translationCache), [])
})

test('reset failure preserves translations and allows page retry', async () => {
  const { context } = setup()
  context.clearTranslationCacheAPI = async () => { throw new Error('offline') }
  await assert.rejects(context.resetViewerTranslations('doc'), /offline/)
  assert.equal(context.state.translationCache[1], 'old')
  context.translatePage(2)
  assert.ok(context.callbacks)
})

test('scroll resumes current page after reset; pane and auto do not', async () => {
  for (const mode of ['scroll', 'pane', 'auto']) {
    const { context } = setup(mode)
    await context.resetViewerTranslations('doc')
    context.resumeVisibleTranslation()
    assert.equal(Boolean(context.callbacks), mode === 'scroll')
  }
})

test('pending reset blocks new translations and cannot clear a different document', async () => {
  const { context } = setup()
  let resolve
  context.clearTranslationCacheAPI = () => new Promise(done => { resolve = done })
  const pending = context.resetViewerTranslations('doc')
  context.translatePage(2)
  assert.equal(context.callbacks, undefined)
  context.state.sessionId = 'other'
  resolve()
  assert.equal(await pending, false)
  assert.equal(context.state.translationCache[1], 'old')
})

test('long document dwell timer rechecks the latest translation mode', () => {
  const { context } = setup()
  let fireTimer
  context.isLongDocument = () => true
  context.setTimeout = callback => { fireTimer = callback; return 1 }
  context.scheduleVisiblePageTranslation(2)
  context.mode = 'pane'
  fireTimer()
  assert.equal(context.callbacks, undefined)
})

test('poll response received after reset cannot restore old translations', async () => {
  const { context } = setup()
  let respond
  context.getJobStatus = () => new Promise(resolve => { respond = resolve })
  context.setInterval = () => 1
  context.getPageTranslation = () => { throw new Error('stale polling must stop') }
  vm.runInContext(section('function startJobPolling(sessionId)', '// ── 스크롤 동기화'), context)
  context.startJobPolling('doc')
  await context.resetViewerTranslations('doc')
  respond({ completed_pages: [1] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.state.translatedPages.size, 0)
})
