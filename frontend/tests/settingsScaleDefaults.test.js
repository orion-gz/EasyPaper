import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8')

function selectMarkup(selectId) {
  const select = indexHtml.match(new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`))
  assert.ok(select, `${selectId} select가 있어야 한다`)
  return select[1]
}

test('배율 드롭다운은 HTML 선택값으로 고정하지 않는다', () => {
  assert.doesNotMatch(selectMarkup('setting-ui-scale'), /<option[^>]+selected>/)
  assert.doesNotMatch(selectMarkup('setting-default-zoom'), /<option[^>]+selected>/)
})
