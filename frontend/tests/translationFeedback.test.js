import test from 'node:test'
import assert from 'node:assert/strict'
import { streamTranslation } from '../src/api.js'
import { translationError } from '../src/translationFeedback.js'

test('translation errors display and retain their diagnostic code', () => {
  const error = translationError({ code: 'translation_integrity_failed', fallback: 'Missing source values.' })
  assert.equal(error.code, 'translation_integrity_failed')
  assert.equal(error.message, 'Missing source values. [translation_integrity_failed]')
})

function mockStream(events) {
  global.fetch = async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
    controller.close()
  } }) })
}

test('translation SSE reports a coded failure after receiving text without completing', async () => {
  const original = global.fetch
  try {
    mockStream([{ content: 'partial' }, { error: { code: 'cli_execution_failed', fallback: 'CLI failed.' }, done: true }])
    const tokens = []
    const error = await new Promise((resolve, reject) => {
      streamTranslation('doc', 1, {}, token => tokens.push(token), () => reject(new Error('must not succeed')), resolve)
    })
    assert.deepEqual(tokens, ['partial'])
    assert.equal(error.code, 'cli_execution_failed')
    assert.match(error.message, /\[cli_execution_failed\]/)
  } finally { global.fetch = original }
})

test('translation SSE forwards nonfatal integrity warnings on completion', async () => {
  const original = global.fetch
  const warnings = [{ code: 'translation_integrity_warning', params: { missing: '512' } }]
  try {
    mockStream([{ content: 'translation' }, { done: true, sentences: [], warnings }])
    const result = await new Promise((resolve, reject) => {
      streamTranslation('doc', 1, {}, () => {}, (...args) => resolve(args), reject)
    })
    assert.deepEqual(result, [false, [], warnings])
  } finally { global.fetch = original }
})
