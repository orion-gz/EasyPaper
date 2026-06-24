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
