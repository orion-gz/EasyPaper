import test from 'node:test'
import assert from 'node:assert/strict'

import { uploadPDF } from '../src/api.js'

const options = {
  targetLang: 'ko', sourceLang: 'auto', style: 'academic',
  ignoreMath: false, ignoreTable: true, ignoreRefs: false,
  translationMode: 'auto', keywordMode: 'manual', summaryMode: 'manual',
  documentMode: 'research', documentType: 'research_paper',
}

class MockXHR {
  static instances = []
  constructor() {
    this.listeners = new Map()
    this.upload = { addEventListener: (name, handler) => this.uploadHandler = [name, handler] }
    MockXHR.instances.push(this)
  }
  open(method, url) { this.method = method; this.url = url }
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  send(body) { this.body = body }
  emit(name) { return this.listeners.get(name)?.() }
}

test('upload sends a client-known id and reports progress phases', async () => {
  const originalXHR = globalThis.XMLHttpRequest
  const originalCrypto = globalThis.crypto
  const uploadId = '123e4567-e89b-42d3-a456-426614174000'
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => uploadId } })
  globalThis.XMLHttpRequest = MockXHR
  MockXHR.instances = []
  try {
    const phases = []
    const promise = uploadPDF(new Blob(['pdf']), options, (percent, phase) => phases.push([percent, phase]))
    const xhr = MockXHR.instances[0]
    assert.equal(xhr.method, 'POST')
    assert.match(xhr.url, new RegExp(`upload_id=${uploadId}`))
    xhr.uploadHandler[1]({ lengthComputable: true, loaded: 1, total: 2 })
    xhr.status = 200
    xhr.responseText = JSON.stringify({ session_id: uploadId, filename: 'one.pdf', total_pages: 1, metadata: {} })
    xhr.emit('load')
    assert.equal((await promise).session_id, uploadId)
    assert.deepEqual(phases, [[50, 'uploading'], [100, 'processing']])
  } finally {
    globalThis.XMLHttpRequest = originalXHR
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto })
  }
})

test('connection loss recovers a completed server upload by id', async () => {
  const originalXHR = globalThis.XMLHttpRequest
  const originalCrypto = globalThis.crypto
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const uploadId = '123e4567-e89b-42d3-a456-426614174001'
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => uploadId } })
  globalThis.XMLHttpRequest = MockXHR
  globalThis.setTimeout = handler => { handler(); return 0 }
  globalThis.fetch = async url => {
    assert.equal(url, `/api/session/${uploadId}`)
    return new Response(JSON.stringify({
      session_id: uploadId, filename: 'recovered.pdf', total_pages: 3, metadata: {},
      document_mode: 'research', document_type: 'research_paper',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  MockXHR.instances = []
  try {
    const phases = []
    const promise = uploadPDF(new Blob(['pdf']), options, (percent, phase) => phases.push([percent, phase]))
    await MockXHR.instances[0].emit('error')
    const result = await promise
    assert.equal(result.session_id, uploadId)
    assert.equal(result.filename, 'recovered.pdf')
    assert.deepEqual(phases, [[100, 'verifying']])
  } finally {
    globalThis.XMLHttpRequest = originalXHR
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto })
  }
})
