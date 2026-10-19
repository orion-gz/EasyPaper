import test from 'node:test'
import assert from 'node:assert/strict'
import { createReferenceAnalysisController } from '../src/referenceAnalysis.js'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const context = { docId: 'one', targetLang: 'ko' }

function setup(overrides = {}) {
  let items
  const calls = []
  const controller = createReferenceAnalysisController({
    fetchResult: async () => ({ status: 'not_analyzed' }),
    analyze: async (...args) => { calls.push(args); return { status: 'complete', score: 75 } },
    onChange: result => { items = result }, delay: 5, ...overrides,
  })
  return { controller, calls, items: () => items }
}

test('manual default only reads cache; explicit request and regeneration use same path', async () => {
  const state = setup()
  state.controller.open(context, [{ key: '1' }], false)
  await flush()
  assert.equal(state.calls.length, 0)
  await state.controller.run('1')
  assert.equal(state.calls.length, 1)
  assert.equal(state.calls[0][2], false)
  await state.controller.run('1')
  assert.equal(state.calls[1][2], true)
  state.controller.close()
})

test('automatic mode reuses cache and analyzes uncached cards sequentially', async () => {
  const gate = pending()
  const calls = []
  const state = setup({
    fetchResult: async (_, key) => key === '1' ? { status: 'complete', score: 30 } : { status: 'not_analyzed' },
    analyze: async (_, key) => { calls.push(key); if (key === '2') await gate.promise; return { status: 'complete' } },
  })
  state.controller.open(context, [{ key: '1' }, { key: '2' }, { key: '3' }], true)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(calls, ['2'])
  gate.resolve()
  await flush()
  assert.deepEqual(calls, ['2', '3'])
  state.controller.close()
})

test('closing before dwell cancels automatic work', async () => {
  const state = setup()
  state.controller.open(context, [{ key: '1' }], true)
  state.controller.close()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(state.calls.length, 0)
})

test('closing during analysis stops queued cards and stale result cannot replace new overlay', async () => {
  const gate = pending()
  const calls = []
  const state = setup({ analyze: async (ctx, key) => { calls.push(key); await gate.promise; return { status: 'complete' } } })
  state.controller.open(context, [{ key: '1' }, { key: '2' }], true)
  await new Promise(resolve => setTimeout(resolve, 15))
  state.controller.open({ docId: 'two', targetLang: 'en' }, [{ key: '3' }], false)
  await flush()
  gate.resolve()
  await flush()
  assert.deepEqual(calls, ['1'])
  assert.equal(state.items()[0].key, '3')
  assert.equal(state.items()[0].state, 'not_analyzed')
  state.controller.close()
})

test('partial failure does not block later cards and supports retry', async () => {
  let fail = true
  const state = setup({ analyze: async (_, key) => {
    if (key === '1' && fail) throw new Error('provider failed')
    return { status: 'complete' }
  } })
  state.controller.open(context, [{ key: '1' }, { key: '2' }], true)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(state.items().map(item => item.state), ['error', 'complete'])
  fail = false
  await state.controller.run('1')
  assert.equal(state.items()[0].state, 'complete')
  state.controller.close()
})

test('slow cache lookup cannot strand an earlier card in auto mode', async () => {
  const cache = pending(), analysis = pending()
  const calls = []
  const state = setup({
    fetchResult: async (_, key) => key === '1' ? cache.promise : { status: 'not_analyzed' },
    analyze: async (_, key) => { calls.push(key); if (key === '2') await analysis.promise; return { status: 'complete' } },
  })
  state.controller.open(context, [{ key: '1' }, { key: '2' }], true)
  await new Promise(resolve => setTimeout(resolve, 15))
  cache.resolve({ status: 'not_analyzed' })
  await flush()
  analysis.resolve()
  await flush()
  assert.deepEqual(calls, ['2', '1'])
  state.controller.close()
})
