// Shared by PDF selection and bounded text alignment. Offsets are UTF-16.
export function splitIntoSentences(fullText) {
  const sentenceRanges = [];

  // 먼저 문단 단위(\n\n)로 1차 분할 수행
  const paraRegex = /\n{2,}/g;
  let lastParaIndex = 0;
  let match;
  const paras = [];

  while ((match = paraRegex.exec(fullText)) !== null) {
    paras.push({
      text: fullText.substring(lastParaIndex, match.index),
      start: lastParaIndex,
      end: match.index
    });
    lastParaIndex = paraRegex.lastIndex;
  }
  paras.push({
    text: fullText.substring(lastParaIndex),
    start: lastParaIndex,
    end: fullText.length
  });

  const abbreviations = new Set([
    'al', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'tab', 'tabs',
    'eg', 'ie', 'vol', 'no', 'vs', 'dr', 'prof', 'approx', 'etc', 'cf',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    'sec', 'sect', 'app', 'chap', 'ch', 'pp', 'p', 'est', 'ave', 'st', 'dept'
  ]);

  for (const para of paras) {
    const paraText = para.text;
    const paraStart = para.start;
    if (!paraText.trim()) continue;

    // 문단 내부에서 구두점을 기준으로 2차 문장 분할
    const candRegex = /([。！？.!?]+[」』”’）】》〉"')\]]*)(\s*)/g;
    let lastSentenceIndex = 0;
    let sMatch;

    while ((sMatch = candRegex.exec(paraText)) !== null) {
      const puncIndex = sMatch.index;
      const punc = sMatch[1];
      const whitespace = sMatch[2];
      const nextIndex = puncIndex + punc.length + whitespace.length;

      if (nextIndex >= paraText.length) {
        // 문단 끝 부분
        const sentenceText = paraText.substring(lastSentenceIndex, puncIndex + punc.length);
        if (sentenceText.trim()) {
          sentenceRanges.push({
            text: sentenceText,
            start: paraStart + lastSentenceIndex,
            end: paraStart + puncIndex + punc.length
          });
        }
        lastSentenceIndex = nextIndex;
        continue;
      }

      const nextChar = paraText[nextIndex];
      const isPeriod = punc.includes('.');

      // 섹션 번호 형식 ("1.", "2.1.") 등은 단일 문장으로 분할하지 않음
      if (isPeriod) {
        const leftText = paraText.substring(lastSentenceIndex, puncIndex).trim();
        if (/^\d+(\.\d+)*$/.test(leftText)) {
          continue;
        }

        if (/\b(?:e\.g|i\.e)$/i.test(leftText)) continue;

        // 약어 매칭
        const words = leftText.split(/[\s,()\[\]{}.]+/);
        const lastWord = words.length > 0 ? words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '') : '';
        const isAbbreviation = (abbreviations.has(lastWord) && !(['etc', 'al'].includes(lastWord) && /^[A-Z]/.test(nextChar))) || (lastWord.length === 1 && /^[a-z]$/i.test(lastWord) && /^[A-Z]/.test(nextChar));
        if (isAbbreviation) continue;

        // 소수점 패턴 (\d.\d)
        const charBeforePunc = paraText[puncIndex - 1];
        if (!whitespace && charBeforePunc && /\d/.test(charBeforePunc) && /^\d/.test(nextChar)) continue;
      }

      // Preserve internal dotted abbreviations and domains.
      if (isPeriod && !whitespace && /^[a-z]/.test(nextChar) && /[A-Za-z]$/.test(paraText.slice(0, puncIndex))) continue;

      const sentenceText = paraText.substring(lastSentenceIndex, puncIndex + punc.length);
      if (sentenceText.trim()) {
        sentenceRanges.push({
          text: sentenceText,
          start: paraStart + lastSentenceIndex,
          end: paraStart + puncIndex + punc.length
        });
      }
      lastSentenceIndex = nextIndex;
    }

    if (lastSentenceIndex < paraText.length) {
      const remaining = paraText.substring(lastSentenceIndex);
      if (remaining.trim()) {
        sentenceRanges.push({
          text: remaining,
          start: paraStart + lastSentenceIndex,
          end: paraStart + paraText.length
        });
      }
    }
  }

  return sentenceRanges;
}
