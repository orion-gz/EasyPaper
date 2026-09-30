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

for (const [text, labels] of [
  ['FIGURE 4.18', ['Figure 4.18']],
  ['fig.\u00a04.18', ['Figure 4.18']],
  ['Figs. 2 and 3', ['Figure 2', 'Figure 3']],
  ['Figures 2, 3 & 4', ['Figure 2', 'Figure 3', 'Figure 4']],
  ['Fig. S1', ['Figure S1']],
  ['Fig. s1a', ['Figure S1']],
  ['Figures A.1,A.2', ['Figure A.1', 'Figure A.2']],
  ['Figs. S1–S3', ['Figure S1', 'Figure S2', 'Figure S3']],
  ['Figs. A.1—A.3', ['Figure A.1', 'Figure A.2', 'Figure A.3']],
  ['Figs. A1-B3', ['Figure A1', 'Figure B3']],
  ['Fig. 2(a—c)', ['Figure 2']],
  ['Fig. 2 (a)', ['Figure 2']],
  ['fig. iv', ['Figure IV']],
  ['Tab. A.2', ['Table A.2']],
]) {
  test(`figure spelling: ${text}`, () => {
    assert.deepEqual(references(text), [{ text, labels }])
  })
}

for (const text of ['Figure IVX', 'Figure Introduction', 'Figure 2nd', 'Figure 4.18th', 'Tablet A.1', 'Fig. S1st']) {
  test(`does not link a partial identifier: ${text}`, () => assert.deepEqual(references(text), []))
}
