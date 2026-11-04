import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/pdfCompatibility.js', import.meta.url), 'utf8')

test('missing withResolvers supports resolution, rejection and subclasses', async () => {
  const context = vm.createContext({})
  vm.runInContext('delete Promise.withResolvers', context)
  vm.runInContext(source, context)
  const result = vm.runInContext(`(() => {
    class CustomPromise extends Promise {}
    const fulfilled = CustomPromise.withResolvers()
    const rejected = Promise.withResolvers()
    const rejection = rejected.promise.catch(error => error)
    fulfilled.resolve(42)
    rejected.reject('expected')
    return { fulfilled: fulfilled.promise, rejection,
      subclass: fulfilled.promise instanceof CustomPromise,
      enumerable: Object.getOwnPropertyDescriptor(Promise, 'withResolvers').enumerable }
  })()`, context)
  assert.equal(await result.fulfilled, 42)
  assert.equal(await result.rejection, 'expected')
  assert.equal(result.subclass, true)
  assert.equal(result.enumerable, false)
})

test('existing withResolvers is preserved', () => {
  const context = vm.createContext({})
  vm.runInContext('globalThis.original = Promise.withResolvers = function sentinel() {}', context)
  vm.runInContext(source, context)
  assert.equal(vm.runInContext('Promise.withResolvers === original', context), true)
})
