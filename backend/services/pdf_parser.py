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
        line_text = "".join(parts)
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
        def sort_spans_by_reading_order(spans_list):
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
            
            flat = []
            for line_item in lines_list:
                flat.extend(line_item)
            return flat

        sorted_spans = sort_spans_by_reading_order(title_spans)
        
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


_CAPTION_RE = re.compile(r"^\s*(Fig(?:ure)?|Table)\.?\s*(\d+)\b\.?\s*[:.\-]?\s*", re.IGNORECASE)
# 수식 번호: 줄 끝에 "(3)"처럼 소괄호 숫자만 단독으로 오는 경우만 인정한다. 인용
# 연도("...(2020)")와 헷갈리지 않도록 자릿수를 1~3자리로 제한한다(수식 번호가
# 999개를 넘는 논문은 사실상 없음. 반면 연도는 항상 4자리라 자동으로 배제됨).
_EQUATION_LINE_RE = re.compile(r"\((\d{1,3})\)\s*$")


def _find_page_captions(page: "fitz.Page") -> List[Dict[str, Any]]:
    """
    페이지에서 "Figure 1", "Table 2" 처럼 캡션으로 시작하는 줄을 찾아
    (라벨, bbox, 캡션 전문) 목록으로 반환합니다. 두 단 레이아웃 등에서 캡션이
    문단 블록의 "첫 줄"이 아니라 블록 중간에 낄 수도 있어(예: 이전 문단과
    캡션이 한 블록으로 묶인 경우) 블록의 모든 줄을 훑되, 각 줄의 시작이
    캡션 패턴인 경우만 인정해 본문 중간에 우연히 나오는 경우를 배제한다.
    캡션 전문은 매칭된 줄부터 블록 끝까지의 텍스트를 이어붙여 구성한다
    (캡션이 보통 그 블록에서 끝까지 이어지는 독립된 문단이기 때문).
    """
    captions = []
    blocks = page.get_text("dict")["blocks"]
    for b in blocks:
        lines = b.get("lines")
        if not lines:
            continue
        line_texts = [
            "".join(span.get("text", "") for span in ln.get("spans", [])).strip()
            for ln in lines
        ]
        for i, line_text in enumerate(line_texts):
            if not line_text:
                continue
            m = _CAPTION_RE.match(line_text)
            if not m:
                continue
            kind = "Figure" if m.group(1).lower().startswith("fig") else "Table"
            number = m.group(2)
            caption_text = " ".join(t for t in line_texts[i:] if t).strip()
            captions.append({
                "label": f"{kind} {number}",
                "bbox": lines[i]["bbox"],
                "text": caption_text[:600],
            })
            break  # 한 블록에서 캡션은 한 번만 인정 (이후 줄은 caption_text에 이미 포함됨)
    return captions


def _match_caption_for_rect(rect: list, captions: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    주어진 이미지/테이블 사각형과 가장 가까운 캡션을 찾아 라벨+전문을 반환합니다.
    캡션은 보통 그림 바로 아래, 표는 바로 위에 위치하므로 상하 인접 캡션을 모두
    후보로 보되, 가로 범위가 겹치고 세로 거리가 가장 짧은 것을 채택합니다.

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
        clip_y0 = None
        clip_y1 = None
        if cy0 >= y1:
            dist = cy0 - y1  # 캡션이 아래에 있는 경우 (Figure)
        elif cy1 <= y0:
            dist = y0 - cy1  # 캡션이 위에 있는 경우 (Table)
        elif cy0 >= y1 - edge_margin:
            # 사각형 하단 가장자리 부근까지 캡션이 파고든 경우 - 사실상 바로
            # 아래에 있는 캡션으로 보고 인정하되, 캡션 시작 지점에서 잘라낸다
            dist = 0.0
            clip_y1 = cy0
        elif cy1 <= y0 + edge_margin:
            dist = 0.0
            clip_y0 = cy1
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


def _find_page_equations(page: "fitz.Page") -> List[Dict[str, Any]]:
    """
    번호가 매겨진 수식(예: "... = mc^2   (3)")을 찾아 오버레이 대상 bbox를 반환합니다.

    수식 번호 "(N)"는 텍스트로 존재하지만, 그 앞의 실제 수식 본문(분수/합/적분
    기호 등)은 번호 자체보다 훨씬 크고 - 특히 세로로 - 수식 번호 한 글자 줄의
    bbox만 그대로 쓰면 번호만 딱 잘려 보이는 문제가 있었다. 이를 보정하기 위해:
    - 세로: 위/아래로 가장 가까운 다른 텍스트 줄까지의 중간 지점까지 확장해,
      본문 문단과 수식 사이의 여백(display equation 특유의 공백)을 최대한 포함한다.
    - 가로: 페이지에서 같은 쪽(2단 레이아웃이면 좌/우 중 같은 쪽)에 속한 주변
      줄들의 최소 x0을 찾아, 수식 번호만이 아니라 수식 본문이 시작되는 좌측
      여백까지 폭을 넓힌다.
    """
    page_width = page.rect.width
    blocks = page.get_text("dict")["blocks"]

    all_lines = []  # (x0, y0, x1, y1) - 페이지 내 모든 텍스트 줄
    candidates = []  # (line_bbox, number)
    for b in blocks:
        for ln in b.get("lines", []):
            bbox = ln.get("bbox")
            if not bbox:
                continue
            all_lines.append(bbox)
            line_text = "".join(span.get("text", "") for span in ln.get("spans", [])).strip()
            if not line_text:
                continue
            m = _EQUATION_LINE_RE.search(line_text)
            if m:
                candidates.append((bbox, m.group(1)))

    equations = []
    for (lx0, ly0, lx1, ly1), number in candidates:
        eq_center_x = (lx0 + lx1) / 2
        on_left_half = eq_center_x < page_width / 2

        # 같은 쪽(컬럼)에 속하면서 수식 자신의 줄은 아닌 다른 텍스트 줄들
        same_side_lines = [
            (ox0, oy0, ox1, oy1) for (ox0, oy0, ox1, oy1) in all_lines
            if ((ox0 + ox1) / 2 < page_width / 2) == on_left_half
            and not (abs(oy0 - ly0) < 0.5 and abs(oy1 - ly1) < 0.5)
        ]

        above = [ln for ln in same_side_lines if ln[3] <= ly0 + 1]
        below = [ln for ln in same_side_lines if ln[1] >= ly1 - 1]
        nearest_above_bottom = max((ln[3] for ln in above), default=None)
        nearest_below_top = min((ln[1] for ln in below), default=None)

        # 위/아래 인접 줄까지의 중간 지점으로 확장 (너무 멀면 - 즉 그 사이에 다른
        # 여백/그림이 있을 수 있으므로 - 최대 40pt까지만 확장)
        if nearest_above_bottom is not None and ly0 - nearest_above_bottom < 80:
            y0 = (nearest_above_bottom + ly0) / 2
        else:
            y0 = max(0.0, ly0 - 40.0)
        if nearest_below_top is not None and nearest_below_top - ly1 < 80:
            y1 = (ly1 + nearest_below_top) / 2
        else:
            y1 = ly1 + 40.0

        # 세로로 40pt 이내에 있는 같은 쪽 줄들 중 가장 왼쪽 x0을 수식 본문의
        # 좌측 여백으로 채택 (수식 번호 자신의 x0보다 훨씬 왼쪽일 가능성이 높음)
        nearby_left_edges = [
            ox0 for (ox0, oy0, ox1, oy1) in same_side_lines
            if not (oy1 < ly0 - 40 or oy0 > ly1 + 40)
        ]
        x0 = min(nearby_left_edges) if nearby_left_edges else lx0

        equations.append({
            "label": f"Equation {number}",
            "bbox": [x0, y0, lx1, y1],
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


def extract_pdf_images(pdf_path: str) -> List[Dict[str, Any]]:
    """
    PDF의 각 페이지에서 실제 그림/이미지(Figure) 및 테이블(Table)의 영역 정보를 추출합니다.
    인접한 이미지/테이블 요소를 그룹화(Merge)하고 마진(Padding)을 주어 크롭 시 잘림 현상을 방지합니다.
    가능한 경우 근처 캡션("Figure 1", "Table 2" 등)을 찾아 label로 함께 반환합니다.
    """
    doc = fitz.open(pdf_path)
    images_data = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        page_width = page.rect.width
        page_height = page.rect.height
        if page_width == 0 or page_height == 0:
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
                        
                        if y_diff < 100: # 인접 임계값 100pt
                            current_group.append(line)
                        else:
                            table_groups.append(current_group)
                            current_group = [line]
                    table_groups.append(current_group)
                    
                    for group in table_groups:
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
        # get_image_info()로 잡히지 않아 이전 단계들을 모두 건너뛴다. 페이지
        # 전체를 덮는 배경/테두리 장식 요소를 그림으로 오인하지 않도록 개별
        # drawing이 페이지의 90%를 넘는 경우는 제외하고, 서로 인접한 벡터 조각들
        # (화살표, 박스, 선 등)을 넉넉한 임계값으로 하나의 다이어그램으로 묶는다.
        try:
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
                # 투명 요소일 뿐 실제로 보이는 그림 내용이 아니므로 제외한다 (그대로
                # 두면 다이어그램 앞에 깔린 흰 배경판 크기만큼 bbox가 과도하게
                # 커져서, 예를 들어 바로 아래의 캡션 줄까지 침범하는 문제가 있었다).
                fill = d.get("fill")
                stroke = d.get("color")
                if stroke is None and fill is not None and all(c is not None and c > 0.92 for c in fill):
                    continue
                vector_rects.append([r.x0, r.y0, r.x1, r.y1])

            if vector_rects:
                merged_vector = merge_bboxes(vector_rects, threshold=10.0)
                for r in merged_vector:
                    w = r[2] - r[0]
                    h = r[3] - r[1]
                    # 구분선/불릿 등 작은 장식 요소는 제외하고, 의미 있는 크기의
                    # 다이어그램/차트로 보이는 클러스터만 그림 후보로 채택
                    if w >= 60 and h >= 60:
                        raw_rects.append(r)
        except Exception:
            pass

        # 3. 바운딩 박스 그룹화 (인접 임계값을 4.0포인트로 대폭 좁혀서 과도하게 커지는 현상 방지)
        merged_rects = merge_bboxes(raw_rects, threshold=4.0)
        
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
            match = _match_caption_for_rect(r, page_captions)

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
        changed = True
        while changed and unlabeled_rects:
            changed = False
            still_unlabeled = []
            for u in unlabeled_rects:
                absorbed = False
                for g in label_groups.values():
                    rect = g["rect"]
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

