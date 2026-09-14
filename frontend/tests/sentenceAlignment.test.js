import assert from 'node:assert/strict'
import test from 'node:test'

import { alignSentencesToText } from '../src/sentenceAlignment.js'

test('단일 비순차 캡션: 본문보다 앞쪽에 있는 캡션이 충돌로 잘려나가지 않고 온전히 보존된다 (리뷰어 재현 사례)', () => {
  const caption = 'Figure 1. Distribution of measured samples.'
  const body = 'The experimental results support our proposed method.'
  const fullText = `${caption} ${body}`

  const res = alignSentencesToText(fullText, [body, caption])

  assert.equal(res.length, 2)
  // 1. 본문 범위 검증 (인덱스 0 유지)
  assert.equal(res[0].start, fullText.indexOf('The'))
  assert.ok(res[0].end > res[0].start + 45, '본문 하이라이트 범위가 4글자로 축소되지 않아야 함')

  // 2. 캡션 범위 검증 (인덱스 1 유지)
  assert.equal(res[1].start, 0)
  assert.ok(res[1].end > res[1].start + 35, '캡션 하이라이트 범위가 소멸되지 않아야 함')

  // 3. 두 범위가 서로 겹치지 않음
  assert.ok(res[1].end <= res[0].start)
})

test('여러 비순차 캡션: 여러 개의 표 및 그림 캡션이 본문 사이에 산재해도 각자 올바른 위치에 매핑된다', () => {
  const cap1 = 'Figure 1. First diagram description overview.'
  const body1 = 'We introduce the core architectural components of our proposed network.'
  const cap2 = 'Table 1. Experimental performance evaluation metrics across models.'
  const body2 = 'In addition, extensive empirical evaluations demonstrate consistent gains.'
  const fullText = `${cap1} ${body1} ${cap2} ${body2}`

  // 번역 문장 목록은 본문 블록들이 먼저 오고 캡션들이 뒤에 오는 구조
  const sentencesList = [body1, body2, cap1, cap2]
  const res = alignSentencesToText(fullText, sentencesList)

  assert.equal(res.length, 4)

  // 원래 배열 순서와 1:1 매핑 유지
  assert.equal(res[0].start, fullText.indexOf('We introduce'))
  assert.equal(res[1].start, fullText.indexOf('In addition'))
  assert.equal(res[2].start, fullText.indexOf('Figure 1'))
  assert.equal(res[3].start, fullText.indexOf('Table 1'))

  // 각 문장이 유효한 길이를 유지
  for (let i = 0; i < res.length; i++) {
    assert.ok(res[i].end > res[i].start)
  }
})

test('매칭 실패 문장이 섞인 경우: 수식 기호 등으로 매칭에 실패한 문장의 보간이 기존 매칭 영역을 침범하지 않는다', () => {
  const s1 = 'First introductory sentence with sufficient length for testing.'
  const unmatchable = '∑ ∫ ∇ λ ± ∭ ∮' // 원문 텍스트에 없는 기호 문장
  const s2 = 'Final concluding sentence confirming the experimental observations.'
  const fullText = `${s1}   ${s2}`

  const res = alignSentencesToText(fullText, [s1, unmatchable, s2])

  assert.equal(res.length, 3)

  // s1과 s2의 정확 매칭 영역은 손상되지 않아야 함
  assert.equal(res[0].start, 0)
  assert.ok(res[0].end >= s1.length - 2)

  const s2Start = fullText.indexOf('Final')
  assert.equal(res[2].start, s2Start)

  // unmatchable 문장의 보간이 s1이나 s2의 매칭 범위를 침범하지 않아야 함
  if (res[1].end > res[1].start) {
    assert.ok(res[1].start >= res[0].end)
    assert.ok(res[1].end <= res[2].start)
  }
})

test('기존 순차 본문 매핑: 순차적으로 이어지는 일반 문장들이 올바르게 시작/끝 범위를 배정받는다', () => {
  const s1 = 'This is the first sentence of the paper.'
  const s2 = 'This is the second sentence following the first.'
  const s3 = 'Finally, this is the third sentence of the paragraph.'
  const fullText = `${s1} ${s2} ${s3}`

  const res = alignSentencesToText(fullText, [s1, s2, s3])

  assert.equal(res.length, 3)
  assert.equal(res[0].start, fullText.indexOf(s1))
  assert.equal(res[1].start, fullText.indexOf(s2))
  assert.equal(res[2].start, fullText.indexOf(s3))

  assert.ok(res[0].end <= res[1].start)
  assert.ok(res[1].end <= res[2].start)
})

test('수식 정렬: 표준 수학 연산자(\\log, \\exp 등)와 그리스 문자, 첨자가 포함된 문장이 PDF 텍스트 레이어와 정확히 매칭된다', () => {
  const s1 = 'First, we define the loss function in the optimization problem.'
  // PDF 텍스트 레이어는 유니코드 첨자(²), 그리스 문자(θ), 'log', 'exp' 등을 포함할 수 있음
  const pdfBody = 'We minimize the objective L(θ) = - \u2211 log p(y|x) + λ ||θ||² where θ is the parameter.'
  // 번역/소스 문장은 LaTeX 문법($...$)으로 표현됨
  const latexSent = 'We minimize the objective $L(\\theta) = - \\sum \\log p(y|x) + \\lambda ||\\theta||^2$ where $\\theta$ is the parameter.'
  const s3 = 'Finally, the convergence guarantees hold under standard convexity assumptions.'
  const fullText = `${s1} ${pdfBody} ${s3}`

  const res = alignSentencesToText(fullText, [s1, latexSent, s3])

  assert.equal(res.length, 3)
  assert.equal(res[0].start, fullText.indexOf(s1))
  assert.equal(res[1].start, fullText.indexOf(pdfBody))
  assert.equal(res[2].start, fullText.indexOf(s3))
  assert.ok(res[1].end > res[1].start + 50, '수식 문장의 매칭 범위가 충분히 포괄적이어야 함')
  assert.ok(res[0].end <= res[1].start)
  assert.ok(res[1].end <= res[2].start)
})

test('수식 관계 연산자 및 대문자 그리스 문자 매칭: \\le, \\ge, \\Omega, \\Delta 등이 정확히 정렬된다', () => {
  const pdfBody = 'Assume that Δ(x) ≤ ε for all x ∈ Ω.'
  const latexSent = 'Assume that $\\Delta(x) \\le \\epsilon$ for all $x \\in \\Omega$.'
  const fullText = `Introduction. ${pdfBody} Next step.`

  const res = alignSentencesToText(fullText, ['Introduction.', latexSent, 'Next step.'])

  assert.equal(res.length, 3)
  assert.equal(res[1].start, fullText.indexOf(pdfBody))
  assert.ok(res[1].end > res[1].start + 25)
})

test('비순차 캡션과 매칭 실패 본문이 함께 존재할 때 문장부호/공백 구간이 아닌 실제 미매칭 본문 영역으로 보간된다 (리뷰어 재현 사례)', () => {
  const body1 = 'The introduction describes our experimental setup.'
  const caption = 'Figure 1. Distribution of measured samples.'
  const unmatchedBody = 'Measurements were collected using specialized instruments.'
  const body2 = 'The final results demonstrate a significant improvement.'

  const fullText = `${body1} ${caption} ${unmatchedBody} ${body2}`

  const result = alignSentencesToText(fullText, [
    body1,
    'Observations were gathered using specialized instruments.',
    body2,
    caption,
  ])

  assert.equal(result.length, 4)

  // 1. body1 매칭 검증
  assert.equal(result[0].start, fullText.indexOf(body1))
  assert.ok(result[0].end > result[0].start)

  // 2. 미매칭 본문이 캡션 앞의 ". "가 아니라 실제 unmatchedBody 영역에 보간 매핑되었는지 검증
  const unmatchedStart = fullText.indexOf(unmatchedBody)
  const unmatchedEnd = unmatchedStart + unmatchedBody.length
  assert.equal(result[1].start, unmatchedStart)
  assert.equal(result[1].end, unmatchedEnd)
  assert.equal(result[1].text, unmatchedBody)

  // 3. body2 매칭 검증
  assert.equal(result[2].start, fullText.indexOf(body2))
  assert.ok(result[2].end > result[2].start)

  // 4. caption 매칭 검증 (비순차 캡션 보존)
  assert.equal(result[3].start, fullText.indexOf(caption))
  assert.ok(result[3].end > result[3].start)

  // 5. 모든 영역 간 충돌(오버랩)이 없어야 함
  const sorted = [...result].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].start >= sorted[i - 1].end)
  }
})

test('merged alignment preserves multilingual out-of-order captions and raw punctuation', () => {
  const caption = '図１。𠮷野家の実験結果と測定データです。'
  const body = 'Café observations retain the oﬃce measurements.'
  const fullText = `${caption} ${body}`
  const result = alignSentencesToText(fullText, [
    'Café observations retain the office measurements.',
    '図1。𠮷野家の実験結果と測定データです。',
  ])
  assert.equal(result[0].priority, 3)
  assert.equal(result[1].priority, 3)
  assert.equal(fullText.slice(result[0].start, result[0].end), body)
  assert.equal(fullText.slice(result[1].start, result[1].end), caption)
})
