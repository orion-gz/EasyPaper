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

const VALID_CHAR_REGEX = /[\p{L}\p{M}\p{N}\u2200-\u22ff\u2190-\u21ff\u00d7\u00f7\u00b1\u00b7]/u;

/**
 * 빈 구간(gap) 내에서 앞뒤 문장부호/공백을 제외한 실질적인 문자 범위를 계산합니다.
 * 문장부호나 공백만으로 이루어진 구간은 null을 반환합니다.
 */
function extractSubstantiveGap(gap, fullText) {
  let start = gap.start;
  let end = gap.end;

  // 앞쪽 문장부호 및 공백 스킵
  while (start < end && !VALID_CHAR_REGEX.test(fullText[start])) {
    start++;
  }
  // 뒤쪽 공백 스킵
  while (end > start && /\s/.test(fullText[end - 1])) {
    end--;
  }

  if (start >= end || !VALID_CHAR_REGEX.test(fullText.substring(start, end))) {
    return null;
  }

  return {
    start,
    end,
    rawStart: gap.start,
    rawEnd: gap.end,
    text: fullText.substring(start, end),
    len: end - start,
  };
}

/**
 * 단어 단위 토큰 집합을 추출합니다 (길이 2 이상의 알파벳/숫자/유니코드 문자).
 */
function extractSubstantiveWords(str) {
  if (!str) return [];
  return str.toLowerCase().match(/[\p{L}\p{M}\p{N}]{2,}/gu) || [];
}

/**
 * 매칭 실패 문장 그룹에 가장 적절한 빈 구간을 평가하여 선택합니다.
 *
 * 1. 문장부호/공백만 있는 구간은 보간 후보에서 제외
 * 2. 실패 문장의 전체 길이 및 주변 문장 위치와의 상대적 거리 고려
 * 3. 공통 단어(어휘) 유사도 검사
 * 4. 후보가 여러 개이거나 근거가 부족하면 null 반환 (관련 없는 구간에 억지 매핑 방지)
 */
function selectBestTargetGap(freeGaps, fullText, failedSentences, prevMatch, nextMatch, totalSentencesCount, winStart, winEnd) {
  const candidates = [];
  for (const g of freeGaps) {
    const sub = extractSubstantiveGap(g, fullText);
    if (sub) {
      candidates.push(sub);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const failedTexts = failedSentences.map(s => s.text || '').join(' ');
  let totalLen = 0;
  for (const s of failedSentences) {
    totalLen += Math.max(1, (s.text || '').length);
  }

  const failedWords = new Set(extractSubstantiveWords(failedTexts));

  // 각 후보 구간에 대해 점수 산출
  const scored = candidates.map(cand => {
    // A. 길이 적합도 (0 ~ 1)
    const lenRatio = Math.min(cand.len, totalLen) / Math.max(cand.len, totalLen);

    // B. 상대적 위치 적합도 (0 ~ 1)
    const prevIdx = prevMatch ? prevMatch.origIndex : -1;
    const nextIdx = nextMatch ? nextMatch.origIndex : totalSentencesCount;
    const sentFraction = (failedSentences[0].origIndex - prevIdx) / Math.max(1, nextIdx - prevIdx);

    const winSpan = Math.max(1, winEnd - winStart);
    const gapPosFraction = (cand.start - winStart) / winSpan;
    const posDiff = Math.abs(gapPosFraction - sentFraction);
    const posScore = Math.max(0, 1 - posDiff);

    // C. 공통 단어 유사도 (0 ~ 1)
    const candWords = extractSubstantiveWords(cand.text);
    let overlapCount = 0;
    for (const w of candWords) {
      if (failedWords.has(w)) overlapCount++;
    }
    const simScore = failedWords.size > 0 ? overlapCount / Math.max(failedWords.size, candWords.length || 1) : 0;

    const compositeScore = (lenRatio * 0.45) + (posScore * 0.30) + (simScore * 0.25);

    return {
      cand,
      lenRatio,
      posScore,
      simScore,
      compositeScore,
      overlapCount,
    };
  });

  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  const best = scored[0];

  // 단일 후보인 경우: 길이가 너무 비상식적으로 작고 공통 단어도 없으면 매핑하지 않음
  if (candidates.length === 1) {
    if (best.cand.len < Math.min(10, totalLen * 0.2) && best.overlapCount === 0) {
      return null;
    }
    return best.cand;
  }

  // 복수 후보인 경우:
  // 근거가 부족한 경우(최고점이 너무 낮거나, 1·2위 간 변별력이 없고 어휘 힌트도 없는 경우) 억지 매핑 제외
  if (best.compositeScore < 0.25 && best.overlapCount === 0) {
    return null;
  }

  const second = scored[1];
  if (best.overlapCount === 0 && second.overlapCount === 0) {
    if (Math.abs(best.compositeScore - second.compositeScore) < 0.10) {
      return null;
    }
  }

  return best.cand;
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
    let priority = MATCH_PRIORITY.EXACT;

    // 2. 접두어 기반 검색 시도 (사소한 문자 오차 해결) - searchStart 이후에서만 찾는다.
    if (idx === -1) {
      const prefix = cleanSent.substring(0, Math.min(15, cleanSent.length));
      idx = cleanText.indexOf(prefix, searchStart);
      if (idx !== -1) {
        priority = MATCH_PRIORITY.PREFIX;
      }
    }

    // 3. 비순차 블록(본문 끝단으로 재배치된 표/그림 캡션 등) 무충돌 전역 검색
    let isOutOfOrder = false;
    if (idx === -1 && cleanSent.length >= 15) {
      let candIdx = cleanText.indexOf(cleanSent);
      let candPriority = MATCH_PRIORITY.EXACT;
      if (candIdx === -1 && cleanSent.length >= 25) {
        candIdx = cleanText.indexOf(cleanSent.substring(0, 25));
        candPriority = MATCH_PRIORITY.PREFIX;
      }
      if (candIdx !== -1) {
        const candRawStart = cleanToRaw[candIdx] ?? 0;
        const candLastIdx = Math.min(cleanText.length, candIdx + cleanSent.length) - 1;
        const candRawEnd = (cleanToRawEnd[candLastIdx] !== undefined) ? cleanToRawEnd[candLastIdx] : fullText.length;
        // 기존 매칭된 문장 범위와 충돌(오버랩)하는지 검사
        const overlaps = sentenceRanges.some(r => r.end > r.start && Math.max(candRawStart, r.start) < Math.min(candRawEnd, r.end));
        if (!overlaps) {
          idx = candIdx;
          priority = candPriority;
          isOutOfOrder = true;
        }
      }
    }

    if (idx !== -1) {
      const cleanStart = idx;
      const cleanEnd = Math.min(cleanText.length, idx + cleanSent.length);
      const rawStart = cleanToRaw[cleanStart] ?? (cleanToRaw[cleanToRaw.length - 1] ?? 0);
      const lastCleanIdx = cleanEnd - 1;
      let rawEnd = (cleanToRawEnd[lastCleanIdx] !== undefined)
        ? cleanToRawEnd[lastCleanIdx]
        : (cleanToRaw[cleanToRaw.length - 1] ?? fullText.length);

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

  // 4. 매칭 실패 문장 보간(Gap Partitioning):
  // 이미 매칭된 범위(occupied intervals)를 침범하지 않는 유효한 빈 영역만을 보간 영역으로 사용
  const matchedIntervals = sentenceRanges
    .filter(r => r.end > r.start && r.priority >= MATCH_PRIORITY.PREFIX)
    .map(r => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const GAP_SAFETY_MULTIPLIER = 2.5;
  let walkIdx = 0;
  while (walkIdx < sentenceRanges.length) {
    if (sentenceRanges[walkIdx].start === sentenceRanges[walkIdx].end) {
      let k_start = walkIdx;
      let k_end = walkIdx;
      while (k_end + 1 < sentenceRanges.length && sentenceRanges[k_end + 1].start === sentenceRanges[k_end + 1].end) {
        k_end++;
      }

      // 논리적 이전/다음 매칭 문장 탐색
      let prevMatch = null;
      for (let i = k_start - 1; i >= 0; i--) {
        if (sentenceRanges[i].end > sentenceRanges[i].start) {
          prevMatch = sentenceRanges[i];
          break;
        }
      }

      let nextMatch = null;
      for (let i = k_end + 1; i < sentenceRanges.length; i++) {
        if (sentenceRanges[i].end > sentenceRanges[i].start) {
          nextMatch = sentenceRanges[i];
          break;
        }
      }

      // 후보 텍스트 윈도우 계산
      let winStart = 0;
      let winEnd = fullText.length;
      if (prevMatch && nextMatch && prevMatch.end < nextMatch.start) {
        winStart = prevMatch.end;
        winEnd = nextMatch.start;
      } else if (prevMatch) {
        winStart = prevMatch.end;
        winEnd = fullText.length;
      } else if (nextMatch) {
        winStart = 0;
        winEnd = nextMatch.start;
      }

      // 후보 윈도우 내에서 이미 매칭된 영역을 제외한 빈 공간(free sub-gaps) 수집
      const freeGaps = [];
      let cursor = winStart;
      for (const occ of matchedIntervals) {
        if (occ.end <= cursor) continue;
        if (occ.start >= winEnd) break;
        if (occ.start > cursor) {
          freeGaps.push({ start: cursor, end: Math.min(occ.start, winEnd) });
        }
        cursor = Math.max(cursor, occ.end);
      }
      if (cursor < winEnd) {
        freeGaps.push({ start: cursor, end: winEnd });
      }

      // 문장부호/공백 구간 제외, 길이 및 위치 등을 종합 고려한 최적 구간 선택
      const failedGroup = sentenceRanges.slice(k_start, k_end + 1);
      const targetGap = selectBestTargetGap(
        freeGaps,
        fullText,
        failedGroup,
        prevMatch,
        nextMatch,
        sentenceRanges.length,
        winStart,
        winEnd
      );

      if (targetGap) {
        const gapSize = targetGap.end - targetGap.start;
        const lens = [];
        let totalLen = 0;
        for (let i = k_start; i <= k_end; i++) {
          const len = Math.max(1, (sentenceRanges[i].text || '').length);
          lens.push(len);
          totalLen += len;
        }
        const usedGap = Math.min(gapSize, totalLen * GAP_SAFETY_MULTIPLIER);
        let curPos = targetGap.start;
        for (let idx = 0; idx < lens.length; idx++) {
          const i = k_start + idx;
          const share = (idx === lens.length - 1 && lens.length > 1 && usedGap === gapSize)
            ? targetGap.end - curPos
            : Math.round((lens[idx] / totalLen) * usedGap);
          sentenceRanges[i].start = curPos;
          sentenceRanges[i].end = Math.min(targetGap.end, curPos + share);
          sentenceRanges[i].priority = MATCH_PRIORITY.GAP;
          sentenceRanges[i].text = fullText.substring(sentenceRanges[i].start, sentenceRanges[i].end);
          curPos = sentenceRanges[i].end;
        }
      }

      walkIdx = k_end + 1;
    } else {
      walkIdx++;
    }
  }

  // 5. 원문 위치 기준 충돌 보정 (정확 일치 우선 보존)
  // 배열 순서가 아닌 원문 위치(start) 기준으로 정렬한 뒤 실제 교집합(overlaps)을 검사
  const activeRanges = sentenceRanges
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 1; i < activeRanges.length; i++) {
    const prev = activeRanges[i - 1];
    const cur = activeRanges[i];

    // 실제 교집합 충돌 검사
    if (Math.max(prev.start, cur.start) < Math.min(prev.end, cur.end)) {
      if (prev.priority > cur.priority) {
        // prev가 우선순위가 높으면 prev 보존, cur 시작점을 뒤로 조정
        cur.start = Math.max(cur.start, prev.end);
        if (cur.start > cur.end) cur.end = cur.start;
        cur.text = fullText.substring(cur.start, cur.end);
      } else if (cur.priority > prev.priority) {
        // cur가 우선순위가 높으면 cur 보존, prev 끝점을 앞으로 조정
        prev.end = Math.min(prev.end, cur.start);
        if (prev.end < prev.start) prev.start = prev.end;
        prev.text = fullText.substring(prev.start, prev.end);
      } else {
        // 동일 우선순위인 경우 교집합 구간의 중간점에서 공평하게 분할
        const mid = Math.floor((cur.start + prev.end) / 2);
        prev.end = Math.max(prev.start, mid);
        cur.start = Math.min(cur.end, mid);
        prev.text = fullText.substring(prev.start, prev.end);
        cur.text = fullText.substring(cur.start, cur.end);
      }
    }
  }

  // 반환 배열은 번역 문장과의 1:1 대응을 위해 원래 sentencesList의 인덱스 순서 유지
  return sentenceRanges;
}
