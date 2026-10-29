import { splitIntoSentences } from './sentenceBoundaries.js';
import { normalizePdfText } from './pdfSentenceGeometry.js';

/**
 * 문장 정렬 및 텍스트 매핑 모듈
 * 
 * 원문 텍스트(fullText)와 번역/분할된 문장 목록(sentencesList) 간의
 * 문자 단위 범위(start, end)를 유니코드 및 수식을 고려하여 정확하게 매핑합니다.
 */

export const MATCH_PRIORITY = {
  NONE: 0,
  GAP: 1,
  PREFIX: 2,
  EXACT: 3,
};

const GREEK_MAP = {
  // Lowercase
  'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'epsilon': 'ε',
  'zeta': 'ζ', 'eta': 'η', 'theta': 'θ', 'iota': 'ι', 'kappa': 'κ',
  'lambda': 'λ', 'mu': 'μ', 'nu': 'ν', 'xi': 'ξ', 'pi': 'π',
  'rho': 'ρ', 'sigma': 'σ', 'tau': 'τ', 'upsilon': 'υ', 'phi': 'φ',
  'chi': 'χ', 'psi': 'ψ', 'omega': 'ω',
  // Variants
  'varepsilon': 'ε', 'vartheta': 'θ', 'varpi': 'ϖ', 'varrho': 'ϱ',
  'varsigma': 'ς', 'varphi': 'φ',
  // Uppercase
  'Gamma': 'Γ', 'Delta': 'Δ', 'Theta': 'Θ', 'Lambda': 'Λ', 'Xi': 'Ξ',
  'Pi': 'Π', 'Sigma': 'Σ', 'Upsilon': 'Υ', 'Phi': 'Φ', 'Psi': 'Ψ', 'Omega': 'Ω'
};

const LATEX_MATH_OPERATORS = [
  'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'sinh', 'cosh', 'tanh', 'coth', 'arcsin', 'arccos', 'arctan',
  'min', 'max', 'sup', 'inf', 'lim', 'det', 'dim', 'ker', 'deg',
  'arg', 'tr', 'rank', 'gcd', 'hom', 'diag'
];

const LATEX_SYMBOL_MAP = {
  'infty': '∞', 'partial': '∂', 'nabla': '∇',
  'forall': '∀', 'exists': '∃',
  'sum': '∑', 'prod': '∏', 'int': '∫',
  'leq': '≤', 'le': '≤',
  'geq': '≥', 'ge': '≥',
  'neq': '≠', 'ne': '≠',
  'approx': '≈', 'equiv': '≡',
  'notin': '∉', 'in': '∈',
  'rightarrow': '→', 'leftarrow': '←', 'to': '→',
  'Rightarrow': '⇒', 'Leftarrow': '⇐', 'iff': '⇔',
  'times': '×', 'cdot': '·',
  'pm': '±', 'mp': '∓'
};

// A whole sentence must support an approximate match. A shared opening or
// similar length alone is never evidence for selecting the remaining page.
function sentenceSimilarity(source, candidate) {
  const a = normalizePdfText(source).clean, b = normalizePdfText(candidate).clean;
  if (!a || !b) return 0;
  const aw = new Set(source.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
  const bw = new Set(candidate.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
  const common = [...aw].filter(word => bw.has(word)).length;
  const words = common >= 3 ? common / Math.max(aw.size, bw.size) : 0;
  // Bounded edit distance tolerates small OCR errors, including CJK text.
  const limit = Math.floor(Math.max(a.length, b.length) * 0.15);
  if (Math.min(a.length, b.length) < 8 || Math.abs(a.length - b.length) > limit) return words;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1).fill(limit + 1);
    row[0] = i;
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  const edits = prev[b.length];
  return Math.max(words, edits <= limit ? 1 - edits / Math.max(a.length, b.length) : 0);
}

/**
 * 주어진 텍스트에서 원문 문장들의 정확한 문자 범위(start, end)를 유니코드 인지 방식으로 추출하여 매핑합니다.
 *
 * @param {string} fullText - 페이지 전체 텍스트
 * @param {string[]} sentencesList - 정렬할 문장 목록
 * @param {string|number} pageNum - 디버깅/로그용 페이지 번호
 * @returns {Array<{text: string, start: number, end: number, priority?: number}>}
 */
export function alignSentencesToText(fullText, sentencesList, pageNum = '?') {
  if (!fullText) {
    return (sentencesList || []).map(s => ({ text: s || '', start: 0, end: 0 }));
  }

  const { clean: cleanText, starts: cleanToRaw, ends: cleanToRawEnd } = normalizePdfText(fullText, { includeMathSymbols: true });

  const sentenceRanges = [];
  let searchStart = 0;

  const cleanSents = (sentencesList || []).map(s => {
    let text = s || '';

    // 1. 표준 수학 함수명 (\log -> log, \exp -> exp)
    for (const op of LATEX_MATH_OPERATORS) {
      text = text.replace(new RegExp('\\\\' + op + '(?![a-zA-Z])', 'g'), op);
    }

    // 2. LaTeX 그리스 문자 명령어를 유니코드 문자로 변환 (\alpha -> α, \Gamma -> Γ)
    for (const [name, unicode] of Object.entries(GREEK_MAP)) {
      text = text.replace(new RegExp('\\\\' + name + '(?![a-zA-Z])', 'g'), unicode);
    }

    // 3. LaTeX 수학 기호 매핑 (\le -> ≤, \to -> →)
    for (const [cmd, unicode] of Object.entries(LATEX_SYMBOL_MAP)) {
      text = text.replace(new RegExp('\\\\' + cmd + '(?![a-zA-Z])', 'g'), unicode);
    }

    // 4. 서식/스타일 매크로 제거 (\mathbf{x} -> {x})
    text = text.replace(/\\(?:mathbf|mathrm|mathit|textbf|textit|text|operatorname|bm|boldsymbol|mathcal|mathbb|underline)(?![a-zA-Z])/g, '');

    // 5. 기타 남은 백슬래시 LaTeX 명령어 제거
    text = text.replace(/\\[a-zA-Z]+/g, '');

    return normalizePdfText(text, { includeMathSymbols: true }).clean;
  });

  for (let k = 0; k < cleanSents.length; k++) {
    const cleanSent = cleanSents[k];
    const sText = sentencesList[k] || '';

    if (!cleanSent) {
      const rawPos = cleanToRaw[searchStart] ?? (cleanToRaw[cleanToRaw.length - 1] ?? 0);
      sentenceRanges.push({
        origIndex: k,
        text: sText,
        start: rawPos,
        end: rawPos,
        priority: MATCH_PRIORITY.NONE
      });
      continue;
    }

    // 1. 순차 검색 시도 (가장 최선)
    let idx = cleanText.indexOf(cleanSent, searchStart);
    const priority = MATCH_PRIORITY.EXACT;

    // 2. 비순차 블록(본문 끝단으로 재배치된 표/그림 캡션 등) 무충돌 전역 검색
    let isOutOfOrder = false;
    if (idx === -1) {
      let candIdx = cleanText.indexOf(cleanSent);
      while (candIdx !== -1) {
        const candRawStart = cleanToRaw[candIdx] ?? 0;
        const candLastIdx = Math.min(cleanText.length, candIdx + cleanSent.length) - 1;
        const candRawEnd = (cleanToRawEnd[candLastIdx] !== undefined) ? cleanToRawEnd[candLastIdx] : fullText.length;
        // 기존 매칭된 문장 범위와 충돌(오버랩)하는지 검사
        const overlaps = sentenceRanges.some(r => r.end > r.start && Math.max(candRawStart, r.start) < Math.min(candRawEnd, r.end));
        if (!overlaps) {
          idx = candIdx;
          isOutOfOrder = true;
          break;
        }
        candIdx = cleanText.indexOf(cleanSent, candIdx + 1);
      }
    }

    if (idx !== -1) {
      const cleanStart = idx;
      const cleanEnd = Math.min(cleanText.length, idx + cleanSent.length);
      let rawStart = cleanToRaw[cleanStart] ?? (cleanToRaw[cleanToRaw.length - 1] ?? 0);
      const lastCleanIdx = cleanEnd - 1;
      let rawEnd = (cleanToRawEnd[lastCleanIdx] !== undefined)
        ? cleanToRawEnd[lastCleanIdx]
        : (cleanToRaw[cleanToRaw.length - 1] ?? fullText.length);

      const prefix = sText.match(/^[^\p{L}\p{M}\p{N}\s]+/u)?.[0];
      if (prefix && fullText.slice(Math.max(0, rawStart - prefix.length), rawStart) === prefix) {
        rawStart -= prefix.length;
      }

      // Preserve sentence-final punctuation and OCR-inserted spacing from main.
      const suffix = sText.match(/[^\p{L}\p{M}\p{N}\s]+\s*$/u)?.[0]?.trim();
      if (suffix) {
        let cursor = rawEnd;
        for (const char of suffix) {
          while (/\s/u.test(fullText[cursor] || '') && cursor < fullText.length) cursor++;
          if (fullText[cursor] !== char) break;
          rawEnd = ++cursor;
        }
      }

      sentenceRanges.push({
        origIndex: k,
        text: fullText.substring(rawStart, rawEnd),
        start: rawStart,
        end: rawEnd,
        priority
      });

      // 순방향 매칭일 때만 순차 포인터 전진 (비순차 캡션에 의해 본문 포인터가 교란되지 않도록 방지)
      if (!isOutOfOrder && cleanEnd > searchStart) {
        searchStart = cleanEnd;
      }
    } else {
      // 매칭 실패 폴백
      const rawPos = cleanToRaw[searchStart] ?? (cleanToRaw[cleanToRaw.length - 1] ?? 0);
      sentenceRanges.push({
        origIndex: k,
        text: sText,
        start: rawPos,
        end: rawPos,
        priority: MATCH_PRIORITY.NONE
      });
    }
  }

  // Reject normalization matches that cross a sentence boundary absent from
  // the source, and duplicate/overlapping matches. Do not split the difference:
  // that would turn the remainder of a neighbour into a new sentence.
  const occupied = [];
  for (const range of sentenceRanges) {
    if (range.end <= range.start) continue;
    const sourceCount = splitIntoSentences(sentencesList[range.origIndex] || '').length;
    if (splitIntoSentences(range.text).length > sourceCount
        || occupied.some(other => range.start < other.end && range.end > other.start)) {
      range.end = range.start;
      range.priority = MATCH_PRIORITY.NONE;
      continue;
    }
    occupied.push(range);
  }

  // Approximate matches use complete PDF sentences only, never a character
  // budget or a proportion of the gap between two successfully matched texts.
  const candidates = splitIntoSentences(fullText).map(range => {
    const leading = range.text.length - range.text.trimStart().length;
    return { start: range.start + leading, end: range.end, text: range.text.trimStart() };
  });
  for (const range of sentenceRanges) {
    if (range.end > range.start) continue;
    const source = sentencesList[range.origIndex] || '';
    if (splitIntoSentences(source).length !== 1) continue;
    const ranked = candidates
      .filter(candidate => !occupied.some(other => candidate.start < other.end && candidate.end > other.start))
      .map(candidate => ({ candidate, score: sentenceSimilarity(source, candidate.text) }))
      .filter(match => match.score >= 0.55)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < 0.1)) continue;
    Object.assign(range, ranked[0].candidate, { priority: MATCH_PRIORITY.GAP });
    occupied.push(range);
  }

  // 반환 배열은 번역 문장과의 1:1 대응을 위해 원래 sentencesList의 인덱스 순서 유지
  return sentenceRanges;
}
