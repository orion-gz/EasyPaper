import test from 'node:test'
import assert from 'node:assert/strict'
import { exactSentenceOffsets } from '../src/easyEnglishMatching.js'
import { getModeSetting } from '../src/modeSettings.js'

test('repeated source sentences retain distinct exact offsets', () => {
  const text = 'It worked.\nIt worked.'
  const groups = [{ source_text: 'It worked.' }, { source_text: 'It worked.' }]
  assert.deepEqual(exactSentenceOffsets(text, groups), [{ start: 0, end: 10 }, { start: 11, end: 21 }])
})

test('whitespace differences match, missing source never receives an approximate match', () => {
  assert.deepEqual(exactSentenceOffsets('Some\n text. Other text.', [{ source_text: 'Some text.' }, { source_text: 'Missing text.' }]), [{ start: 0, end: 11 }, null])
})

test('Easy English defaults to manual independently in both document modes', () => {
  const values = new Map([['easypaper_translation_mode', 'auto']])
  const storage = { getItem: key => values.get(key) ?? null }
  assert.equal(getModeSetting('easyEnglishMode', 'research', storage), 'manual')
  assert.equal(getModeSetting('easyEnglishMode', 'general', storage), 'manual')
  values.set('easypaper_easy_english_mode_research', 'auto')
  assert.equal(getModeSetting('easyEnglishMode', 'research', storage), 'auto')
  assert.equal(getModeSetting('easyEnglishMode', 'general', storage), 'manual')
  values.set('easypaper_easy_english_mode_research', 'invalid')
  assert.equal(getModeSetting('easyEnglishMode', 'research', storage), 'manual')
})

test('source highlights clip partial rectangles and omit fully hidden rectangles', async () => {
  const { clipSourceRect } = await import('../src/easyEnglishMatching.js')
  const bounds = { left: 100, top: 200, right: 300, bottom: 280 }
  assert.deepEqual(clipSourceRect({ left: 90, top: 190, width: 40, height: 30 }, bounds),
    { left: 100, top: 200, width: 30, height: 20 })
  assert.equal(clipSourceRect({ left: 110, top: 50, width: 100, height: 19 }, bounds), null)
  assert.equal(clipSourceRect({ left: 310, top: 210, width: 100, height: 19 }, bounds), null)
})


test('PDF ligatures and line hyphenation retain original character offsets', () => {
  const text = 'The eﬀect is signi-\nficant. It worked.'
  assert.deepEqual(exactSentenceOffsets(text, [
    { source_text: 'The effect is significant.' }, { source_text: 'It worked.' },
  ]), [{ start: 0, end: 27 }, { start: 28, end: 38 }])
})

test('punctuation differences never map an unrelated source sentence', () => {
  assert.deepEqual(exactSentenceOffsets('It costs -5. It costs 5.', [
    { source_text: 'It costs 5.' },
  ]), [{ start: 13, end: 24 }])
})


test('PDF content order can differ from source sentence order', () => {
  assert.deepEqual(exactSentenceOffsets('Second sentence. First sentence.', [
    { source_text: 'First sentence.' }, { source_text: 'Second sentence.' },
  ]), [{ start: 17, end: 32 }, { start: 0, end: 16 }])
})

test('out-of-order matching never reuses an already matched occurrence', () => {
  assert.deepEqual(exactSentenceOffsets('Repeated. Last. Repeated.', [
    { source_text: 'Last.' }, { source_text: 'Repeated.' },
    { source_text: 'Repeated.' }, { source_text: 'Repeated.' },
  ]), [{ start: 10, end: 15 }, { start: 16, end: 25 }, { start: 0, end: 9 }, null])
})
