import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Exercise the viewer's parser without initializing its DOM and PDF runtime.
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const context = vm.createContext({})
vm.runInContext(source.slice(source.indexOf('const ROMAN_NUMERAL_SRC'), source.indexOf('function renderFigureRefOverlayLayer')), context)
function references(text) {
  context.text = text
  return JSON.parse(vm.runInContext(`JSON.stringify(Array.from(text.matchAll(FIGURE_TABLE_REF_RE), match => ({
    text: match[0], labels: parseFigureTableNumberList(match[2]).map(n => normalizeFigureTableKind(match[1]) + ' ' + n)
  })))`, context))
}

test('chapter-qualified references select the exact image and full text', () => {
  assert.deepEqual(references('See Figure 4.18 and Figure 4.1.'), [
    { text: 'Figure 4.18', labels: ['Figure 4.18'] },
    { text: 'Figure 4.1', labels: ['Figure 4.1'] },
  ])
  assert.deepEqual(references('Fig. 4.18(a,b), Table 12.3.10'), [
    { text: 'Fig. 4.18(a,b)', labels: ['Figure 4.18'] },
    { text: 'Table 12.3.10', labels: ['Table 12.3.10'] },
  ])
  assert.deepEqual(references('Figure 4.18th'), [])
})

test('chapter ranges preserve the prefix and do not expand across chapters', () => {
  assert.deepEqual(references('Figures 4.18–4.20')[0].labels, ['Figure 4.18', 'Figure 4.19', 'Figure 4.20'])
  assert.deepEqual(references('Figures 4.18–5.2')[0].labels, ['Figure 4.18', 'Figure 5.2'])
})

test('integer, roman and subfigure references retain existing behavior', () => {
  assert.deepEqual(references('Figs. 3-5')[0].labels, ['Figure 3', 'Figure 4', 'Figure 5'])
  assert.deepEqual(references('Tables I and V')[0].labels, ['Table I', 'Table V'])
  assert.deepEqual(references('Fig. 6a,c')[0].labels, ['Figure 6'])
})
