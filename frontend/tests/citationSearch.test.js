import assert from 'node:assert/strict'
import test from 'node:test'

import { buildScholarSearchUrl, buildScholarSearchUrls, extractCitationTitle } from '../src/citationSearch.js'

test('따옴표가 있는 참고문헌에서는 제목만 추출한다', () => {
  assert.equal(extractCitationTitle('[13] A. Author, "A Carefully Quoted Paper Title," Journal of Tests, vol. 2, 2021.'), 'A Carefully Quoted Paper Title')
})

test('et al. 형식에서 저자와 연도를 제외하고 제목을 추출한다', () => {
  assert.equal(extractCitationTitle('Vaswani et al. Attention Is All You Need. 2017.'), 'Attention Is All You Need')
})

test('APA 형식에서 저자, 게재처, DOI를 제외하고 제목을 추출한다', () => {
  assert.equal(extractCitationTitle('Smith, J., Doe, A. (2020). Reliable Widget Detection at Scale. Journal of Widgets, 4(2), 10-20. https://doi.org/10.1234/widgets'), 'Reliable Widget Detection at Scale')
})

test('다중 참고문헌은 제목별 독립 Scholar 검색 URL을 만든다', () => {
  const urls = buildScholarSearchUrls([
    'Vaswani et al. Attention Is All You Need. 2017.',
    'He et al. Deep Residual Learning for Image Recognition. In CVPR, 2016.',
    'A. Author, "A Carefully Quoted Paper Title," Journal of Tests, 2021.',
  ]).map(value => new URL(value).searchParams.get('q'))

  assert.deepEqual(urls, [
    '"Attention Is All You Need"',
    '"Deep Residual Learning for Image Recognition"',
    '"A Carefully Quoted Paper Title"',
  ])
  assert.ok(urls.every(query => !query.includes(' OR ')))
})

test('단일 Scholar 검색은 기존처럼 제목 하나만 검색한다', () => {
  const url = new URL(buildScholarSearchUrl(
    'Vaswani et al. Attention Is All You Need. 2017.',
  ))
  assert.equal(url.searchParams.get('q'), '"Attention Is All You Need"')
})
