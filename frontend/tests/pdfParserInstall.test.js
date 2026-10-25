import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const modalCode = source.slice(source.indexOf('function openPdfParserInstallModal('), source.indexOf('const parserInstallCancelBtn'))
const cardCode = source.slice(source.indexOf('function updateParserCardInfo('), source.indexOf('function openPdfParserInstallModal('))

function element() {
  const classes = new Set(['hidden'])
  return {
    textContent: '', innerHTML: '',
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
  }
}

test('parser install failure retains logs and notifies after the modal is closed', () => {
  const elements = new Map()
  const $ = id => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  }
  let fail, progress
  const notices = []
  const context = vm.createContext({
    $, openOverlayModal() {},
    escapeHtml: value => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    installPdfParserAPI(_id, onProgress, _onSuccess, onError) { progress = onProgress; fail = onError },
    refreshSystemSettings() { assert.fail('failure must not reset settings and logs') },
    showToast: (...args) => notices.push(args),
  })
  vm.runInContext(modalCode, context)
  context.openPdfParserInstallModal({ id: 'mineru', name: 'MinerU' })
  progress('ERROR: dependency build failed')
  $('pdf-parser-install-modal').classList.add('hidden')
  fail(new Error('missing <wheel>'))
  assert.match($('pdf-parser-inline-log').textContent, /dependency build failed/)
  assert.match($('pdf-parser-inline-status').innerHTML, /missing &lt;wheel&gt;/)
  assert.equal($('pdf-parser-inline-progress').classList.contains('hidden'), false)
  assert.equal($('pdf-parser-install-done-btn').classList.contains('hidden'), false)
  assert.deepEqual(notices, [['[MinerU] 설치 실패: missing <wheel>', 'error']])
})

test('refreshing the parser card preserves existing installation diagnostics', () => {
  const context = vm.createContext({
    $: () => null,
    pdfParsersData: [{ id: 'mineru', name: 'MinerU', installed: false }],
    PARSER_FALLBACK_META: {},
    clearParserInlineProgress() { assert.fail('refresh must preserve logs') },
  })
  vm.runInContext(cardCode, context)
  context.updateParserCardInfo('mineru')
})
