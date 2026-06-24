import fitz  # PyMuPDF
import re
from typing import List, Dict, Any


def extract_pages(pdf_path: str) -> List[Dict[str, Any]]:
    """
    PDF에서 페이지별 텍스트 블록을 추출합니다.
    2단 레이아웃을 감지하여 읽기 순서대로 정렬합니다.
    """
    doc = fitz.open(pdf_path)
    pages = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        page_data = _extract_page(page, page_num + 1)
        pages.append(page_data)

    doc.close()
    return pages


def _extract_page(page: fitz.Page, page_num: int) -> Dict[str, Any]:
    """단일 페이지에서 텍스트를 추출합니다."""
    page_width = page.rect.width

    # 텍스트 블록 추출 (위치 정보 포함)
    blocks = page.get_text("blocks", sort=True)

    # 2단 레이아웃 감지
    is_two_column = _detect_two_column(blocks, page_width)

    if is_two_column:
        sorted_blocks = _sort_two_column(blocks, page_width)
    else:
        sorted_blocks = sorted(blocks, key=lambda b: (b[1], b[0]))  # y, x 순 정렬

    # 텍스트 정제
    text_content = _build_text(sorted_blocks)

    return {
        "page_num": page_num,
        "text": text_content,
        "is_two_column": is_two_column,
        "word_count": len(text_content.split()),
    }


def _detect_two_column(blocks: list, page_width: float) -> bool:
    """2단 레이아웃 여부를 감지합니다."""
    if not blocks:
        return False

    mid = page_width / 2
    left_blocks = [b for b in blocks if b[2] < mid * 1.1 and b[0] < mid]
    right_blocks = [b for b in blocks if b[0] > mid * 0.9]

    # 좌우 블록이 비슷한 수라면 2단 레이아웃
    total = len(blocks)
    if total < 4:
        return False

    left_ratio = len(left_blocks) / total
    right_ratio = len(right_blocks) / total
    return left_ratio > 0.3 and right_ratio > 0.3


def _sort_two_column(blocks: list, page_width: float) -> list:
    """2단 레이아웃 블록을 읽기 순서(좌단 → 우단)로 정렬합니다."""
    mid = page_width / 2
    left = sorted(
        [b for b in blocks if (b[0] + b[2]) / 2 < mid],
        key=lambda b: b[1]
    )
    right = sorted(
        [b for b in blocks if (b[0] + b[2]) / 2 >= mid],
        key=lambda b: b[1]
    )
    return left + right


def _build_text(blocks: list) -> str:
    """블록 목록에서 최종 텍스트를 구성합니다."""
    paragraphs = []
    for block in blocks:
        if len(block) < 5:
            continue
        text = block[4].strip()
        if not text or len(text) < 3:
            continue
        # 하이픈으로 끊긴 단어 복원
        text = re.sub(r'-\n(\w)', r'\1', text)
        # 단일 줄바꿈은 공백으로 (단락 내)
        text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        if text:
            paragraphs.append(text)

    raw = "\n\n".join(paragraphs)
    return clean_text_for_translation(raw)


def clean_text_for_translation(text: str) -> str:
    """
    번역 전 텍스트에서 노이즈를 제거합니다.

    제거 대상:
    - 논문 리뷰용 줄 번호 (001, 002 ... 또는 1, 2, 3 단독 라인)
    - 페이지 상단/하단 헤더·푸터 숫자
    - 연속된 공백/빈 줄 정리
    """
    lines = text.split('\n')
    cleaned = []

    for line in lines:
        stripped = line.strip()

        # ① 순수 줄 번호 라인 제거
        #    - 1~5자리 숫자만 있는 줄 (앞에 0 패딩 포함: 001, 002...)
        #    - 예: "5", "042", "  100  "
        if re.fullmatch(r'\s*\d{1,5}\s*', line):
            continue

        # ② 줄 시작의 줄 번호 제거
        #    - "002 The quick brown fox" → "The quick brown fox"
        #    - "  5   Introduction" → "Introduction"
        #    단, "Figure 2." 나 "[2]" 같은 패턴은 건드리지 않음
        stripped_line = re.sub(r'^\s*\d{1,5}\s{2,}', '', line)
        if stripped_line != line:
            # 제거 후 내용이 남아있으면 사용, 없으면 스킵
            if stripped_line.strip():
                cleaned.append(stripped_line)
            continue

        cleaned.append(line)

    result = '\n'.join(cleaned)

    # ③ 3개 이상 연속 빈 줄 → 2개로 축소
    result = re.sub(r'\n{3,}', '\n\n', result)

    return result.strip()



def get_pdf_metadata(pdf_path: str) -> Dict[str, Any]:
    """PDF 메타데이터를 반환합니다."""
    doc = fitz.open(pdf_path)
    meta = doc.metadata or {}
    page_count = len(doc)
    doc.close()
    return {
        "title": meta.get("title", ""),
        "author": meta.get("author", ""),
        "subject": meta.get("subject", ""),
        "total_pages": page_count,
    }
