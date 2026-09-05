import test from 'node:test'
import assert from 'node:assert/strict'

import { importURL, uploadPDF } from '../src/api.js'

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
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const originalCrypto = globalThis.crypto
  const uploadId = '123e4567-e89b-42d3-a456-426614174000'
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => uploadId } })
  globalThis.setTimeout = handler => { handler(); return 0 }
  globalThis.fetch = async url => {
    assert.equal(url, `/api/upload/${uploadId}/status`)
    return new Response(JSON.stringify({ status: "succeeded", result: { session_id: uploadId, filename: "one.pdf", total_pages: 1, metadata: {} } }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  globalThis.XMLHttpRequest = MockXHR
  MockXHR.instances = []
  try {
    const phases = []
    const promise = uploadPDF(new Blob(['pdf']), options, (percent, phase) => phases.push([percent, phase]))
    const xhr = MockXHR.instances[0]
    assert.equal(xhr.method, 'POST')
    assert.match(xhr.url, new RegExp(`upload_id=${uploadId}`))
    assert.match(xhr.url, /classification_method=manual/)
    xhr.uploadHandler[1]({ lengthComputable: true, loaded: 1, total: 2 })
    xhr.status = 202
    xhr.responseText = JSON.stringify({ session_id: uploadId, task_id: "parse-task", status: "queued" })
    xhr.emit('load')
    assert.equal((await promise).session_id, uploadId)
    assert.deepEqual(phases, [[50, 'uploading'], [100, 'processing']])
  } finally {
    globalThis.XMLHttpRequest = originalXHR
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
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
    assert.equal(url, `/api/upload/${uploadId}/status`)
    return new Response(JSON.stringify({ status: "succeeded", result: {
      session_id: uploadId, filename: "recovered.pdf", total_pages: 3, metadata: {},
      document_mode: "research", document_type: "research_paper",
    } }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  MockXHR.instances = []
  try {
    const phases = []
    const promise = uploadPDF(new Blob(['pdf']), options, (percent, phase) => phases.push([percent, phase]))
    await MockXHR.instances[0].emit('error')
    const result = await promise
    assert.equal(result.session_id, uploadId)
    assert.equal(result.filename, 'recovered.pdf')
    assert.deepEqual(phases, [[100, "processing"]])
  } finally {
    globalThis.XMLHttpRequest = originalXHR
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto })
  }
})

test('malformed success response rejects instead of leaving upload pending', async () => {
  const originalXHR = globalThis.XMLHttpRequest
  globalThis.XMLHttpRequest = MockXHR
  MockXHR.instances = []
  try {
    const promise = uploadPDF(new Blob(['pdf']), options)
    const xhr = MockXHR.instances[0]
    xhr.status = 202
    xhr.responseText = '{invalid json'
    xhr.emit('load')
    await assert.rejects(promise)
  } finally {
    globalThis.XMLHttpRequest = originalXHR
  }
})

test('URL import sends a recoverable id and restores a completed session after disconnect', async () => {
  const originalCrypto = globalThis.crypto
  const originalFetch = globalThis.fetch
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalSetTimeout = globalThis.setTimeout
  const uploadId = "123e4567-e89b-42d3-a456-426614174002"
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => uploadId } })
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}
  globalThis.setTimeout = handler => { handler(); return 0 }
  let requestCount = 0
  globalThis.fetch = async (url, init) => {
    requestCount++
    if (requestCount === 1) {
      assert.equal(url, "/api/import-url")
      assert.equal(JSON.parse(init.body).upload_id, uploadId)
      assert.equal(JSON.parse(init.body).classification_method, "manual")
      throw new TypeError("connection closed")
    }
    assert.equal(url, `/api/session/${uploadId}`)
    return new Response(JSON.stringify({ session_id: uploadId, filename: "remote.pdf", total_pages: 30, metadata: {} }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const phases = []
    const result = await importURL("https://arxiv.org/pdf/1611.08024", options, (percent, phase) => phases.push([percent, phase]))
    assert.equal(result.session_id, uploadId)
    assert.deepEqual(phases, [[10, "checking"], [30, "downloading"], [90, "verifying"]])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    globalThis.setTimeout = originalSetTimeout
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto })
  }
})
