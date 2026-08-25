import test from 'node:test'
import assert from 'node:assert/strict'

import { streamChatAPI, streamInstallOllamaAPI } from '../src/api.js'

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


test("document chat parses named SSE events across chunk boundaries", async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    const chunks = [
      "event: context\ndata: {\"page_num\":2,\"visual_included\":false}\n\nevent: ans",
      "wer\ndata: {\"delta\":\"Grounded \"}\n\nevent: answer\ndata: {\"delta\":\"answer [p.2]\"}\n\n",
      "event: evidence\ndata: {\"items\":[{\"evidence_id\":\"ev_1\",\"page_num\":2}]}\n\nevent: verification\ndata: {\"status\":\"verified_structure\"}\n\nevent: done\ndata: {\"answer_message_id\":7}\n\n",
    ]
    const body = new ReadableStream({
      start(controller) {
        chunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk)))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }

  const tokens = []
  const events = []
  await new Promise((resolve, reject) => {
    streamChatAPI("doc", [{ role: "user", content: "question" }],
      token => tokens.push(token), resolve, reject, null,
      { screenContext: { mode: "viewer", page_num: 2, include_visual: null } },
      (name, payload) => events.push([name, payload]))
  })

  assert.deepEqual(tokens, ["Grounded ", "answer [p.2]"])
  assert.deepEqual(events.map(item => item[0]), ["context", "answer", "answer", "evidence", "verification", "done"])
  const body = JSON.parse(requests[0].options.body)
  assert.deepEqual(body.screen_context, { mode: "viewer", page_num: 2, include_visual: null })
})


test('standalone document chat sends no viewer page or visual context', async () => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  await new Promise((resolve, reject) => {
    streamChatAPI('doc', [{ role: 'user', content: 'question' }],
      () => {}, resolve, reject, null,
      { screenContext: { mode: 'standalone', include_visual: false } })
  })
  const body = JSON.parse(requests[0].options.body)
  assert.deepEqual(body.screen_context, { mode: 'standalone', include_visual: false })
  assert.equal(body.current_page, undefined)
  assert.equal(body.selected_text, undefined)
})
