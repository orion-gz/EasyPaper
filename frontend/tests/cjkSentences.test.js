import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('function splitIntoSentences('), source.indexOf('// ── 오버레이 기반 문장 호버/클릭 이벤트 시스템'))
const split = vm.runInNewContext(`${code}; splitIntoSentences`)

for (const [text, expected] of [
  ['最初です。次です。最後です。', ['最初です。', '次です。', '最後です。']],
  ['本当！？はい。', ['本当！？', 'はい。']],
  ['「最初です。」次です。', ['「最初です。」', '次です。']],
  ['第一句。第二句！第三句？', ['第一句。', '第二句！', '第三句？']],
  ['最初です。\n 次です。', ['最初です。', '次です。']],
  ['Version 3.0 is ready. Next sentence.', ['Version 3.0 is ready.', 'Next sentence.']],
  ['Dr. Smith works here. Next sentence.', ['Dr. Smith works here.', 'Next sentence.']],
]) {
  test(`sentence boundaries preserve offsets: ${text}`, () => {
    const ranges = Array.from(split(text))
    assert.deepEqual(ranges.map(r => r.text.trim()), expected)
    for (const r of ranges) assert.equal(text.slice(r.start, r.end), r.text)
  })
}
