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


def merge_bboxes(rects: list, threshold: float = 15.0) -> list:
    """
    서로 가깝거나 겹치는 바운딩 박스들을 병합합니다.
    """
    if not rects:
        return []
    
    merged = True
    while merged:
        merged = False
        new_rects = []
        used = set()
        
        for i in range(len(rects)):
            if i in used:
                continue
            r1 = rects[i]
            x0, y0, x1, y1 = r1
            
            for j in range(i + 1, len(rects)):
                if j in used:
                    continue
                r2 = rects[j]
                
                # 가로나 세로 거리 임계값 이내인지 판단
                x_overlap = not (x1 + threshold < r2[0] or r2[2] + threshold < x0)
                y_overlap = not (y1 + threshold < r2[1] or r2[3] + threshold < y0)
                
                if x_overlap and y_overlap:
                    x0 = min(x0, r2[0])
                    y0 = min(y0, r2[1])
                    x1 = max(x1, r2[2])
                    y1 = max(y1, r2[3])
                    used.add(j)
                    merged = True
            
            new_rects.append([x0, y0, x1, y1])
            used.add(i)
        
        rects = new_rects
        
    return rects


def extract_pdf_images(pdf_path: str) -> List[Dict[str, Any]]:
    """
    PDF의 각 페이지에서 실제 그림/이미지(Figure)의 영역(백분율) 정보를 추출합니다.
    인접한 이미지 조각들을 그룹화(Merge)하고 약간의 여백(Padding)을 제공하여 크롭 시 잘림 현상을 방지합니다.
    """
    doc = fitz.open(pdf_path)
    images_data = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        page_width = page.rect.width
        page_height = page.rect.height
        if page_width == 0 or page_height == 0:
            continue
            
        page_imgs = page.get_image_info(xrefs=True)
        raw_rects = []
        for img in page_imgs:
            bbox = img.get("bbox")
            if not bbox:
                continue
            x0, y0, x1, y1 = bbox
            w = x1 - x0
            h = y1 - y0
            # 너무 작거나 선 형태인 이미지(예: 1x1 또는 매우 얇은 테두리 등) 제외
            if w < 15 or h < 15:
                continue
            raw_rects.append([x0, y0, x1, y1])
        
        # 바운딩 박스 그룹화 (인접 임계값 15포인트)
        merged_rects = merge_bboxes(raw_rects, threshold=15.0)
        
        for r in merged_rects:
            # 여백(Padding) 8포인트 적용하여 이미지 주변 텍스트/경계 포함되도록 보정
            x0 = max(0.0, r[0] - 8.0)
            y0 = max(0.0, r[1] - 8.0)
            x1 = min(page_width, r[2] + 8.0)
            y1 = min(page_height, r[3] + 8.0)
            
            w = x1 - x0
            h = y1 - y0
            # 보정 후 유효한 크기인지 최종 체크
            if w < 20 or h < 20:
                continue
                
            # 백분율 좌표 계산
            left = (x0 / page_width) * 100
            top = (y0 / page_height) * 100
            width = (w / page_width) * 100
            height = (h / page_height) * 100
            
            images_data.append({
                "page": page_num + 1,
                "left": left,
                "top": top,
                "width": width,
                "height": height
            })
            
    doc.close()
    return images_data

