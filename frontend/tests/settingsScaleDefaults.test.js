import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8')

function selectedValue(selectId) {
  const select = indexHtml.match(new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`))
  assert.ok(select, `${selectId} select가 있어야 한다`)

  const selected = select[1].match(/<option value="([^"]+)" selected>/)
  assert.ok(selected, `${selectId}에 명시적인 기본 선택값이 있어야 한다`)
  return selected[1]
}

test('배율 드롭다운의 초기 표시값은 실제 애플리케이션 기본값과 일치한다', () => {
  assert.equal(selectedValue('setting-ui-scale'), '1')
  assert.equal(selectedValue('setting-default-zoom'), '1.5')
})
