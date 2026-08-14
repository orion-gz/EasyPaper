import assert from 'node:assert/strict'
import test from 'node:test'

import { buildScholarSearchUrl, extractCitationTitle } from '../src/citationSearch.js'

test('따옴표가 있는 참고문헌에서는 제목만 추출한다', () => {
  assert.equal(extractCitationTitle('[13] A. Author, "A Carefully Quoted Paper Title," Journal of Tests, vol. 2, 2021.'), 'A Carefully Quoted Paper Title')
})

test('et al. 형식에서 저자와 연도를 제외하고 제목을 추출한다', () => {
  assert.equal(extractCitationTitle('Vaswani et al. Attention Is All You Need. 2017.'), 'Attention Is All You Need')
})

test('APA 형식에서 저자, 게재처, DOI를 제외하고 제목을 추출한다', () => {
  assert.equal(extractCitationTitle('Smith, J., Doe, A. (2020). Reliable Widget Detection at Scale. Journal of Widgets, 4(2), 10-20. https://doi.org/10.1234/widgets'), 'Reliable Widget Detection at Scale')
})

test('다중 참고문헌은 정제한 제목을 따옴표와 OR 연산자로 조합한다', () => {
  const url = new URL(buildScholarSearchUrl([
    'Vaswani et al. Attention Is All You Need. 2017.',
    'He et al. Deep Residual Learning for Image Recognition. In CVPR, 2016.',
    'A. Author, "A Carefully Quoted Paper Title," Journal of Tests, 2021.',
  ]))
  assert.equal(url.searchParams.get('q'), '"Attention Is All You Need" OR "Deep Residual Learning for Image Recognition" OR "A Carefully Quoted Paper Title"')
})
