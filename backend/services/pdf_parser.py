import base64
import fitz  # PyMuPDF
import re
from typing import List, Dict, Any, Optional


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

    # matplotlib 등으로 그려 PDF에 벡터 그래픽(선/도형)으로 삽입된 차트/다이어그램은
    # 축 라벨, 범례, 막대그래프 수치 등이 래스터 이미지가 아니라 실제 텍스트 객체로
    # 존재해서 get_text()에 본문 블록과 구분 없이 그대로 섞여 나온다. 이를 걸러내기
    # 위해 벡터 그림 영역을 먼저 찾아두고, 아래에서 이 영역과 대부분 겹치는 텍스트
    # 블록은 본문에서 제외한다.
    figure_rects = _find_vector_figure_rects(page)

    # "dict" 모드로 추출해야 줄/글자 단위 상세 정보(볼드 여부, 줄별 x좌표)에
    # 접근할 수 있다 - "blocks" 모드는 블록의 좌표+텍스트만 주고 스타일 정보를
    # 전부 버린다. 블록 분할/정렬 결과는 "blocks" 모드와 동일함을 확인했으므로
    # (같은 sort=True 옵션, 같은 bbox), 기존 2단 레이아웃 감지/정렬 함수는
    # bbox 튜플 형태만 맞춰주면 그대로 재사용할 수 있다.
    raw = page.get_text("dict", sort=True)
    blocks = []
    for b in raw["blocks"]:
        if "lines" not in b or not b["lines"]:
            continue
        text, is_indented = _build_block_text_and_indent(b)
        if not text.strip():
            continue
        x0, y0, x1, y1 = b["bbox"]
        if figure_rects and _rect_mostly_inside_any(x0, y0, x1, y1, figure_rects):
            continue
        blocks.append((x0, y0, x1, y1, text, is_indented))

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


# PyMuPDF span flags 비트 4 = 볼드. 폰트 이름에 "bold"가 없어도(예: 서브셋 폰트의
# "-Medi", "-Semi" 같은 표기) 이 비트로 정확히 판별되는 경우가 많아 우선 사용하고,
# 폰트 이름 검사는 보조 수단으로만 병행한다.
_BOLD_FLAG = 1 << 4

# 문단 첫 줄이 본문 줄들보다 이만큼(포인트) 이상 오른쪽에서 시작하면 원문에
# 첫 줄 들여쓰기가 적용된 문단으로 판단한다. 실측 결과 일반적인 학술 논문의
# 들여쓰기는 약 12pt였으므로, 폰트 렌더링 오차를 감안해 여유 있게 8pt로 설정.
_INDENT_THRESHOLD = 8.0

# 들여쓰기된 문단의 원문 텍스트 맨 앞에 붙이는 표시(유니코드 사용자 영역 문자라
# 실제 논문 본문과 충돌할 일이 없다). chunker.tag_source_text()가 이 표시를 읽고
# 제거한 뒤 해당 문단 첫 문장의 [S{n}] 태그에 들여쓰기 정보를 실어 보낸다.
_INDENT_SENTINEL = ""


def _is_bold_span(span: dict) -> bool:
    return bool(span.get("flags", 0) & _BOLD_FLAG) or "bold" in span.get("font", "").lower()


def _spans_to_bold_markdown(spans: List[dict]) -> str:
    """한 줄(line)의 span 목록을 이어붙이되, 볼드로 표시된 구간은 마크다운
    (**...**)으로 감싼다. 본문 텍스트(_build_block_text_and_indent)뿐 아니라
    Figure/Table 캡션 추출(_find_page_captions)에서도 원문의 볼드 서식을
    그대로 프론트엔드까지 전달하기 위해 공용으로 쓰인다."""
    parts = []
    for span in spans:
        t = span.get("text", "")
        if not t:
            continue
        if _is_bold_span(span) and t.strip():
            # 앞뒤 공백은 마크다운 표시 밖으로 빼서 "** text **"처럼 어색해지지 않게 함
            lead = t[:len(t) - len(t.lstrip())]
            trail = t[len(t.rstrip()):]
            core = t.strip()
            parts.append(f"{lead}**{core}**{trail}")
        else:
            parts.append(t)
    return "".join(parts)


def _build_block_text_and_indent(block: dict) -> tuple[str, bool]:
    """dict 모드 블록 하나에서 줄 단위로 텍스트를 조립합니다.
    볼드로 표시된 글자 구간은 번역 후에도 살아남도록 마크다운(**...**)으로 감싸고,
    이 블록이 원문에서 첫 줄 들여쓰기가 적용된 문단인지 함께 판별합니다."""
    line_texts = []
    line_x0s = []
    for line in block["lines"]:
        spans = line.get("spans", [])
        if not spans:
            continue
        line_text = _spans_to_bold_markdown(spans)
        if line_text.strip():
            line_texts.append(line_text)
            line_x0s.append(line["bbox"][0])

    text = "\n".join(line_texts)

    is_indented = False
    if len(line_x0s) >= 2:
        body_x0 = min(line_x0s[1:])
        if line_x0s[0] - body_x0 >= _INDENT_THRESHOLD:
            is_indented = True

    return text, is_indented


# 블록 폭이 페이지 폭의 이 비율 이상이면 "전체 폭" 블록(제목/헤더/푸터/전체 폭 표 등)으로 간주.
# 일반적인 2단 컬럼 블록은 여백/거터를 제외하면 페이지 폭의 절반 미만이므로 안전하게 구분됨.
_WIDE_BLOCK_RATIO = 0.6


def _classify_block(block: tuple, page_width: float, mid: float) -> str:
    """블록을 'wide'(전체 폭) / 'left' / 'right' 중 하나로 분류합니다."""
    x0, y0, x1, y1 = block[0], block[1], block[2], block[3]
    if (x1 - x0) >= page_width * _WIDE_BLOCK_RATIO:
        return "wide"
    return "left" if (x0 + x1) / 2 < mid else "right"


def _detect_two_column(blocks: list, page_width: float) -> bool:
    """2단 레이아웃 여부를 감지합니다.

    PyMuPDF는 한 컬럼 전체를 하나의 큰 블록으로 병합하는 경우가 많아
    블록 '개수' 비율로 판단하면 (예: 좌측 5개 vs 우측 1개) 실제로는 2단인데도
    감지에 실패한다. 따라서 블록 개수가 아니라 좌/우에 배치된 텍스트의 '글자 수'로 판단한다.
    """
    if not blocks:
        return False

    mid = page_width / 2
    left_chars = 0
    right_chars = 0
    for b in blocks:
        kind = _classify_block(b, page_width, mid)
        if kind == "left":
            left_chars += len(b[4])
        elif kind == "right":
            right_chars += len(b[4])

    # 양쪽 모두 최소한의 본문 분량(약 30~40단어 이상)이 있어야 진짜 2단 레이아웃으로 판단
    return left_chars > 200 and right_chars > 200


def _sort_two_column(blocks: list, page_width: float) -> list:
    """2단 레이아웃 블록을 읽기 순서(좌단 전체 → 우단 전체)로 정렬합니다.

    전체 블록을 y좌표 순으로 훑다가 제목/헤더/푸터처럼 전체 폭을 차지하는 블록을
    만나면, 그때까지 쌓인 좌단 블록을 전부(y순) 배출한 뒤 우단 블록을 전부(y순) 배출하고,
    그 다음 전체 폭 블록을 배출한다. 이렇게 해야 오른쪽 컬럼의 시작 y좌표가 왼쪽 컬럼의
    특정 문단과 우연히 비슷해도(예: Abstract와 우측 본문이 같은 높이에서 시작) 좌단을
    끝까지 읽은 뒤 우단으로 넘어가는 순서가 보장된다.
    """
    mid = page_width / 2
    ordered = sorted(blocks, key=lambda b: b[1])  # y0 순

    result = []
    left_buf: list = []
    right_buf: list = []

    def flush():
        left_buf.sort(key=lambda b: b[1])
        right_buf.sort(key=lambda b: b[1])
        result.extend(left_buf)
        result.extend(right_buf)
        left_buf.clear()
        right_buf.clear()

    for b in ordered:
        kind = _classify_block(b, page_width, mid)
        if kind == "wide":
            flush()
            result.append(b)
        elif kind == "left":
            left_buf.append(b)
        else:
            right_buf.append(b)

    flush()
    return result


def _build_text(blocks: list) -> str:
    """블록 목록에서 최종 텍스트를 구성합니다."""
    paragraphs = []
    for block in blocks:
        if len(block) < 5:
            continue
        text = block[4].strip()
        if not text or len(text) < 3:
            continue
        is_indented = block[5] if len(block) > 5 else False
        # 하이픈으로 끊긴 단어 복원 (줄 끝/시작이 볼드 마커(**)로 감싸져 있어도 병합됨 -
        # 볼드 단어가 하이픈으로 줄바꿈되면 "**Perfor-**\n**mance**"처럼 되는데, 이 경우
        # 이음매의 마커만 제거해도 각 줄이 자기 완결적으로 감싸져 있었으므로 최종적으로
        # "**Performance**"로 올바르게 합쳐진다)
        text = re.sub(r'-\*{0,2}\n\*{0,2}(\w)', r'\1', text)
        # 단일 줄바꿈은 공백으로 (단락 내)
        text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        if text:
            if is_indented:
                text = _INDENT_SENTINEL + text
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



def _extract_paper_title(doc: fitz.Document) -> str:
    """PDF 첫 페이지의 텍스트와 폰트 크기를 분석하여 논문의 실제 제목을 추출합니다."""
    if len(doc) == 0:
        return ""
    
    try:
        page = doc[0]
        blocks = page.get_text("dict")["blocks"]
        
        spans_info = []
        for b in blocks:
            if "lines" not in b:
                continue
            for line in b["lines"]:
                for span in line["spans"]:
                    text = span["text"]
                    stripped = text.strip()
                    if not stripped:
                        continue
                    # 단일 문자이면서 폰트 크기가 작은 경우(노이즈) 무시
                    if len(stripped) < 2 and span["size"] < 12:
                        continue
                    # 숫자로만 이루어진 스팬은 무시
                    if stripped.isdigit():
                        continue
                    
                    # arXiv 스탬프 및 학회/저널 프리프린트 헤더 필터링
                    lower_text = text.lower()
                    if "arxiv" in lower_text:
                        continue
                    if any(kw in lower_text for kw in ["preprint", "under review", "submitted to", "accepted as"]):
                        continue
                    
                    bbox = span["bbox"]
                    y0 = bbox[1]
                    height = page.rect.height
                    
                    # 상단 8% 미만 또는 하단 15% 초과 영역에 있으면서 폰트가 작은 경우(헤더/푸터) 무시
                    if (y0 < height * 0.08 or y0 > height * 0.85) and span["size"] < 12:
                        continue
                        
                    spans_info.append({
                        "text": text,
                        "size": span["size"],
                        "font": span["font"],
                        "bbox": bbox
                    })
        
        if not spans_info:
            return ""
            
        # 가장 큰 폰트 크기 찾기
        max_size = max(s["size"] for s in spans_info)
        
        # 최상위 폰트 크기(최대 크기의 78% 이상인 것들 - Small Caps 지원용)에 해당하는 스팬 수집
        title_spans = []
        for s in spans_info:
            if s["size"] >= max_size * 0.78:
                title_spans.append(s)
                
        if not title_spans:
            return ""
            
        # 1. y좌표 기준으로 1차 정렬한 뒤, 동적으로 같은 행(Line)에 있는 스팬들을 묶어서 그룹화합니다.
        #    이렇게 하면 PDF 렌더링 시 y좌표가 소수점 단위로 미세하게 다른 스팬들이 엉뚱하게 정렬되는 문제를 방지합니다.
        def group_spans_into_lines(spans_list):
            if not spans_list:
                return []
            sorted_by_y = sorted(spans_list, key=lambda s: s["bbox"][1])
            lines_list = []
            current_line = []
            current_y = None
            for s in sorted_by_y:
                y0 = s["bbox"][1]
                y1 = s["bbox"][3]
                h = y1 - y0
                if current_y is None:
                    current_line.append(s)
                    current_y = y0
                else:
                    # y0 차이가 글자 높이의 50% 미만이거나 8픽셀 미만이면 같은 행으로 간주
                    if abs(y0 - current_y) < max(h * 0.5, 8.0):
                        current_line.append(s)
                    else:
                        current_line.sort(key=lambda x: x["bbox"][0])
                        lines_list.append(current_line)
                        current_line = [s]
                        current_y = y0
            if current_line:
                current_line.sort(key=lambda x: x["bbox"][0])
                lines_list.append(current_line)
            return lines_list

        line_groups = group_spans_into_lines(title_spans)

        # 1-1. 제목 폰트 크기가 우연히 저자명/소속 또는 "1. Introduction" 같은 번호 매겨진
        #      섹션 헤더와 비슷한 경우, 이런 줄들이 제목 후보에 섞여 들어올 수 있습니다.
        #      제목은 항상 페이지 최상단의 "하나의 연속된 블록"이므로, 아래 패턴에 걸리는 줄이나
        #      비정상적으로 큰 줄 간격(제목-저자 블록 사이의 여백)이 나타나면 그 지점에서 수집을 중단합니다.
        SECTION_HEADER_RE = re.compile(
            r'^\(?[ivxlc\d]{1,4}\)?[\.\:\)]?\s+(introduction|abstract|related\s+work|background|'
            r'method(ology)?|conclusion|references|experiments?|results?|discussion|acknowledg|'
            r'appendix|approach|overview|preliminaries|evaluation|analysis|motivation)\b',
            re.IGNORECASE,
        )
        AUTHOR_HINT_RE = re.compile(
            r'(@|university|institute|department|school of|college of|laborator|corporation|\bltd\.?\b|\binc\.?\b)',
            re.IGNORECASE,
        )

        kept_lines = []
        prev_line_bottom = None
        prev_line_height = None
        for line_spans in line_groups:
            line_text_norm = re.sub(r'\s+', ' ', "".join(s["text"] for s in line_spans)).strip()

            if SECTION_HEADER_RE.match(line_text_norm) or AUTHOR_HINT_RE.search(line_text_norm):
                break

            line_top = min(s["bbox"][1] for s in line_spans)
            line_bottom = max(s["bbox"][3] for s in line_spans)
            line_height = line_bottom - line_top

            # 이전 줄과의 간격이 줄 높이의 2배를 넘으면 제목 블록과 분리된 다른 블록(저자/소속 등)으로 간주
            if prev_line_bottom is not None and prev_line_height and (line_top - prev_line_bottom) > prev_line_height * 2.0:
                break

            kept_lines.append(line_spans)
            prev_line_bottom = line_bottom
            prev_line_height = line_height

        sorted_spans = [s for line_spans in kept_lines for s in line_spans]
        
        # 2. 정렬된 스팬들을 결합할 때, 단어 중간에 폰트 크기 변경으로 쪼개진 스팬(gap < 2.5px)은 공백 없이 결합하고,
        #    일반적인 띄어쓰기는 공백을 유지하여 자연스러운 문장으로 결합합니다.
        title_parts = []
        for i, s in enumerate(sorted_spans):
            text = s["text"]
            lower_text = text.strip().lower()
            if lower_text in ["abstract", "introduction", "keywords", "key words"]:
                continue
            if i == 0:
                title_parts.append(text)
            else:
                prev_s = sorted_spans[i - 1]
                prev_y0 = prev_s["bbox"][1]
                curr_y0 = s["bbox"][1]
                prev_x1 = prev_s["bbox"][2]
                curr_x0 = s["bbox"][0]
                
                is_same_line = abs(curr_y0 - prev_y0) < 5.0
                gap = curr_x0 - prev_x1
                
                if is_same_line and gap < 2.5:
                    title_parts.append(text)
                else:
                    if title_parts[-1].endswith(" ") or text.startswith(" "):
                        title_parts.append(text)
                    else:
                        title_parts.append(" " + text)
            
        title_text = "".join(title_parts).strip()
        title_text = re.sub(r'\s+', ' ', title_text)
        
        # 유효한 제목 길이 제한
        if 5 <= len(title_text) <= 250:
            return title_text
    except Exception as e:
        print(f"Failed to extract title from PDF content: {e}")
        
    return ""


def get_pdf_metadata(pdf_path: str) -> Dict[str, Any]:
    """PDF 메타데이터를 반환합니다."""
    doc = fitz.open(pdf_path)
    meta = doc.metadata or {}
    page_count = len(doc)
    
    # 1. 문서 텍스트 분석을 통한 실제 논문 제목 추출 시도
    extracted_title = _extract_paper_title(doc)
    
    # 2. 메타데이터 제목 획득
    meta_title = meta.get("title", "").strip()
    
    # 3. 우선순위 결정: 추출된 제목이 있으면 최우선 사용, 없으면 메타데이터 제목 사용
    # 단, 메타데이터 제목이 무의미한 템플릿(Word, untitled 등)인 경우도 필터링
    title = ""
    if extracted_title:
        title = extracted_title
    elif meta_title:
        lower_meta = meta_title.lower()
        invalid_keywords = ["microsoft", "word", "untitled", "layout", "template", "document", "pdf", "page"]
        if not any(k in lower_meta for k in invalid_keywords) and len(meta_title) >= 4:
            title = meta_title
            
    doc.close()
    return {
        "title": title,
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


# 벡터 그림 영역으로 인정할 최소 폭/높이(포인트). extract_pdf_images()의 최종
# 그림 판별 기준(w>=60, h>=60)과 동일하게 맞춰, 이 값 미만인 작은 도형(불릿,
# 구분선 등)은 실제 그림이 아니라 장식 요소로 보고 텍스트 필터링 대상에서 제외한다.
_VECTOR_FIGURE_MIN_SIZE = 60.0

# 텍스트 블록이 그림 영역에 "속한다"고 판단하는 최소 겹침 비율. 그림 바로 옆/아래에
# 붙어 시작하는 본문 문단이 가장자리만 살짝 겹치는 경우까지 오탐하지 않도록 과반
# 이상 겹칠 때만 그림 내부 텍스트로 간주한다.
_FIGURE_OVERLAP_RATIO = 0.6


def _find_vector_figure_rects(page: "fitz.Page", drawings: Optional[list] = None) -> List[List[float]]:
    """
    페이지에서 벡터 그래픽(선/도형)만으로 그려진 다이어그램/차트 영역을 찾습니다.

    matplotlib 등으로 그려 PDF에 삽입된 그림은 래스터 이미지가 아니라 벡터
    패스(선/도형)로 구성되는 경우가 많은데, 이때 축 라벨/범례/수치 등은 실제
    PDF 텍스트 객체로 함께 삽입되어 get_text()로 그대로 추출되어 버린다.
    이 함수가 반환하는 영역은 그런 텍스트를 번역 대상 본문에서 제외하는 데
    쓰이고(extract_pages 경로), 그림 오버레이용 bbox 후보 수집(extract_pdf_images
    경로)에도 재사용된다.

    drawings를 미리 계산해 둔 경우(호출부가 이미 page.get_drawings()를 호출했다면)
    인자로 넘겨 중복 호출을 피할 수 있다.
    """
    page_width = page.rect.width
    page_height = page.rect.height

    if drawings is None:
        try:
            drawings = page.get_drawings()
        except Exception:
            return []

    vector_rects = []
    for d in drawings:
        r = d.get("rect")
        if not r:
            continue
        w = r.x1 - r.x0
        h = r.y1 - r.y0
        if w <= 0 or h <= 0:
            continue
        if w > page_width * 0.9 and h > page_height * 0.9:
            continue
        # 테두리(stroke) 없이 흰색(또는 거의 흰색)만 채운 사각형은 배경/그룹핑용
        # 투명 요소일 뿐 실제로 보이는 그림 내용이 아니므로 제외한다.
        fill = d.get("fill")
        stroke = d.get("color")
        if stroke is None and fill is not None and all(c is not None and c > 0.92 for c in fill):
            continue
        vector_rects.append([r.x0, r.y0, r.x1, r.y1])

    if not vector_rects:
        return []

    merged = merge_bboxes(vector_rects, threshold=10.0)
    return [
        r for r in merged
        if (r[2] - r[0]) >= _VECTOR_FIGURE_MIN_SIZE and (r[3] - r[1]) >= _VECTOR_FIGURE_MIN_SIZE
    ]


def _rect_mostly_inside_any(x0: float, y0: float, x1: float, y1: float, rects: List[List[float]]) -> bool:
    """(x0, y0, x1, y1) 사각형의 면적 대부분이 rects 중 하나와 겹치는지 확인합니다."""
    area = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    if area <= 0:
        return False
    for rx0, ry0, rx1, ry1 in rects:
        ix0, iy0 = max(x0, rx0), max(y0, ry0)
        ix1, iy1 = min(x1, rx1), min(y1, ry1)
        if ix1 <= ix0 or iy1 <= iy0:
            continue
        inter_area = (ix1 - ix0) * (iy1 - iy0)
        if inter_area / area >= _FIGURE_OVERLAP_RATIO:
            return True
    return False


def _crop_page_pixmap(doc: "fitz.Document", page_num: int, bbox_percent: Dict[str, float], zoom: float):
    """render_image_crop/render_image_crop_bytes가 공유하는 크롭 좌표 계산 및
    렌더링 로직입니다. 페이지 범위를 벗어나면 None을 반환합니다."""
    if page_num < 1 or page_num > doc.page_count:
        return None
    page = doc[page_num - 1]
    rect = page.rect
    x0 = rect.x0 + rect.width * (bbox_percent["left"] / 100)
    y0 = rect.y0 + rect.height * (bbox_percent["top"] / 100)
    x1 = x0 + rect.width * (bbox_percent["width"] / 100)
    y1 = y0 + rect.height * (bbox_percent["height"] / 100)
    clip = fitz.Rect(x0, y0, x1, y1)
    matrix = fitz.Matrix(zoom, zoom)
    return page.get_pixmap(matrix=matrix, clip=clip)


def render_image_crop(pdf_path: str, page_num: int, bbox_percent: Dict[str, float], output_path: str, zoom: float = 2.0) -> bool:
    """
    지정한 페이지에서 백분율 좌표(bbox_percent: left, top, width, height, extract_pdf_images와
    동일한 형식)에 해당하는 영역만 잘라 이미지로 렌더링합니다. render_cover_image와 동일한
    PyMuPDF 크롭 기법을 임의의 페이지/영역에 쓸 수 있도록 일반화한 버전입니다.
    """
    doc = fitz.open(pdf_path)
    try:
        pix = _crop_page_pixmap(doc, page_num, bbox_percent, zoom)
        if pix is None:
            return False
        pix.save(output_path)
        return True
    finally:
        doc.close()


def render_image_crop_bytes(
    pdf_path: str,
    page_num: int,
    bbox_percent: Dict[str, float],
    zoom: float = 2.0,
    min_output_width: Optional[int] = None,
    max_zoom: float = 6.0,
) -> Optional[bytes]:
    """render_image_crop과 동일한 크롭 결과를 디스크에 저장하지 않고 PNG 바이트로
    반환합니다. 지식 그래프의 Figure/Table 노드 상세보기처럼, 캐시 파일 없이
    요청 시점에 바로 이미지를 서빙하면 되는 경우에 사용합니다.

    min_output_width가 주어지면, 번호 매겨진 수식처럼 원본 영역이 아주 작은
    경우에도 최소 출력 픽셀 폭을 보장하도록 zoom을 자동으로 키운다(상한은
    max_zoom). 상세 패널에서 이미지를 패널 폭(width:100%)에 맞춰 확대
    표시하는데 원본 해상도가 낮으면 작은 영역일수록 더 심하게 흐려 보이기
    때문 - 큰 그림/표는 애초에 zoom=2.0로도 충분히 선명해 영향이 없다.
    """
    doc = fitz.open(pdf_path)
    try:
        if page_num < 1 or page_num > doc.page_count:
            return None
        effective_zoom = zoom
        if min_output_width:
            crop_width_pt = doc[page_num - 1].rect.width * (bbox_percent["width"] / 100)
            if crop_width_pt > 0:
                effective_zoom = max(zoom, min(max_zoom, min_output_width / crop_width_pt))
        pix = _crop_page_pixmap(doc, page_num, bbox_percent, effective_zoom)
        if pix is None:
            return None
        return pix.tobytes("png")
    finally:
        doc.close()


def render_page_image_base64(pdf_path: str, page_num: int, zoom: float = 1.5) -> Optional[str]:
    """
    지정한 페이지 전체를 PNG로 렌더링해 base64 문자열로 반환합니다. PDF 텍스트
    추출은 수식(LaTeX) 기호·첨자·특수문자를 자주 깨뜨리는데, vision을 지원하는
    LLM(openai/gemini/claude)에게는 추출된 텍스트와 함께 이 페이지의 실제
    스캔 이미지를 첨부해 수식 표기의 근거로 삼게 함으로써 번역 시 수식이
    원본과 어긋나는 문제를 줄인다. 디스크에 파일로 저장하지 않고 바로 LLM
    호출에 실어 보낼 수 있도록 base64로 반환한다.
    """
    doc = fitz.open(pdf_path)
    try:
        if page_num < 1 or page_num > doc.page_count:
            return None
        page = doc[page_num - 1]
        matrix = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=matrix)
        return base64.b64encode(pix.tobytes("png")).decode("ascii")
    finally:
        doc.close()


def render_cover_image(pdf_path: str, output_path: str, top_fraction: float = 0.45, zoom: float = 2.0) -> bool:
    """
    라이브러리 카드 미리보기용으로, 1페이지 상단(제목+저자+abstract가 보통 위치하는
    영역)만 잘라 이미지로 렌더링합니다. 논문마다 단 구성이 달라 abstract의 정확한
    끝 지점을 텍스트 분석으로 판별하기보다, 첫 페이지 높이의 상단 일정 비율을
    고정으로 잘라내는 실용적인 방식을 사용합니다.
    """
    doc = fitz.open(pdf_path)
    try:
        if doc.page_count == 0:
            return False
        page = doc[0]
        rect = page.rect
        clip = fitz.Rect(rect.x0, rect.y0, rect.x1, rect.y0 + rect.height * top_fraction)
        matrix = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=matrix, clip=clip)
        pix.save(output_path)
        return True
    finally:
        doc.close()


# 일부 논문은 Figure/Table/수식 번호를 아라비아 숫자 대신 로마 숫자(I, II, III, IV...)로
# 매긴다(부록 표/수식에 흔함). "IVX" 같은 무효한 조합은 배제하고 정식 로마 숫자
# 표기(1~3999)만 인정하도록 표준 로마 숫자 검증 패턴을 사용한다. 맨 앞의
# lookahead((?=[MDCLXVI]))는 그룹이 전부 빈 문자열로만 매칭되어 공백 문자열이
# "로마 숫자"로 인정되는 것을 막기 위함이다.
_ROMAN_NUMERAL_RE = r"(?=[MDCLXVI])M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})"
# 캡션 번호 뒤에 오는 문자를 제한하는 lookahead. "Table 5: ..."(구두점),
# "TABLE III"(그 자체로 줄 끝), "Table 1 Comparison..."(구두점 없이 대문자로
# 시작하는 타이틀 케이스 캡션)는 모두 허용해야 하지만, "Table 5 shows more
# results..."나 "Figure 6, we present..."처럼 본문 문단이 우연히 "Figure N"/
# "Table N"으로 시작하는 문장(번호 뒤에 소문자 동사가 곧장 이어짐)은 캡션이
# 아니므로 걸러내야 한다. re.IGNORECASE가 걸린 상태에서도 이 판별만은
# 대소문자를 구분해야 하므로 (?-i:...)로 지역 범위에서 대소문자 구분을 켠다.
_CAPTION_FOLLOW_RE = r"(?=\s*(?:[:.\-–—*]|$|(?-i:[A-Z0-9])))"
_CAPTION_RE = re.compile(
    rf"^\s*(Fig(?:ure)?|Table)\.?\s*(\d+|{_ROMAN_NUMERAL_RE})\b{_CAPTION_FOLLOW_RE}", re.IGNORECASE
)
# 수식 번호: 줄 끝에 "(3)"처럼 소괄호 숫자(또는 로마 숫자)만 단독으로 오는 경우만
# 인정한다. 인용 연도("...(2020)")와 헷갈리지 않도록 자릿수를 1~3자리로 제한한다
# (수식 번호가 999개를 넘는 논문은 사실상 없음. 반면 연도는 항상 4자리라 자동으로
# 배제됨). 로마 숫자는 대문자만 인정한다(re.IGNORECASE를 안 씀) - 본문에
# 흔한 "(i)", "(ii)" 같은 소문자 열거 표기를 수식 번호로 오인하지 않기 위함이다.
_EQUATION_LINE_RE = re.compile(rf"\((\d{{1,3}}|{_ROMAN_NUMERAL_RE})\)\s*$")


def _find_page_captions(page: "fitz.Page") -> List[Dict[str, Any]]:
    """
    페이지에서 "Figure 1", "Table 2" 처럼 캡션으로 시작하는 줄을 찾아
    (라벨, bbox, 캡션 전문) 목록으로 반환합니다. 두 단 레이아웃 등에서 캡션이
    문단 블록의 "첫 줄"이 아니라 블록 중간에 낄 수도 있어(예: 이전 문단과
    캡션이 한 블록으로 묶인 경우) 블록의 모든 줄을 훑되, 각 줄의 시작이
    캡션 패턴인 경우만 인정해 본문 중간에 우연히 나오는 경우를 배제한다.
    캡션 전문은 매칭된 줄부터 블록 끝까지의 텍스트를 이어붙여 구성한다
    (캡션이 보통 그 블록에서 끝까지 이어지는 독립된 문단이기 때문).

    반환되는 캡션 전문에는 원문에서 볼드로 표시된 구간이 마크다운(**...**)으로
    표시되어 있다(프론트엔드가 오버레이 캡션을 렌더링할 때 볼드로 되살린다).
    다만 "Figure 1" 캡션 패턴 매칭(_CAPTION_RE)은 라벨 자체가 볼드로 표시되는
    경우가 흔해(예: "**Figure 1.** ...") 마크다운 표시가 섞이면 정규식이
    실패하므로, 매칭 전용으로 별표를 제거한 버전을 따로 만들어 사용한다.
    """
    captions = []
    blocks = page.get_text("dict")["blocks"]
    for b in blocks:
        lines = b.get("lines")
        if not lines:
            continue
        line_texts = [_spans_to_bold_markdown(ln.get("spans", [])).strip() for ln in lines]
        plain_line_texts = [re.sub(r"\*+", "", t) for t in line_texts]
        for i, plain_text in enumerate(plain_line_texts):
            if not plain_text:
                continue
            m = _CAPTION_RE.match(plain_text)
            # 로마 숫자 대안 분기(_ROMAN_NUMERAL_RE)는 lookahead만으로는 빈 문자열
            # 매칭을 완전히 막지 못한다 - "Table Introduction..."처럼 로마 숫자
            # 글자(I/V/X/L/C/D/M)로 시작하는 일반 단어가 뒤따르면 숫자 그룹이
            # 빈 문자열로 매칭되고도 \b 경계 조건은 통과해버린다. group(2)가
            # 비어 있으면 실제 캡션이 아니므로 명시적으로 걸러낸다.
            if not m or not m.group(2):
                continue
            kind = "Figure" if m.group(1).lower().startswith("fig") else "Table"
            # 로마 숫자는 대소문자 상관없이 매칭되지만("fig. iv"도 허용), 프론트엔드의
            # 본문 참조 매칭과 항상 같은 대문자 표기로 라벨을 맞춰야 한다(대문자
            # 로마 숫자가 관례이므로 digit은 그대로 두고 로마 숫자만 사실상 영향받음).
            number = m.group(2).upper()
            caption_lines = lines[i:]
            caption_text = " ".join(t for t in line_texts[i:] if t).strip()
            # bbox는 매칭된 첫 줄이 아니라, caption_text와 마찬가지로 블록 끝까지
            # 이어지는 캡션 전체 줄들의 합집합으로 잡는다 - 캡션이 여러 줄에 걸쳐
            # 길게 줄바꿈되는 경우(실제 관찰됨: 설명이 긴 Table 캡션이 6~7줄까지
            # 이어짐) 첫 줄 bbox만 쓰면 실제로는 캡션이 끝나지 않은 지점을 "캡션
            # 끝"으로 오인해, 그 아래 실제 표/그림까지의 거리가 실제보다 훨씬
            # 크게 계산된다. 이 거리는 _match_caption_for_rect의 40pt 임계값
            # 판정에 쓰이는데, 부풀려진 거리 때문에 진짜 인접한 표/그림조차
            # 캡션과 매칭되지 못하고 라벨 없이 남아버리는 문제가 실측으로 확인됨.
            bx0 = min(ln["bbox"][0] for ln in caption_lines)
            by0 = min(ln["bbox"][1] for ln in caption_lines)
            bx1 = max(ln["bbox"][2] for ln in caption_lines)
            by1 = max(ln["bbox"][3] for ln in caption_lines)
            captions.append({
                "label": f"{kind} {number}",
                "bbox": (bx0, by0, bx1, by1),
                "text": caption_text[:600],
            })
            break  # 한 블록에서 캡션은 한 번만 인정 (이후 줄은 caption_text에 이미 포함됨)
    return captions


def _match_caption_for_rect(
    rect: list, captions: List[Dict[str, Any]], table_caption_below: bool = False
) -> Dict[str, Any]:
    """
    주어진 이미지/테이블 사각형과 가장 가까운 캡션을 찾아 라벨+전문을 반환합니다.
    캡션은 보통 그림 바로 아래에 위치하므로(Figure는 항상 이 방향으로 고정),
    표는 문서 전체에서 통일된 한쪽 방향(table_caption_below로 결정)에 있다고
    보고, 상하 인접 캡션 중 그 방향에 맞고 가로 범위가 겹치는 것들 가운데
    세로 거리가 가장 짧은 것을 채택합니다.

    Table 방향은 이 함수를 사각형 하나하나에 대해 호출할 때마다 다시 판단하지
    않고, extract_pdf_images가 문서 전체를 훑어 _resolve_table_caption_direction()으로
    미리 확정한 값을 table_caption_below로 넘겨받아 고정으로 쓴다. 사각형 단위로
    "관례 방향 우선 시도 후 실패하면 반대 방향도 허용" 식으로 처리했던 이전
    구현은, 표가 여러 개 연속으로 배치된 문서(캡션이 표 아래에 오는 문서)에서
    특정 표(예: Table 9)가 자기 위에 있는 "이전 표(Table 8)의 캡션"을 - 그
    캡션이 실제로는 Table 8 소유인데도 - 관례 방향(위쪽)에 맞는다는 이유만으로
    가로채 버리는 문제가 있었다(Table 8의 오버레이가 Table 9까지 통째로
    삼켜버리는 실사용 버그로 재현됨). 문서 전체에서 어느 방향이 우세한지 먼저
    통계적으로 정한 뒤 그 한 방향만 일관되게 적용하면, 애초에 "이전/다음 표의
    캡션"이 후보로 잡히는 일 자체가 없어(그 캡션은 자기 자신의 표에만 있는
    한 방향으로만 유효하므로) 이런 교차 오염이 발생하지 않는다.

    두 표가 세로로 가깝게 붙어 있을 때(예: TABLE III 바로 위에 캡션, 그
    아래 TABLE IV) 절대 거리만으로 고르면 엉뚱한 표의 캡션에 잘못 매칭되어
    두 표가 하나의 bbox로 합쳐지는 문제도 있었는데(TABLE III/IV가 하나의
    "Table IV" 오버레이로 크롭되는 버그), 이 역시 방향을 고정해 후보 자체를
    좁히는 것으로 방지된다.

    벡터 그래픽으로 그려진 다이어그램은 (숨겨진 배경 사각형 등으로 인해) 감지된
    bbox가 실제 그림 내용보다 아래/위로 더 뻗어 있어 캡션 줄과 겹쳐버리는
    경우가 있다. 이 경우 캡션을 후보에서 완전히 제외하면 매칭 자체가 실패하므로,
    사각형의 가장자리(상/하단 일정 비율 이내)에 걸친 겹침은 "사실상 인접"으로
    보고 인정하되, 이후 크롭 시 캡션 줄을 침범하지 않도록 clip_y0/clip_y1로
    잘라낼 경계를 함께 반환한다.
    """
    x0, y0, x1, y1 = rect
    edge_margin = min(30.0, (y1 - y0) * 0.35)
    best = None
    for cap in captions:
        cx0, cy0, cx1, cy1 = cap["bbox"]
        # 가로 방향 겹침 여부 확인 (캡션이 그림/표 폭 범위와 어느 정도 겹쳐야 함)
        overlap = min(x1, cx1) - max(x0, cx0)
        if overlap <= 0:
            continue
        is_table_caption = cap["label"].startswith("Table")
        # 이 캡션 종류가 이 방향(위/아래)에서 유효한지 여부. Table은 확정된
        # 문서 전체 관례(table_caption_below)를 따르고, Figure는 항상 "아래"만 허용한다.
        valid_above = (not table_caption_below) if is_table_caption else False
        valid_below = table_caption_below if is_table_caption else True
        clip_y0 = None
        clip_y1 = None
        if cy1 <= y0:
            # 캡션이 사각형 위에 있는 경우
            if not valid_above:
                continue
            dist = y0 - cy1
        elif cy0 >= y1:
            # 캡션이 사각형 아래에 있는 경우
            if not valid_below:
                continue
            dist = cy0 - y1
        elif cy1 <= y0 + edge_margin:
            # 사각형 상단 가장자리 부근까지 캡션이 파고든 경우 - 사실상 바로
            # 위에 있는 캡션으로 보고 인정하되, 캡션 끝 지점에서 잘라낸다
            if not valid_above:
                continue
            dist = 0.0
            clip_y0 = cy1
        elif cy0 >= y1 - edge_margin:
            if not valid_below:
                continue
            dist = 0.0
            clip_y1 = cy0
        else:
            continue  # 사각형 중심부까지 깊이 겹치는 캡션은 대상에서 제외
        if dist > 40.0:
            continue
        if best is None or dist < best["dist"]:
            best = {
                "label": cap["label"],
                "text": cap["text"],
                "dist": dist,
                "clip_y0": clip_y0,
                "clip_y1": clip_y1,
            }
    if best is None:
        return {"label": None, "text": None, "clip_y0": None, "clip_y1": None}
    return best


def _resolve_table_caption_direction(pages_data: "List[tuple[List[Dict[str, Any]], List[list]]]") -> bool:
    """문서 전체에서 Table 캡션이 표 "아래"(True)에 있는 관례인지, 기본값인
    "위"(False)에 있는 관례인지 판별한다.

    판별 방법: 두 가설("위" / "아래") 각각에 대해, 페이지별로 Table 캡션과
    후보 사각형(가로로 겹치고 세로 거리 40pt 이내)을 전부 나열한 뒤 거리가
    가까운 순으로 캡션 하나·사각형 하나가 서로 한 번씩만 쓰이도록(exclusive)
    그리디 매칭한다. 두 가설 중 더 많은 캡션을 성공적으로 짝지은 쪽을
    채택하고, 매칭 개수가 같으면 평균 거리가 더 가까운 쪽을 채택한다.

    exclusive 매칭이 핵심이다 - 표가 여러 개 연속으로 있는 문서에서 "이전 표의
    캡션이 우연히 다음 표와도 가깝다"는 이유로 잘못된 가설이 부풀려 매칭되는
    것을 막아준다(각 캡션은 정확히 하나의 표에만 속하므로, 틀린 가설로는
    일부 표만 우연히 맞고 나머지는 후보가 아예 없거나 이미 다른 표에 캡션을
    빼앗겨 매칭에 실패하게 된다). 문서 전체를 대상으로 하는 이유는, 페이지
    하나에 표가 한 개뿐이면 그 페이지만으로는 두 가설이 똑같이 그럴듯해
    보일 수 있기 때문이다(문서 전체는 대개 한 가지 관례로 통일되어 있음).
    """

    def count_matches(prefer_below: bool) -> "tuple[int, float]":
        candidates = []  # (dist, page_idx, cap_idx, rect_idx)
        for page_idx, (page_captions, merged_rects) in enumerate(pages_data):
            table_caps = [c for c in page_captions if c["label"].startswith("Table")]
            for ci, cap in enumerate(table_caps):
                cx0, cy0, cx1, cy1 = cap["bbox"]
                for ri, r in enumerate(merged_rects):
                    rx0, ry0, rx1, ry1 = r
                    overlap = min(cx1, rx1) - max(cx0, rx0)
                    if overlap <= 0:
                        continue
                    if prefer_below:
                        # 캡션이 사각형 아래 => 사각형이 캡션보다 위
                        if ry1 > cy0:
                            continue
                        dist = cy0 - ry1
                    else:
                        if ry0 < cy1:
                            continue
                        dist = ry0 - cy1
                    if dist > 40.0:
                        continue
                    candidates.append((dist, page_idx, ci, ri))

        candidates.sort(key=lambda t: t[0])
        used_caps = set()
        used_rects = set()
        matched = 0
        total_dist = 0.0
        for dist, page_idx, ci, ri in candidates:
            cap_key = (page_idx, ci)
            rect_key = (page_idx, ri)
            if cap_key in used_caps or rect_key in used_rects:
                continue
            used_caps.add(cap_key)
            used_rects.add(rect_key)
            matched += 1
            total_dist += dist
        return matched, total_dist

    below_matched, below_dist = count_matches(True)
    above_matched, above_dist = count_matches(False)

    if below_matched != above_matched:
        return below_matched > above_matched
    if below_matched == 0:
        return False  # 판단 근거가 전혀 없으면 기본값(위쪽) 유지
    return below_dist < above_dist


# 수식 번호가 매겨진 텍스트 줄을 중심으로 같은 수식에 속할 만한 이웃 줄을
# 흡수(absorb)할 때 쓰는 임계값. 두 종류의 실제 관찰된 오탐지를 겨냥한다:
# 1) 같은 시각적 한 줄("u_n = ... (-2b ... + I_n)   (22)")이 PyMuPDF의 line
#    재구성 과정에서 여러 line 객체로 쪼개져, 번호가 붙은 조각만 잡히고
#    앞부분이 통째로 잘리는 경우 - 세로로 겹치는(같은 행) 줄은 폭 제한 없이
#    전부 흡수한다(_EQ_ABSORB_MIN_VOVERLAP). 번호가 페이지 오른쪽 끝에
#    붙고 수식 본문은 왼쪽/가운데에서 시작하는 한 칸(single-column) 논문의
#    흔한 레이아웃에서는, 같은 한 줄의 조각들이 페이지 중앙을 넘나들며
#    걸쳐 있을 수 있어 컬럼(좌/우 절반) 구분 없이 흡수해야 한다.
# 2) 분수/피스와이즈(case) 처럼 수식이 여러 행에 걸쳐 있고, 번호가 그 중간에
#    작게 떠 있어 번호 자신의 bbox만 쓰면 숫자 하나만 확대되어 잘리는 경우 -
#    세로로 아주 가깝게 붙어 있으면서(_EQ_ABSORB_MAX_GAP) 가로로도 가깝고
#    (_EQ_ABSORB_MAX_HGAP, 컬럼 구분이 없어진 대신 이걸로 아예 다른 단(2단
#    레이아웃의 반대쪽 컬럼)의 무관한 텍스트를 붙잡지 않도록 막는다) 문단
#    본문 줄만큼 넓지는 않은(_EQ_ABSORB_MAX_WIDTH_RATIO, 페이지에서 관찰된
#    가장 넓은 줄 기준 상대값) 줄을 흡수한다. 세로 간격 임계값을 좁게 잡은
#    이유는, 문단과 수식 사이의 display-equation 여백(LaTeX 기본값 기준
#    보통 15~20pt 이상)보다는 확실히 좁고 같은 수식 내부 행간(분수
#    분자/분모, 피스와이즈 행 등 - 보통 10~14pt로 압축되어 있음)은 포함할
#    만큼만 잡아야, 문단 쪽으로는 절대 번지지 않으면서 같은 수식의 다른
#    행은 붙잡을 수 있기 때문이다.
#    다른 번호 매겨진 수식 줄 자신은 이 흡수 대상에서 항상 제외된다(아래
#    candidate_bboxes 필터) - 안 그러면 (22)/(23)/(24)처럼 촘촘히 쌓인
#    별개의 수식들이 서로 합쳐져 버린다.
_EQ_ABSORB_MIN_VOVERLAP = 0.3
_EQ_ABSORB_MAX_GAP = 12.0
_EQ_ABSORB_MAX_HGAP = 60.0
_EQ_ABSORB_MAX_WIDTH_RATIO = 0.55
_EQ_ABSORB_MAX_ITERATIONS = 8
# 컬럼 구분을 없앤 안전판: 흡수 결과가 페이지 폭의 이 비율을 넘어서면(=서로
# 무관한 두 영역을 다리처럼 이어붙였을 가능성이 큼) 그 흡수는 하지 않는다.
_EQ_ABSORB_MAX_TOTAL_WIDTH_RATIO = 0.95
# 세로 안전판(절대값, pt). 2단계 흡수는 반복될수록 매번 새로 커진 rect를
# 기준으로 다시 이웃을 찾기 때문에, 문단 줄들이 우연히 조건(폭 비율/간격)을
# 계속 만족하면 도미노처럼 한 페이지 전체를 삼킬 수 있다(실제로 로마 숫자
# 오탐지 "(MI)" 같은 의사 수식 번호에서 관찰됨). 진짜 여러 행짜리 수식은
# 아무리 커도 이 값보다 훨씬 작으므로, 이 상한은 정상적인 수식은 절대 자르지
# 않으면서 폭주만 막는다.
_EQ_ABSORB_MAX_TOTAL_HEIGHT = 120.0

# 흡수 후보 줄의 텍스트가 "일반 산문 문장"처럼 보이면(도입/설명 문장 등)
# 흡수 대상에서 제외한다. 공백으로 나눈 토큰이 일정 개수 이상이고 그중
# 다수가 순수 알파벳 단어면서, 그 알파벳 단어들 중 다수가 3글자 이상이면
# 산문으로 판정한다. 두 번째 조건(단어 길이)이 필요한 이유: "x = y (
# TALLBIT"처럼 한 글자짜리 수식 변수명(x, y)과 기호 이름이 섞인 줄도
# 토큰의 알파벳 비율만 보면 우연히 높게 나올 수 있는데("x", "y",
# "TALLBIT" 셋 다 순수 알파벳), 진짜 영어 문장은 "the", "with", "where"
# 같은 3글자 이상 단어가 다수를 차지하는 반면 수식 변수 나열은 1~2글자
# 토큰이 대부분이라 이 기준으로 구분된다. 첫 번째 조건만으로는 진짜
# 수식 구성 요소(밑줄 첨자·연산자·그리스 문자가 섞인 토큰)는 알파벳
# 비율이 낮아 이미 걸러지고, "Z t"/"x = y" 같은 아주 짧은 변수 나열은
# 토큰 수 자체가 적어 걸러진다. 실제 논문 PDF에서 "The process can be
# expressed as", "where MHA stands for..." 같은 수식 직전/직후 짧은
# 문장이 폭 비율 가드(아래 _EQ_ABSORB_MAX_WIDTH_RATIO)만으로는 걸러지지
# 않고 거의 항상 흡수되는 문제를 이 판별로 막는다.
_PROSE_WORD_RE = re.compile(r"^[A-Za-z]+$")
_EQ_PROSE_MIN_WORDS = 3
_EQ_PROSE_MIN_ALPHA_RATIO = 0.6
_EQ_PROSE_MIN_LONG_WORD_RATIO = 0.5

# 페이지 상/하단 여백에 있는 페이지 쪽수(running header/footer)는 짧고
# 고립된 토큰이라 폭 비율 가드(_EQ_ABSORB_MAX_WIDTH_RATIO)를 쉽게
# 통과하고, 수식이 페이지 하단 가까이에 있으면 간격(gap)도 작아 그대로
# 흡수되는 문제가 실제 논문 PDF에서 재현되었다(페이지 하단 쪽수 "7"이
# 수식 바로 아래에 함께 캡처됨). 표 구분선 탐지에 이미 쓰이고 있는 동일
# 관례(페이지 상/하단 65pt 이내 = 헤더/푸터 영역)를 그대로 재사용한다.
_EQ_PAGE_MARGIN_EXCLUDE = 65.0


_MATH_OPERATOR_RE = re.compile(r"[=≈≠≤≥±∑∫∏√∇∂∈∉⊂⊆∪∩→⇒↦]")


def _looks_like_prose(text: str) -> bool:
    # "=" 같은 수식 연산자가 한 글자라도 있으면 산문일 수 없다(진짜 문장에는
    # 거의 등장하지 않음) - 무조건 흡수 후보로 남긴다. 이 가드가 없으면
    # "r = rcode + rformat."처럼 언더스코어가 빠진 채 추출된 첨자 변수명
    # (rcode, rformat)이 우연히 길이 3자 이상의 순수 알파벳 단어 조건을
    # 만족해 산문으로 오판되고, 정작 그 줄에 붙어야 할 수식 번호 "(9)"만
    # 따로 떨어져 나가 번호 하나만 확대된 아주 작은 오버레이가 되던 문제가
    # 실제 논문 PDF에서 재현됨.
    if _MATH_OPERATOR_RE.search(text):
        return False
    words = text.split()
    if len(words) < _EQ_PROSE_MIN_WORDS:
        return False
    alpha_words = [w.strip(",.;:") for w in words]
    alpha_words = [w for w in alpha_words if _PROSE_WORD_RE.match(w)]
    if len(alpha_words) < len(words) * _EQ_PROSE_MIN_ALPHA_RATIO:
        return False
    long_words = [w for w in alpha_words if len(w) >= 3]
    return len(long_words) >= len(alpha_words) * _EQ_PROSE_MIN_LONG_WORD_RATIO


def _vertical_overlap_ratio(a: list, b: list) -> float:
    """_horizontal_overlap_ratio와 대칭인 세로 버전 - 더 좁은 쪽 높이를
    기준으로 한 세로 겹침 비율(0~1)."""
    inter = min(a[3], b[3]) - max(a[1], b[1])
    if inter <= 0:
        return 0.0
    narrower_height = min(a[3] - a[1], b[3] - b[1])
    return inter / narrower_height if narrower_height > 0 else 0.0


def _horizontal_gap(a: list, b: list) -> float:
    """_vertical_gap과 대칭인 가로 버전 - 두 사각형의 가로 간격을 반환한다.
    겹치면 -1."""
    if a[2] <= b[0]:
        return b[0] - a[2]
    if b[2] <= a[0]:
        return a[0] - b[2]
    return -1.0


def _find_page_equations(page: "fitz.Page") -> List[Dict[str, Any]]:
    """
    번호가 매겨진 수식(예: "... = mc^2   (3)")을 찾아 오버레이 대상 bbox를 반환합니다.

    수식 번호가 붙은 텍스트 줄 하나의 bbox만 그대로 쓰면 두 가지 방식으로
    틀어질 수 있다: (1) PyMuPDF가 같은 시각적 한 줄을 여러 line 객체로 쪼개
    번호가 포함된 조각만 잡히거나(수식 앞부분이 잘림), (2) 분수/피스와이즈처럼
    수식이 여러 행에 걸쳐 있는데 번호 자신의 작은 bbox만 잡혀 숫자만 확대되어
    보인다. 두 경우 모두 "번호 붙은 줄과 같은 수식에 속할 만한 이웃 줄"을
    찾아 흡수(absorb)하는 문제로 통일해서 푼다 - 그림/표 서브패널을 묶는
    로직(_PANEL_ABSORB_*)과 같은 반복 흡수 패턴을 재사용한다.
    """
    page_width = page.rect.width
    page_height = page.rect.height
    blocks = page.get_text("dict")["blocks"]

    all_lines = []  # (x0, y0, x1, y1) - 페이지 내 모든 텍스트 줄
    line_texts: Dict[tuple, str] = {}  # bbox -> 그 줄의 텍스트 (산문 판별용)
    candidates = []  # (line_bbox, number)
    column_blocks = []  # _detect_two_column이 기대하는 (x0,y0,x1,y1,text) 블록 목록
    for b in blocks:
        block_text_parts = []
        body_bbox = None  # 번호가 붙은 줄을 제외한 "본문" 줄들의 합집합 bbox
        for ln in b.get("lines", []):
            bbox = ln.get("bbox")
            if not bbox:
                continue
            all_lines.append(bbox)
            line_text = "".join(span.get("text", "") for span in ln.get("spans", [])).strip()
            line_texts[tuple(bbox)] = line_text
            block_text_parts.append(line_text)
            if not line_text:
                continue
            m = _EQUATION_LINE_RE.search(line_text)
            if m and m.group(1):
                candidates.append((bbox, m.group(1)))
                continue  # 번호 붙은 줄 자신은 아래 본문 bbox 계산에서 제외
            if body_bbox is None:
                body_bbox = list(bbox)
            else:
                body_bbox[0] = min(body_bbox[0], bbox[0])
                body_bbox[1] = min(body_bbox[1], bbox[1])
                body_bbox[2] = max(body_bbox[2], bbox[2])
                body_bbox[3] = max(body_bbox[3], bbox[3])
        # 2단 레이아웃 판정용 블록 bbox는 번호가 붙은 줄을 제외한 "본문"
        # 부분만으로 계산한다. PyMuPDF 블록 단위에서는 수식 본문+번호가 한
        # 블록으로 합쳐지는데, 번호가 페이지 오른쪽 끝 여백까지 멀리 붙어
        # 있어 블록 bbox 전체를 쓰면 폭이 넓어지고 중심이 오른쪽으로 쏠린다
        # - 페이지 폭의 55~60% 정도면 "wide" 블록 판정(_WIDE_BLOCK_RATIO=0.6)
        # 문턱을 살짝 못 넘어 "right" 컬럼 블록으로 잘못 집계되고, 수식이
        # 많은 페이지에서는 이런 블록만으로 2단 레이아웃 문턱(각 200자)을
        # 넘기면서 실제로는 1단인 논문이 2단으로 오판되는 문제가 실제로
        # 있었다. 번호가 붙은 줄만 있고 본문 줄이 아예 없는 블록(body_bbox
        # 없음)은 열 판정에 기여할 정보가 없으므로 건너뛴다 - 통째로
        # 제외하면 실제 2단 논문에서 그 블록이 속한 컬럼의 글자 수 집계가
        # 너무 줄어 2단 감지 자체가 실패하는 회귀가 있었다(문단 안에서
        # 우연히 줄바꿈이 "(MI)"처럼 괄호로 끝나 오탐지되는 경우, 그 문단의
        # 나머지 줄들은 여전히 진짜 컬럼 신호이기 때문).
        if body_bbox is not None:
            column_blocks.append((body_bbox[0], body_bbox[1], body_bbox[2], body_bbox[3], "".join(block_text_parts)))

    # 2단 레이아웃인 페이지에서만 좌/우 컬럼을 구분해 흡수를 제한한다(아래
    # same_column 헬퍼). 1단 레이아웃 논문은 수식 본문이 왼쪽에서 시작해
    # 오른쪽 끝 번호까지 페이지 중앙(page_width/2)을 자연스럽게 넘나들 수
    # 있어 컬럼 구분 자체가 무의미하다 - Equation 22 케이스(원본 버그) 참고.
    # 반대로 진짜 2단 논문에서는 좌/우 컬럼이 같은 줄 그리드를 공유해 같은
    # y좌표에 서로 무관한 텍스트가 놓이는 일이 흔하므로, 컬럼 구분 없이
    # 흡수하면 "(MI)"처럼 수식이 아닌 괄호 약어(로마 숫자 오탐지)가 양쪽
    # 컬럼의 문단 텍스트를 통째로 삼켜버리는 문제가 있었다.
    is_two_column = _detect_two_column(column_blocks, page_width)

    def _same_column(a_center_x: float, ln: tuple) -> bool:
        if not is_two_column:
            return True
        return ((ln[0] + ln[2]) / 2 < page_width / 2) == (a_center_x < page_width / 2)

    # 다른 번호 매겨진 수식 줄 자신은 절대 흡수 대상이 되면 안 된다 - 안 그러면
    # (22)/(23)/(24)처럼 촘촘히 쌓인 서로 다른 수식들이 gap 임계값 안에 들어와
    # 하나로 합쳐져버린다. bbox 좌표값 자체로 동일 줄을 식별해 제외한다(같은
    # get_text("dict") 호출 결과에서 그대로 가져온 값이라 부동소수점 오차
    # 없이 정확히 일치한다).
    candidate_bboxes = {bbox for bbox, _ in candidates}


    # ── 1단계: 같은 행(row) 재구성 ──────────────────────────────────────
    # PyMuPDF가 한 시각적 줄을 여러 line 객체로 쪼갠 경우를 먼저 확정적으로
    # 묶는다. 이 단계를 먼저 끝내야, (22) 자신의 행에 속한 조각들
    # ("u_n = ...", "-2b ...")이 2단계(아래)에서 (23)의 근접-흡수에 잘못
    # 딸려가지 않는다 - 어느 수식의 "행"에 속하는지가 애매하지 않은
    # 유일한 축(세로 겹침)을 먼저 소진시켜, 각 조각이 정확히 한 수식에만
    # 배타적으로 귀속되게 한다.
    row_groups: List[set] = []
    row_rects: List[list] = []
    for cbbox, _ in candidates:
        lx0, ly0, lx1, ly1 = cbbox
        eq_center_x = (lx0 + lx1) / 2
        rect = [lx0, ly0, lx1, ly1]
        group = {cbbox}
        for _ in range(_EQ_ABSORB_MAX_ITERATIONS):
            absorbed_any = False
            for ln in all_lines:
                if ln in group or ln in candidate_bboxes:
                    continue
                if not _same_column(eq_center_x, ln):
                    continue
                # 전체 폭(컬럼 마진-투-마진)에 가까운 줄은 justified 문단
                # 특유의 폭이지 같은 행에서 쪼개진 수식 조각일 수 없다. 이
                # 가드가 없으면, 세로로 유난히 큰 줄(억양 부호·합/적분 기호
                # 렌더링 등) 하나가 먼저 흡수되며 rect 세로 범위가 급격히
                # 커지고, 그 순간 위/아래 문단 줄과도 새로 겹침 비율
                # 임계값을 넘겨버려 다음 반복에서 또 흡수되는 도미노가
                # 실제 논문 PDF에서 재현되었다(문단+섹션 제목까지 통째로
                # 캡처됨).
                if ln[2] - ln[0] >= page_width * _WIDE_BLOCK_RATIO:
                    continue
                if _looks_like_prose(line_texts.get(tuple(ln), "")):
                    continue
                # 페이지 여백(_EQ_PAGE_MARGIN_EXCLUDE) 배제는 여기서는 필요
                # 없다 - 1단계는 세로 겹침 비율로만 판단하는데, 페이지
                # 쪽수(footer)는 수식 본문과 같은 행에 있을 수 없어(항상
                # 아래쪽에 별도로 떨어져 있음) 애초에 겹침 조건을 만족하지
                # 않는다. 여기서 필터를 걸면 수식 자신이 페이지 하단
                # 여백 가까이 있을 때 진짜 같은 행 조각까지 함께 배제되는
                # 회귀가 생긴다 - 아래 2단계에서만 적용한다.
                if _vertical_overlap_ratio(rect, ln) >= _EQ_ABSORB_MIN_VOVERLAP:
                    group.add(ln)
                    rect[0] = min(rect[0], ln[0])
                    rect[1] = min(rect[1], ln[1])
                    rect[2] = max(rect[2], ln[2])
                    rect[3] = max(rect[3], ln[3])
                    absorbed_any = True
            if not absorbed_any:
                break
        row_groups.append(group)
        row_rects.append(rect)

    # 각 후보의 행 재구성은 서로 독립적으로 계산되기 때문에, 억양 부호(¯ 등)가
    # 붙은 글자처럼 줄의 bbox가 유난히 위/아래로 큰 경우 그 줄 하나가 "자기
    # 수식의 번호"와도 겹치고 "바로 아래 다른 수식의 번호"와도 겹쳐 두 수식
    # 모두에 중복으로 흡수될 수 있다(실제 관찰됨 - (22)의 본문 줄이 (23)에도
    # 잘못 흡수됨). 겹치는 줄은 "자기 자신의 원래 후보 줄"과 겹침 비율이 가장
    # 높은 쪽에만 남기고 나머지에서는 제거한 뒤, 줄어든 그룹의 rect를 남은
    # 구성원만으로 다시 계산한다.
    line_owner_indices: Dict[tuple, List[int]] = {}
    for idx, group in enumerate(row_groups):
        for ln in group:
            line_owner_indices.setdefault(ln, []).append(idx)

    shrunk_indices = set()
    for ln, owner_indices in line_owner_indices.items():
        if len(owner_indices) <= 1:
            continue
        best_idx = max(owner_indices, key=lambda i: _vertical_overlap_ratio(candidates[i][0], ln))
        for i in owner_indices:
            if i != best_idx:
                row_groups[i].discard(ln)
                shrunk_indices.add(i)

    for idx in shrunk_indices:
        group = row_groups[idx]
        row_rects[idx] = [
            min(g[0] for g in group), min(g[1] for g in group),
            max(g[2] for g in group), max(g[3] for g in group),
        ]

    # ── 2단계: 여러 행에 걸친 수식(분수/피스와이즈 등) 흡수 ───────────────
    # 세로로 아주 가깝고 문단 줄만큼 넓지 않은 이웃 줄을 추가로 흡수하되,
    # 다른 수식의 행(1단계에서 이미 확정된 row_groups)에 속한 줄은 절대
    # 건드리지 않는다 - 안 그러면 촘촘히 쌓인 서로 다른 수식끼리 다리처럼
    # 이어붙는 문제가 생긴다.
    equations = []
    for idx, (cbbox, number) in enumerate(candidates):
        eq_center_x = (cbbox[0] + cbbox[2]) / 2
        own_group = row_groups[idx]
        other_groups_union = set().union(*(g for i, g in enumerate(row_groups) if i != idx)) if len(row_groups) > 1 else set()
        rect = list(row_rects[idx])
        remaining = [
            list(ln) for ln in all_lines
            if ln not in own_group and ln not in other_groups_union and ln not in candidate_bboxes
            and _same_column(eq_center_x, ln)
        ]
        # 문단 본문 줄의 전형적인 폭 추정치 - 반드시 이 수식과 같은 컬럼(2단
        # 레이아웃이면 좌/우 중 한쪽, 1단이면 페이지 전체)에서 관찰된 "진짜
        # 한 컬럼 안에 들어가는" 줄들 중 가장 넓은 것을 기준으로 삼아야 한다.
        # Figure/Table 캡션처럼 두 컬럼을 가로질러 페이지 폭 대부분을 차지하는
        # 줄(_WIDE_BLOCK_RATIO 이상)은 _same_column 판정이 중심점 하나로만
        # 좌/우를 가르다 보니 우연히 "같은 컬럼"으로 분류될 수 있는데, 이런
        # wide 줄을 기준으로 삼으면 임계값이 페이지 폭 절반 가까이까지
        # 커져버려 문단의 온전한 줄까지 전부 "수식만큼 좁다"고 잘못 판단해
        # 흡수해버린다(실제 관찰된 회귀 - Figure 캡션 때문에 문단 전체가
        # 수식 크롭에 딸려 들어감).
        column_widths = [
            ln[2] - ln[0] for ln in remaining
            if ln[2] - ln[0] < page_width * _WIDE_BLOCK_RATIO
        ]
        column_width_estimate = max(column_widths) if column_widths else page_width

        for _ in range(_EQ_ABSORB_MAX_ITERATIONS):
            if not remaining:
                break
            absorbed_any = False
            still_remaining = []
            for ln in remaining:
                # 폭이 좁아 아래 width 가드는 통과하지만("The process can be
                # expressed as" 같은 짧은 도입/설명 문장) 명백히 산문인 줄은
                # 수식 구성 요소가 아니므로 제외한다. 실제 논문 PDF에서
                # 수식 직전/직후의 짧은 문장이 gap·width 조건을 모두
                # 통과해 거의 항상 흡수되는 문제를 막는다.
                if _looks_like_prose(line_texts.get(tuple(ln), "")):
                    still_remaining.append(ln)
                    continue
                # 페이지 상/하단 여백(running header/footer 영역)에 걸친
                # 줄은 폭이 좁아 width 가드를 쉽게 통과하고, 수식이 페이지
                # 가장자리 가까이 있으면 gap도 작아 그대로 흡수되기 쉽다
                # (페이지 하단 쪽수가 수식 바로 아래에 함께 캡처되는 문제가
                # 실제 논문 PDF에서 재현됨).
                if ln[1] < _EQ_PAGE_MARGIN_EXCLUDE or ln[3] > page_height - _EQ_PAGE_MARGIN_EXCLUDE:
                    still_remaining.append(ln)
                    continue
                merged_x0 = min(rect[0], ln[0])
                merged_x1 = max(rect[2], ln[2])
                merged_y0 = min(rect[1], ln[1])
                merged_y1 = max(rect[3], ln[3])
                if (
                    merged_x1 - merged_x0 > page_width * _EQ_ABSORB_MAX_TOTAL_WIDTH_RATIO
                    or merged_y1 - merged_y0 > _EQ_ABSORB_MAX_TOTAL_HEIGHT
                ):
                    still_remaining.append(ln)
                    continue

                v_gap = _vertical_gap(rect, ln)
                h_gap = _horizontal_gap(rect, ln)
                width = ln[2] - ln[0]
                # v_gap < 0은 이미 겹친다는 뜻(1단계 겹침 비율 임계값에는 못
                # 미쳤지만 어느 정도 겹치는 경우 포함) - "붙어 있다"는 점에서
                # 작은 양(+) 간격보다 오히려 더 가까우므로 그대로 통과시킨다.
                same_construct = (
                    v_gap <= _EQ_ABSORB_MAX_GAP
                    and h_gap <= _EQ_ABSORB_MAX_HGAP
                    and width <= column_width_estimate * _EQ_ABSORB_MAX_WIDTH_RATIO
                )
                if same_construct:
                    rect[0] = merged_x0
                    rect[1] = merged_y0
                    rect[2] = merged_x1
                    rect[3] = merged_y1
                    absorbed_any = True
                else:
                    still_remaining.append(ln)
            remaining = still_remaining
            if not absorbed_any:
                break

        equations.append({
            "label": f"Equation {number}",
            "bbox": rect,
        })
    return equations


def _vertical_gap(a: list, b: list) -> float:
    """두 사각형의 세로 간격을 반환한다. 겹치면 -1."""
    if a[3] <= b[1]:
        return b[1] - a[3]
    if b[3] <= a[1]:
        return a[1] - b[3]
    return -1.0


def _horizontal_overlap_ratio(a: list, b: list) -> float:
    """더 좁은 쪽 폭을 기준으로 한 가로 겹침 비율(0~1)."""
    inter = min(a[2], b[2]) - max(a[0], b[0])
    if inter <= 0:
        return 0.0
    narrower_width = min(a[2] - a[0], b[2] - b[0])
    return inter / narrower_width if narrower_width > 0 else 0.0


# 라벨(캡션)에 매칭되지 못한 인접 사각형을 흡수할 때 허용하는 최대 세로 간격.
# "(a) DeiT.", "(b) TimeSformer." 처럼 여러 행(row)의 서브패널로 구성된 큰
# 그림은 캡션과 맨 아래 패널까지의 거리는 멀어도(캡션 매칭용 40pt를 훌쩍
# 넘음), 패널들 자기들끼리는 촘촘히 붙어 있으므로 이 값은 캡션 매칭
# 임계값(40pt)과 동일하게 맞춘다.
_PANEL_ABSORB_MAX_GAP = 40.0
_PANEL_ABSORB_MIN_OVERLAP = 0.5


def _has_caption_between(y0: float, y1: float, captions: List[Dict[str, Any]]) -> bool:
    """두 y좌표 사이에 캡션 줄(예: "TABLE III")의 중심이 존재하는지 확인합니다.

    booktabs 구분선 체이닝(아래 2-2 섹션)이 표 하나의 top/mid/bottom rule을
    묶으려는 의도인데, 인접 임계값(100pt)이 표 내부 줄 간격보다 관대해서 캡션
    하나만 사이에 두고 붙어 있는 서로 다른 두 표까지 하나의 체인으로 묶어버리는
    경우가 있었다(예: Table II/III/IV가 좁은 컬럼에 촘촘히 이어질 때 셋이
    하나의 거대한 사각형으로 합쳐져 그중 캡션 하나에만 라벨이 붙고 나머지 표는
    오버레이가 아예 안 만들어짐). 두 구분선 사이에 캡션이 끼어 있다면 그 지점은
    항상 표 경계이므로, 체인을 여기서 끊어야 한다.
    """
    for cap in captions:
        cy0, cy1 = cap["bbox"][1], cap["bbox"][3]
        if y0 < (cy0 + cy1) / 2 < y1:
            return True
    return False


def extract_pdf_images(pdf_path: str) -> List[Dict[str, Any]]:
    """
    PDF의 각 페이지에서 실제 그림/이미지(Figure) 및 테이블(Table)의 영역 정보를 추출합니다.
    인접한 이미지/테이블 요소를 그룹화(Merge)하고 마진(Padding)을 주어 크롭 시 잘림 현상을 방지합니다.
    가능한 경우 근처 캡션("Figure 1", "Table 2" 등)을 찾아 label로 함께 반환합니다.

    캡션-사각형 매칭(4단계)은 문서 전체에서 Table 캡션이 어느 방향(위/아래)에
    있는 관례인지를 먼저 확정한 뒤에야 할 수 있다(_resolve_table_caption_direction
    참고 - 페이지 단위로 그때그때 판단하면 인접한 두 표가 서로의 캡션을
    가로채는 문제가 생긴다). 그래서 이 함수는 두 단계로 나뉜다: 1단계에서
    모든 페이지를 훑어 캡션/후보 사각형만 모으고, 방향을 확정한 뒤, 2단계에서
    그 방향을 적용해 실제 매칭·그룹화·출력을 수행한다.
    """
    doc = fitz.open(pdf_path)
    images_data = []

    # ── 1단계: 모든 페이지의 캡션과 후보 사각형을 먼저 수집 ──
    pages_data = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        page_width = page.rect.width
        page_height = page.rect.height
        if page_width == 0 or page_height == 0:
            pages_data.append(None)
            continue

        page_captions = _find_page_captions(page)
        raw_rects = []

        # 1. 래스터 이미지(Raster Images) 좌표 수집
        page_imgs = page.get_image_info(xrefs=True)
        for img in page_imgs:
            bbox = img.get("bbox")
            if not bbox:
                continue
            x0, y0, x1, y1 = bbox
            w = x1 - x0
            h = y1 - y0
            if w >= 15 and h >= 15:
                raw_rects.append([x0, y0, x1, y1])
                
        # 2-1. 내장 테이블 Finder 감지
        try:
            finder = page.find_tables()
            if finder and finder.tables:
                for table in finder.tables:
                    bbox = table.bbox
                    x0, y0, x1, y1 = bbox
                    w = x1 - x0
                    h = y1 - y0
                    if w >= 15 and h >= 15:
                        raw_rects.append([x0, y0, x1, y1])
        except Exception:
            pass

        # 2-2. 가로 테이블 구분선(booktabs 등) 감지 Heuristic
        drawings = []
        try:
            drawings = page.get_drawings()
            horizontal_lines = []
            for d in drawings:
                r = d.get("rect")
                if not r:
                    continue
                w = r.x1 - r.x0
                h = r.y1 - r.y0
                if w > 80 and h < 3: # 가로 방향 얇은 선 수집
                    # running header / footer 필터링: 페이지 상단 65pt 이내 또는 하단 65pt 이내의 선 제외
                    if r.y0 < 65 or r.y1 > page_height - 65:
                        continue
                    horizontal_lines.append([r.x0, r.y0, r.x1, r.y1])
            
            if len(horizontal_lines) >= 2:
                # 가로 정렬도(overlap ratio) 기반의 alignment families 그룹화
                families = []
                for line in horizontal_lines:
                    placed = False
                    for fam in families:
                        rep = fam[0] # Family 대표 선
                        # 두 선의 수평 겹침 비율(overlap ratio) 계산
                        intersection = max(0.0, min(line[2], rep[2]) - max(line[0], rep[0]))
                        union = max(line[2], rep[2]) - min(line[0], rep[0])
                        ratio = intersection / union if union > 0.0 else 0.0
                        
                        if ratio > 0.85:
                            fam.append(line)
                            placed = True
                            break
                    if not placed:
                        families.append([line])
                
                # 각 패밀리 내부에서 세로 방향 인접 선들을 그룹화
                for fam in families:
                    if len(fam) < 2:
                        continue
                    fam.sort(key=lambda x: x[1])
                    
                    table_groups = []
                    current_group = [fam[0]]
                    for line in fam[1:]:
                        last_line = current_group[-1]
                        y_diff = line[1] - last_line[3]

                        # 인접 임계값(100pt) 안이어도 두 선 사이에 캡션이 끼어
                        # 있으면 서로 다른 표의 경계이므로 체인을 끊는다.
                        if y_diff < 100 and not _has_caption_between(last_line[3], line[1], page_captions):
                            current_group.append(line)
                        else:
                            table_groups.append(current_group)
                            current_group = [line]
                    table_groups.append(current_group)

                    # booktabs 스타일 표는 상단 규칙(top rule)-헤더 구분선(header rule)은
                    # 서로 가까이 붙어 있지만, 데이터 행이 많으면 맨 아래 규칙(bottom
                    # rule)까지의 거리가 100pt를 훌쩍 넘는 경우가 실제로 있다(실측:
                    # 데이터 행 없이 top+header rule만 17pt 간격, bottom rule까지는
                    # 173pt). 이런 경우 위 100pt 임계값 때문에 bottom rule 혼자만의
                    # group으로 떨어져 나가고, 아래 len(group)>=2 필터에 걸려 완전히
                    # 버려진다 - 그러면 표의 세로 범위가 top/header rule 사이의
                    # 얇은 띠 하나로만 잡혀, 실제 표 본문(데이터 행 전체)이 오버레이
                    # 범위에서 통째로 빠지는 문제가 있었다. 캡션이 사이에 끼지 않은
                    # (=서로 다른 표의 경계가 아닌) 단독 선 group은 직전 group에
                    # 이어붙여, 이 단독 선을 "먼 아래쪽 bottom rule"로 인정한다.
                    merged_groups: list = []
                    for group in table_groups:
                        if (
                            len(group) == 1
                            and merged_groups
                            and not _has_caption_between(
                                merged_groups[-1][-1][3], group[0][1], page_captions
                            )
                        ):
                            merged_groups[-1].append(group[0])
                        else:
                            merged_groups.append(group)

                    for group in merged_groups:
                        if len(group) >= 2:
                            gx0 = min(l[0] for l in group)
                            gy0 = min(l[1] for l in group)
                            gx1 = max(l[2] for l in group)
                            gy1 = max(l[3] for l in group)
                            raw_rects.append([gx0, gy0, gx1, gy1])
        except Exception:
            pass

        # 2-3. 벡터 그래픽으로 그려진 다이어그램/차트 감지. 아키텍처 다이어그램처럼
        # 래스터 이미지가 아니라 선/도형(벡터 패스)만으로 그려진 그림은
        # get_image_info()로 잡히지 않아 이전 단계들을 모두 건너뛴다.
        raw_rects.extend(_find_vector_figure_rects(page, drawings=drawings))

        # 3. 바운딩 박스 그룹화 (인접 임계값을 4.0포인트로 대폭 좁혀서 과도하게 커지는 현상 방지)
        merged_rects = merge_bboxes(raw_rects, threshold=4.0)

        pages_data.append((page_num, page_width, page_height, page_captions, merged_rects))

    # ── 방향 확정: 문서 전체의 Table 캡션/사각형 배치를 보고 한 번만 결정한다 ──
    table_caption_below = _resolve_table_caption_direction(
        [(pd[3], pd[4]) for pd in pages_data if pd is not None]
    )

    # ── 2단계: 확정된 방향으로 실제 매칭·그룹화·출력 ──
    for entry in pages_data:
        if entry is None:
            continue
        page_num, page_width, page_height, page_captions, merged_rects = entry
        page = doc[page_num]

        # 4. 캡션 매칭 - 그림이 여러 서브플롯(sub-panel)으로 나뉘어 그려진
        # 경우(예: "왼쪽/오른쪽" 두 그래프로 구성된 Figure), 각 서브플롯이
        # 독립된 사각형으로 감지되어 같은 캡션 하나에 개별적으로 매칭될 수
        # 있다. 이걸 그대로 각각 별도 항목으로 내보내면 프론트엔드가 그중
        # 하나만 골라 써서(예: 왼쪽 패널만 보이고 오른쪽이 통째로 잘려나감)
        # 오버레이가 실제 그림 전체를 담지 못하는 문제가 있었다. 따라서 같은
        # 라벨로 매칭된 사각형들은 최종적으로 하나의 bbox로 합친다.
        label_groups: Dict[str, Dict[str, Any]] = {}
        unlabeled_rects = []

        for r in merged_rects:
            # 캡션 매칭은 패딩을 적용하기 전 원본 사각형 기준으로 수행 (더 정확한 인접도 판단)
            match = _match_caption_for_rect(r, page_captions, table_caption_below=table_caption_below)

            # 벡터 다이어그램 등에서 감지된 사각형이 실제 그림 내용보다 아래/위로
            # 더 뻗어 있어 캡션 줄과 겹쳤던 경우, 캡션 경계에서 잘라내 크롭이
            # 캡션 텍스트까지 침범하지 않도록 한다.
            rect_y0, rect_y1 = r[1], r[3]
            if match.get("clip_y1") is not None:
                rect_y1 = min(rect_y1, match["clip_y1"])
            if match.get("clip_y0") is not None:
                rect_y0 = max(rect_y0, match["clip_y0"])
            clipped = [r[0], rect_y0, r[2], rect_y1]

            label = match["label"]
            if not label:
                unlabeled_rects.append(clipped)
                continue
            if label in label_groups:
                g = label_groups[label]["rect"]
                g[0] = min(g[0], clipped[0])
                g[1] = min(g[1], clipped[1])
                g[2] = max(g[2], clipped[2])
                g[3] = max(g[3], clipped[3])
            else:
                label_groups[label] = {"rect": clipped, "text": match["text"]}

        # 4-1. 캡션과 멀리 떨어져 있어(예: 여러 행(row)의 서브패널로 구성된 큰
        # 그림에서 맨 윗 패널) 라벨 매칭에는 실패했지만, 이미 라벨이 붙은
        # 사각형과 촘촘히 붙어 있는(세로 간격이 작고 가로로 많이 겹치는)
        # 미매칭 사각형은 같은 그림의 일부로 보고 흡수한다. 한 번 흡수하면
        # 그룹의 bbox가 커져 다음 패널과도 새로 인접할 수 있으므로 더 이상
        # 흡수할 것이 없을 때까지 반복한다.
        #
        # Table 흡수는 "위쪽"만 허용한다 - 예를 들어 여러 개의 작은 서브테이블로
        # 구성된 ablation 표(예: "(a) Structure design", "(b) Tube size" 등을
        # 하나의 "Table 4" 캡션이 맨 아래에서 묶는 경우)는 캡션과 가장 가까운
        # 서브테이블만 라벨이 매칭되고, 캡션에서 먼 위쪽 서브테이블은 라벨 없이
        # 남는다. 이런 경우 라벨이 붙은 뭉치 바로 위에 촘촘히 붙어 있는 미매칭
        # 사각형은 같은 표의 일부로 보고 흡수해도 안전하다.
        #
        # 반대로 "아래쪽" 흡수는 절대 허용하면 안 된다 - 페이지 폭 전체를
        # 차지하는 표(Table III 등) 바로 아래 40pt 이내에 있는, 전혀 무관한
        # 다른 표/그림(예: 옆 칸에 나란히 놓인 Table IV의 차트)까지 "가로로
        # 많이 겹친다"는 이유로 잘못 흡수해버리는 문제가 있었다 - 겹침 비율이
        # 더 좁은 쪽(흡수 대상) 폭 기준이라, 폭이 넓은 표는 그 아래 있는
        # 어떤 좁은 요소와도 쉽게 "많이 겹치는" 것으로 계산되기 때문이다.
        # Figure는 기존과 동일하게 위/아래 양방향 모두 허용한다.
        changed = True
        while changed and unlabeled_rects:
            changed = False
            still_unlabeled = []
            for u in unlabeled_rects:
                absorbed = False
                for label, g in label_groups.items():
                    rect = g["rect"]
                    if label.startswith("Table") and u[3] > rect[1]:
                        continue
                    gap = _vertical_gap(rect, u)
                    if gap < 0 or gap > _PANEL_ABSORB_MAX_GAP:
                        continue
                    if _horizontal_overlap_ratio(rect, u) < _PANEL_ABSORB_MIN_OVERLAP:
                        continue
                    rect[0] = min(rect[0], u[0])
                    rect[1] = min(rect[1], u[1])
                    rect[2] = max(rect[2], u[2])
                    rect[3] = max(rect[3], u[3])
                    absorbed = True
                    changed = True
                    break
                if not absorbed:
                    still_unlabeled.append(u)
            unlabeled_rects = still_unlabeled

        def _emit(rect: list, label: Optional[str], caption_text: Optional[str]) -> None:
            # 여백(Padding) 8포인트 적용하여 차트 라벨이나 테이블 테두리가 잘리지 않도록 안전 확보
            x0 = max(0.0, rect[0] - 8.0)
            y0 = max(0.0, rect[1] - 8.0)
            x1 = min(page_width, rect[2] + 8.0)
            y1 = min(page_height, rect[3] + 8.0)

            w = x1 - x0
            h = y1 - y0
            # 최종 크기가 가로/세로 40포인트 이상인 진짜 그림/테이블만 선별
            if w < 40 or h < 40:
                return

            images_data.append({
                "page": page_num + 1,
                "left": (x0 / page_width) * 100,
                "top": (y0 / page_height) * 100,
                "width": (w / page_width) * 100,
                "height": (h / page_height) * 100,
                "label": label,
                "caption": caption_text,
            })

        for label, g in label_groups.items():
            _emit(g["rect"], label, g["text"])
        for rect in unlabeled_rects:
            _emit(rect, None, None)

        # 5. 번호 매겨진 수식 - 그림/표와 달리 별도 그래픽 영역이 아니라 텍스트 한
        # 줄이므로, 위의 40pt 최소 크기 필터를 거치지 않고 그 줄의 bbox에 작은
        # 패딩만 적용해 바로 추가한다.
        for eq in _find_page_equations(page):
            ex0, ey0, ex1, ey1 = eq["bbox"]
            x0 = max(0.0, ex0 - 4.0)
            y0 = max(0.0, ey0 - 4.0)
            x1 = min(page_width, ex1 + 4.0)
            y1 = min(page_height, ey1 + 4.0)
            w = x1 - x0
            h = y1 - y0
            if w <= 0 or h <= 0:
                continue

            images_data.append({
                "page": page_num + 1,
                "left": (x0 / page_width) * 100,
                "top": (y0 / page_height) * 100,
                "width": (w / page_width) * 100,
                "height": (h / page_height) * 100,
                "label": eq["label"],
                "caption": None,
            })

    doc.close()
    return images_data

