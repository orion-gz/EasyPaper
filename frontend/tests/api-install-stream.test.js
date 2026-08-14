import test from 'node:test'
import assert from 'node:assert/strict'

import { streamInstallOllamaAPI } from '../src/api.js'

test('CLI install stream uses POST and parses SSE events', async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"status":"progress","line":"installing"}\n\n' +
          'data: {"status":"success"}\n\n'
        ))
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }

  const progress = []
  await new Promise((resolve, reject) => {
    streamInstallOllamaAPI(data => progress.push(data.line), resolve, reject)
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/settings/install-ollama')
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(progress, ['installing'])
})
