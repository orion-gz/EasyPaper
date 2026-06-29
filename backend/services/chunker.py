import re
from typing import List

# 청크 크기: 너무 작으면 문장/수식이 잘림. 3000자로 설정.
MAX_CHUNK_CHARS = 3000


def split_into_chunks(text: str, max_chars: int = MAX_CHUNK_CHARS) -> List[str]:
    """
    텍스트를 문단 기준으로 분할합니다.
    최대 길이를 초과하면 문장 단위로 추가 분할합니다.
    수식 블록($$...$$)은 분리하지 않습니다.
    """
    if not text.strip():
        return []

    # 수식 블록을 임시 마커로 보호
    math_blocks: List[str] = []
    def protect_math(m):
        idx = len(math_blocks)
        math_blocks.append(m.group(0))
        return f"___MATHBLOCK_{idx}___"

    protected = re.sub(r'\$\$[\s\S]*?\$\$', protect_math, text)
    protected = re.sub(r'\\\[[\s\S]*?\\\]', protect_math, protected)

    paragraphs = [p.strip() for p in protected.split("\n\n") if p.strip()]
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for para in paragraphs:
        if current_len + len(para) + 2 <= max_chars:
            current.append(para)
            current_len += len(para) + 2
        else:
            if current:
                chunks.append("\n\n".join(current))
            # 단락 자체가 너무 길면 문장 단위 분할
            if len(para) > max_chars:
                sentence_chunks = _split_by_sentences(para, max_chars)
                chunks.extend(sentence_chunks[:-1])
                current = [sentence_chunks[-1]] if sentence_chunks else []
                current_len = len(current[0]) if current else 0
            else:
                current = [para]
                current_len = len(para)

    if current:
        chunks.append("\n\n".join(current))

    # 수식 마커 복원
    def restore_math(chunk: str) -> str:
        for idx, block in enumerate(math_blocks):
            chunk = chunk.replace(f"___MATHBLOCK_{idx}___", block)
        return chunk

    return [restore_math(c) for c in chunks if c.strip()]


def _split_by_sentences(text: str, max_chars: int) -> List[str]:
    """문장 단위로 텍스트를 분할합니다."""
    # 마침표/물음표/느낌표 뒤 공백으로 분리 (약어 방지: 소문자.소문자 패턴은 분리하지 않음)
    sentences = re.split(r'(?<=[.!?])(?=\s+[A-Z])', text)
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for sent in sentences:
        sent_stripped = sent.strip()
        if not sent_stripped:
            continue
        if current_len + len(sent_stripped) + 1 <= max_chars:
            current.append(sent_stripped)
            current_len += len(sent_stripped) + 1
        else:
            if current:
                chunks.append(" ".join(current))
            # 단일 문장이 max_chars 초과면 그냥 통째로 넣음 (절단보다 낫다)
            if len(sent_stripped) > max_chars:
                chunks.append(sent_stripped)
                current = []
                current_len = 0
            else:
                current = [sent_stripped]
                current_len = len(sent_stripped)

    if current:
        chunks.append(" ".join(current))

    return chunks if chunks else [text]


def split_into_sentences(text: str) -> List[str]:
    """
    텍스트를 단락과 문장 단위로 분리합니다.
    (JS의 splitIntoSentences와 일치하는 규칙)
    """
    if not text.strip():
        return []
        
    # 문단 단위로 1차 분할
    paras = [p.strip() for p in re.split(r'\n{2,}', text) if p.strip()]
    
    abbreviations = {
        'al', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'tab', 'tabs',
        'eg', 'ie', 'vol', 'no', 'vs', 'dr', 'prof', 'approx', 'etc', 'cf',
        'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
        'sec', 'sect', 'app', 'chap', 'ch', 'pp', 'p', 'est', 'ave', 'st', 'dept'
    }
    
    sentence_ranges = []
    for para in paras:
        last_index = 0
        cand_regex = re.compile(r'([.!?]+)([ \t\n\r]+)')
        matches = list(cand_regex.finditer(para))
        
        for match in matches:
            punc_index = match.start(1)
            punc = match.group(1)
            whitespace = match.group(2)
            next_index = punc_index + len(punc) + len(whitespace)
            
            if next_index >= len(para):
                sentence_text = para[last_index:punc_index + len(punc)]
                if sentence_text.strip():
                    sentence_ranges.append(sentence_text.strip())
                last_index = next_index
                continue
                
            next_char = para[next_index]
            is_period = '.' in punc
            
            # 다음 글자가 소문자/숫자/특수문자이면 구분 안 함
            is_lower_or_digit_or_special = bool(re.match(r'^[a-z0-9\-_\'\(\[\{"\u00e0-\u00f6\u00f8-\u00fe]', next_char))
            if is_period and is_lower_or_digit_or_special:
                continue
                
            # 섹션 번호 형식 ("1.", "2.1.") 등은 단일 문장으로 분할하지 않음
            if is_period:
                left_text = para[last_index:punc_index].strip()
                if re.match(r'^\d+(\.\d+)*$', left_text):
                    continue
                    
                # 약어 매칭
                words = re.split(r'[\s,()\[\]{}.]+', left_text)
                last_word = re.sub(r'[^a-z]', '', words[-1].lower()) if words else ''
                if last_word in abbreviations or (len(last_word) == 1 and last_word.isalpha()):
                    continue
                    
                # 소수점 패턴 (\d.\d)
                char_before_punc = para[punc_index - 1] if punc_index > 0 else ''
                if char_before_punc.isdigit() and next_char.isdigit():
                    continue
                    
            sentence_text = para[last_index:punc_index + len(punc)]
            if sentence_text.strip():
                sentence_ranges.append(sentence_text.strip())
            last_index = next_index
            
        if last_index < len(para):
            remaining = para[last_index:]
            if remaining.strip():
                sentence_ranges.append(remaining.strip())
                
    return sentence_ranges


def align_paragraph(src_sents: List[str], tgt_sents: List[str]) -> List[dict]:
    """단일 단락 내에서 원문과 번역문 문장 리스트를 1대1 매핑하여 정렬합니다."""
    N = len(src_sents)
    M = len(tgt_sents)
    if N == 0 or M == 0:
        return []
    if N == M:
        return [{"src": s, "trans": t} for s, t in zip(src_sents, tgt_sents)]
        
    # 원문 문장이 더 많으면 원문을 병합
    if N > M:
        groups = [[] for _ in range(M)]
        for i, s in enumerate(src_sents):
            idx = min(M - 1, int(i * M / N))
            groups[idx].append(s)
        return [{"src": " ".join(g), "trans": t} for g, t in zip(groups, tgt_sents)]
    else:
        # 번역문 문장이 더 많으면 번역문을 병합
        groups = [[] for _ in range(N)]
        for j, t in enumerate(tgt_sents):
            idx = min(N - 1, int(j * N / M))
            groups[idx].append(t)
        return [{"src": s, "trans": " ".join(g)} for s, g in zip(src_sents, groups)]


def align_sentences(src_text: str, tgt_text: str) -> List[dict]:
    """
    전체 텍스트에서 원문과 번역문 문장들을 단락 단위 우선으로 매핑합니다.
    단락 개수가 다르면 전체 단위 매칭으로 폴백합니다.
    """
    src_paras = [p.strip() for p in src_text.split("\n\n") if p.strip()]
    tgt_paras = [p.strip() for p in tgt_text.split("\n\n") if p.strip()]
    
    if len(src_paras) == len(tgt_paras):
        pairs = []
        for sp, tp in zip(src_paras, tgt_paras):
            s_sents = split_into_sentences(sp)
            t_sents = split_into_sentences(tp)
            pairs.extend(align_paragraph(s_sents, t_sents))
        return pairs
    else:
        s_sents = split_into_sentences(src_text)
        t_sents = split_into_sentences(tgt_text)
        return align_paragraph(s_sents, t_sents)


def tag_source_text(text: str) -> tuple[str, List[str]]:
    """
    텍스트의 각 문장 시작 부분에 [S0], [S1], ... 문장 식별자 태그를 삽입합니다.
    """
    if not text.strip():
        return "", []
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    tagged_paras = []
    src_sentences = []
    
    idx = 0
    for para in paras:
        sents = split_into_sentences(para)
        tagged_sents = []
        for s in sents:
            src_sentences.append(s)
            tagged_sents.append(f"[S{idx}] {s}")
            idx += 1
        tagged_paras.append(" ".join(tagged_sents))
        
    tagged_text = "\n\n".join(tagged_paras)
    return tagged_text, src_sentences


def parse_tagged_translation(tagged_translation: str, src_sentences: List[str]) -> tuple[str, List[dict]]:
    """
    [S0], [S1] 태그가 포함된 번역본을 파싱하여, 태그가 제거된 깨끗한 번역본과
    각 문장이 1대1 매핑된 문장 쌍 리스트를 반환합니다.
    """
    N = len(src_sentences)
    if N == 0:
        return tagged_translation, []
        
    # [S0], [S1] ... 태그 찾기 (대소문자 구분 없음)
    tag_pattern = re.compile(r'\[[sS](\d+)\]')
    matches = list(tag_pattern.finditer(tagged_translation))
    
    # 태그가 하나도 없는 경우 폴백 (기존 매칭 알고리즘 활용)
    if not matches:
        cleaned = re.sub(r'\[[sS]\d+\]', '', tagged_translation).strip()
        tgt_sents = split_into_sentences(cleaned)
        aligned = align_paragraph(src_sentences, tgt_sents)
        return cleaned, aligned
        
    # 태그별 텍스트 범위 파싱
    tag_to_text = {}
    for i in range(len(matches)):
        start = matches[i].end()
        end = matches[i+1].start() if i + 1 < len(matches) else len(tagged_translation)
        idx = int(matches[i].group(1))
        content = tagged_translation[start:end].strip()
        tag_to_text[idx] = content
        
    # 깨끗한 번역본 구성 (원문 태그 완전 제거)
    cleaned_translation = tagged_translation
    for m in reversed(matches):
        start, end = m.span()
        cleaned_translation = cleaned_translation[:start] + cleaned_translation[end:]
        
    cleaned_translation = re.sub(r' +', ' ', cleaned_translation).strip()
    cleaned_translation = re.sub(r'\n\n+', '\n\n', cleaned_translation)
    
    # 원문 문장 리스트 기준으로 1대1 쌍을 구성 (누락된 태그는 비워두거나 인접 문장 텍스트로 보완)
    aligned_sentences = []
    for idx in range(N):
        trans_content = tag_to_text.get(idx, "")
        aligned_sentences.append({
            "src": src_sentences[idx],
            "trans": trans_content
        })
        
    return cleaned_translation, aligned_sentences
