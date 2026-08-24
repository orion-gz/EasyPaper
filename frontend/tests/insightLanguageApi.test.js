import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateInsightJobAPI, startInsightJobAPI, streamPageInsightAPI } from '../src/api.js'

test('insight APIs use the explicit document source language', async () => {
  const requests = []
  global.fetch = async (url, options = {}) => { requests.push([String(url), options]); return { ok: true, json: async () => ({}), body: { getReader: () => ({ read: async () => ({ done: true }) }) } } }
  await estimateInsightJobAPI('doc', 'summary', 'fr', 'ja')
  await startInsightJobAPI('doc', 'summary', 'fr', 'ja', true)
  streamPageInsightAPI('doc', 2, 'summary', 'fr', 'ja', false, () => {}, () => {}, () => {})
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.match(requests[0][0], /target_lang=fr&source_lang=ja/)
  assert.deepEqual(JSON.parse(requests[1][1].body), { target_lang: 'fr', source_lang: 'ja', confirmed: true })
  assert.match(requests[2][0], /source_lang=ja/)
})
