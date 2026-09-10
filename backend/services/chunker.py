import re
from typing import List

from services.pdf_parser import _INDENT_SENTINEL

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
            
            # 다음 글자가 소문자/특수문자이면 구분 안 함 (단, 숫자는 1988년, 1세 등 문장의 시작이 될 수 있으므로 제외)
            is_lower_or_digit_or_special = bool(re.match(r'^[a-z\-_\'\(\[\{"\u00e0-\u00f6\u00f8-\u00fe]', next_char))
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
    원문 문단이 PDF에서 첫 줄 들여쓰기가 적용된 문단이었다면(pdf_parser가 문단
    맨 앞에 붙여둔 표시로 판별), 그 문단 첫 문장의 태그에 ":I" 접미사를 붙여
    번역 결과에서도 이 태그 하나만 잘 보존되면 들여쓰기 여부를 복원할 수 있게 한다.
    """
    if not text.strip():
        return "", []
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    tagged_paras = []
    src_sentences = []

    idx = 0
    for para in paras:
        is_indented = para.startswith(_INDENT_SENTINEL)
        if is_indented:
            para = para[len(_INDENT_SENTINEL):].strip()
        sents = split_into_sentences(para)
        tagged_sents = []
        for i, s in enumerate(sents):
            src_sentences.append(s)
            suffix = ":I" if (is_indented and i == 0) else ""
            tagged_sents.append(f"[S{idx}{suffix}] {s}")
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
        
    # [S0], [S1] ... 태그 찾기 (대소문자 구분 없음). ":I"처럼 콜론 뒤에 붙는
    # 접미사는 pdf_parser가 감지한 원문 들여쓰기 등의 레이아웃 메타데이터를 실어
    # 나르기 위한 것으로, tag_source_text()가 문단 첫 문장 태그에만 붙인다.
    tag_pattern = re.compile(r'\[[sS](\d+)(?::([A-Za-z]+))?\]')
    matches = list(tag_pattern.finditer(tagged_translation))

    # 태그가 하나도 없는 경우 폴백 (기존 매칭 알고리즘 활용) - 이 경우 레이아웃
    # 메타데이터도 함께 유실되지만, 애초에 문장 정렬 자체가 안 되는 상황이라 감수한다.
    if not matches:
        cleaned = re.sub(r'\[[sS]\d+(?::[A-Za-z]+)?\]', '', tagged_translation).strip()
        tgt_sents = split_into_sentences(cleaned)
        aligned = align_paragraph(src_sentences, tgt_sents)
        return cleaned, aligned

    # 태그별 텍스트 범위 파싱 (같은 인덱스 태그가 여러 번 나오면 이어붙임 - LLM이
    # 실수로 같은 태그를 중복 출력해도 내용을 잃지 않도록 함)
    tag_to_text: dict = {}
    indented_idx: set = set()
    for i in range(len(matches)):
        start = matches[i].end()
        end = matches[i+1].start() if i + 1 < len(matches) else len(tagged_translation)
        idx = int(matches[i].group(1))
        flags = matches[i].group(2) or ""
        if "I" in flags:
            indented_idx.add(idx)
        content = tagged_translation[start:end].strip()
        if idx in tag_to_text:
            tag_to_text[idx] = (tag_to_text[idx] + " " + content).strip()
        else:
            tag_to_text[idx] = content

    # 깨끗한 번역본 구성 (원문 태그 제거). 들여쓰기 표시(:I)가 붙은 태그는 완전히
    # 지우지 않고 프론트엔드가 해당 문단에 들여쓰기 스타일을 적용할 수 있도록
    # pdf_parser와 동일한 표시 문자를 그 자리에 남겨둔다.
    cleaned_translation = tagged_translation
    for m in reversed(matches):
        start, end = m.span()
        idx = int(m.group(1))
        replacement = _INDENT_SENTINEL if idx in indented_idx else ""
        cleaned_translation = cleaned_translation[:start] + replacement + cleaned_translation[end:]

    cleaned_translation = re.sub(r' +', ' ', cleaned_translation).strip()
    cleaned_translation = re.sub(r'\n\n+', '\n\n', cleaned_translation)

    # 원문 문장 리스트(0..N-1) 기준으로 1대1 쌍을 구성한다. LLM이 두 개 이상의 원문
    # 문장을 하나의 태그 아래로 합쳐버리면 그 사이 인덱스들은 태그 자체가 통째로
    # 빠지는데, 이때 그냥 비워두면 PDF에서는 문장 하나가 통째로 선택되는데 번역
    # 패널에는 아무것도(혹은 엉뚱한 옆 문장 일부만) 매칭되는 문제가 생긴다.
    # 대신 이런 "구멍" 구간은 바로 다음(없으면 바로 이전) 태그가 담당하던 텍스트를
    # 문장 단위로 다시 쪼갠 뒤, 그 태그의 원래 문장까지 포함해 비례 배분(기존
    # align_paragraph의 N:M 근사 매칭)해서 채운다 - 완전히 정확하진 않아도 빈 값이나
    # 일부만 매칭된 값보다는 훨씬 낫다.
    aligned_sentences: list = [None] * N
    idx = 0
    while idx < N:
        if aligned_sentences[idx] is not None:
            idx += 1
            continue
        if idx in tag_to_text:
            aligned_sentences[idx] = {"src": src_sentences[idx], "trans": tag_to_text[idx]}
            idx += 1
            continue

        gap_start = idx
        gap_end = idx
        while gap_end < N and gap_end not in tag_to_text:
            gap_end += 1

        # 구멍의 내용이 실제로 "이전" 태그에 붙어있는지 "다음" 태그에 붙어있는지는
        # 텍스트만으로 확정할 수 없다 (LLM이 새 태그 없이 이어 쓰면 이전 태그에,
        # 뒤늦게 밀린 태그를 함께 쏟아내면 다음 태그에 남는다). 양쪽 후보를 모두
        # 문장 단위로 쪼개보고, 그 문장 개수가 이 구간에 필요한 문장 수와 가장 가깝게
        # 맞아떨어지는 쪽을 채택한다 - 후보 문장 수가 정확히 일치하면 문장별로
        # 정밀 배분되고, 아니면 비례 배분(그래도 안 맞으면 통째로 공유)으로 채운다.
        candidates = []
        for cand_idx in (gap_start - 1, gap_end):
            if cand_idx < 0 or cand_idx >= N or cand_idx not in tag_to_text:
                continue
            cand_text = tag_to_text[cand_idx]
            group_indices = sorted(set(range(gap_start, gap_end)) | {cand_idx})
            tgt_sents = split_into_sentences(cand_text)
            candidates.append({
                "donor_idx": cand_idx,
                "donor_text": cand_text,
                "group_indices": group_indices,
                "tgt_sents": tgt_sents,
                "score": abs(len(tgt_sents) - len(group_indices)),
            })

        if candidates:
            best = min(candidates, key=lambda c: c["score"])
            group_indices = best["group_indices"]
            group_src = [src_sentences[i] for i in group_indices]
            paired = align_paragraph(group_src, best["tgt_sents"]) if best["tgt_sents"] else []
            if len(paired) == len(group_indices):
                for gi, pair in zip(group_indices, paired):
                    aligned_sentences[gi] = {"src": src_sentences[gi], "trans": pair["trans"]}
            else:
                # 비례 배분 실패 시 전체 번역 텍스트를 구간 전체에 동일하게 공유
                for gi in group_indices:
                    aligned_sentences[gi] = {"src": src_sentences[gi], "trans": best["donor_text"]}
            # 실제로 채워진 범위(선택된 후보의 group_indices)를 기준으로 다음 위치를 정한다 -
            # 채택된 후보가 "이전" 태그였다면 gap_end 자체는 아직 안 채워졌으므로 그대로 두고,
            # "다음" 태그였다면 gap_end까지 채워졌으므로 그 다음으로 건너뛴다.
            idx = max(group_indices) + 1
        else:
            # 앞뒤 어디에도 기댈 태그가 없는 극단적인 경우
            for gi in range(gap_start, gap_end):
                aligned_sentences[gi] = {"src": src_sentences[gi], "trans": ""}
            idx = gap_end

    return cleaned_translation, aligned_sentences
