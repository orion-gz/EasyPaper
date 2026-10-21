import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCommandQuery, commandArgumentError, formatDocumentCitation } from '../src/commandArguments.js'

test('slash parsing preserves argument spaces and separates a document search from the open command', () => {
  assert.equal(parseCommandQuery('ordinary document query'), null)
  assert.equal(parseCommandQuery('>settings'), null)
  assert.deepEqual(parseCommandQuery('/open '), { name: 'open', argument: '', hasArgument: true })
  assert.deepEqual(parseCommandQuery(' /ASK What does this mean? '), { name: 'ask', argument: 'What does this mean?', hasArgument: true })
  assert.deepEqual(parseCommandQuery('/모델'), { name: '모델', argument: '', hasArgument: false })
})
test('page and zoom arguments reject invalid numbers, out-of-range values and extra text', () => {
  for (const value of ['', '0', '-1', '1.5', '1e2', 'NaN', 'Infinity', '2abc', '4', '2 3']) assert.equal(commandArgumentError('page', value, 3), true, value)
  for (const value of ['1', '2', '3']) assert.equal(commandArgumentError('page', value, 3), false, value)
  for (const value of ['', '49', '301', '100abc', 'Infinity', '-1', '1e2']) assert.equal(commandArgumentError('zoom', value), true, value)
  for (const value of ['50', '150', '300%', '125.5']) assert.equal(commandArgumentError('zoom', value), false, value)
  assert.equal(commandArgumentError('theme', 'DARK'), false)
  assert.equal(commandArgumentError('theme', 'invalid'), true)
})
test('citation formats available metadata without fabricating absent authors or dates', () => {
  assert.equal(formatDocumentCitation({ filename: 'Sample.pdf' }), 'Sample.pdf')
  assert.equal(formatDocumentCitation({ metadata: { title: 'A Study', authors: ['Alice', { name: 'Bob' }], year: 2025, bibliography: { doi: 'https://doi.org/10.1/test', venue: 'Journal' } } }), 'Alice, Bob. (2025). A Study. Journal. https://doi.org/10.1/test')
})
