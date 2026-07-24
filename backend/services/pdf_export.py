"""
번역/주석(하이라이트·밑줄·메모)이 포함된 PDF 내보내기.

하이라이트/밑줄/메모는 브라우저 localStorage에만 저장되고 백엔드에는 전혀
없다 - 그래서 이 기능은 프론트엔드가 내보내기 요청 시 그 데이터를 함께
보내야 하고(POST body), 서버는 PyMuPDF(fitz)로 그 정보를 원본 PDF 위에
실제 PDF 주석 객체로 구워 넣은 뒤, 번역 텍스트와 메모 요약을 별도 섹션으로
이어붙여 하나의 PDF로 합쳐 반환한다.

브라우저에서 저장하는 하이라이트/밑줄은 문자 offset(해당 페이지 textLayer
기준)이 아니라 원본 텍스트 문자열 자체도 함께 저장하므로, PDF 좌표계로
직접 변환하는 대신 PyMuPDF의 page.search_for()로 그 문자열을 페이지에서
찾아 위치(quad)를 알아내는 방식을 쓴다 - pdf.js와 PyMuPDF의 텍스트 추출
결과가 100% 동일하지는 않아 완벽하지 않지만, 대부분의 경우 잘 맞고 실패해도
그 항목만 조용히 건너뛴다(전체 내보내기가 실패하지 않음).
"""

import base64
import io
import re
from html import escape as html_escape
from typing import Optional

import fitz
from matplotlib import mathtext
from matplotlib.font_manager import FontProperties
from PIL import Image

_HIGHLIGHT_DEFAULT_COLOR = (1, 0.92, 0.23)  # 노랑
_UNDERLINE_DEFAULT_COLOR = (0.93, 0.26, 0.26)  # 빨강

# PyMuPDF 내장 CJK 폰트 - 기본 14종 폰트(helv 등)는 한글 글리프가 없어
# "??"로만 표시되므로, 한글이 섞인 텍스트는 반드시 이 폰트를 써야 한다.
_KOREAN_TEXTBOX_FONT = "korea"

# 번역 텍스트 안의 "**볼드**" 및 "$인라인 수식$"/"$$블록 수식$$" 를 찾기 위한
# 패턴. $$...$$를 $...$보다 먼저 시도해야 블록 수식이 인라인으로 잘못
# 쪼개지지 않는다.
_FORMULA_SPLIT_RE = re.compile(r"(\$\$.+?\$\$|\$[^$\n]+?\$)", re.DOTALL)
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
# matplotlib mathtext에 내장된 수식용 폰트는 한글 글리프가 없어(뷰어의 KaTeX와
# 달리 시스템 폰트로 대체되지 않음) 한글이 섞인 "수식"을 렌더링하면 네모 박스
# (tofu)로 깨진다. 번역 모델이 `\text{여기서 ...}`처럼 수식 안에 한글 설명을
# 끼워 넣는 경우가 실제로 있어, 이런 세그먼트는 이미지 렌더링을 시도하지 않고
# 일반 텍스트로 안전하게 대체한다.
_HANGUL_RE = re.compile(r"[가-힣]")


def _hex_to_rgb01(hex_color: Optional[str], fallback: tuple) -> tuple:
    if not hex_color:
        return fallback
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        return fallback
    try:
        r = int(hex_color[0:2], 16) / 255
        g = int(hex_color[2:4], 16) / 255
        b = int(hex_color[4:6], 16) / 255
        return (r, g, b)
    except ValueError:
        return fallback


def _apply_annotations_to_page(page: fitz.Page, annotations: list) -> None:
    """이 페이지에 저장된 하이라이트/밑줄을 실제 PDF 주석으로 굽는다."""
    for ann in annotations:
        text = (ann.get("text") or "").strip()
        ann_type = ann.get("type")
        if not text or ann_type not in ("highlight", "underline"):
            continue

        color = _hex_to_rgb01(
            ann.get("color"),
            _HIGHLIGHT_DEFAULT_COLOR if ann_type == "highlight" else _UNDERLINE_DEFAULT_COLOR,
        )
        try:
            # 개행이 포함된 긴 인용은 검색이 실패하기 쉬우므로 공백으로 정규화
            search_text = " ".join(text.split())
            quads = page.search_for(search_text, quads=True)
        except Exception:
            quads = []
        if not quads:
            continue

        try:
            if ann_type == "highlight":
                annot = page.add_highlight_annot(quads)
            else:
                annot = page.add_underline_annot(quads)
            annot.set_colors(stroke=color)
            annot.update()
        except Exception:
            continue


def _run_story_pages(html: str) -> fitz.Document:
    """HTML을 fitz.Story로 흘려보내 필요한 만큼 자동으로 페이지를 나눈
    새 PDF 문서를 만들어 반환한다 (한글 포함 텍스트도 자연스럽게 렌더링됨)."""
    buf = io.BytesIO()
    story = fitz.Story(html=html)
    writer = fitz.DocumentWriter(buf)
    mediabox = fitz.paper_rect("a4")
    where = mediabox + (48, 48, -48, -48)

    more = 1
    while more:
        device = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(device)
        writer.end_page()
    writer.close()

    buf.seek(0)
    return fitz.open("pdf", buf.read())


def _render_formula_img_tag(formula: str, fontsize: float) -> Optional[str]:
    """LaTeX 수식 문자열을 matplotlib의 mathtext로 렌더링해 <img> 태그로
    반환한다. PyMuPDF의 Story/insert_htmlbox HTML 엔진은 MathML/LaTeX를 전혀
    해석하지 못해(렌더링해보면 태그와 수식 구조가 통째로 사라지고 글자만
    나열됨) 수식을 이렇게 별도 이미지로 만들어 끼워 넣지 않으면 뷰어에서
    보던 수식이 원문 그대로의 "$", "\\frac" 같은 깨진 텍스트로 노출된다.

    렌더링에 실패하면(mathtext가 지원하지 않는 LaTeX 명령 등) None을 반환해
    호출부가 원문 텍스트로라도 대체할 수 있게 한다 - 전체 내보내기가
    실패하면 안 되므로.
    """
    formula = formula.strip()
    if not formula:
        return None
    try:
        dpi = 200
        buf = io.BytesIO()
        mathtext.math_to_image(f"${formula}$", buf, dpi=dpi, prop=FontProperties(size=fontsize), format="png")
        png_bytes = buf.getvalue()
        with Image.open(io.BytesIO(png_bytes)) as im:
            px_w, px_h = im.size
        pt_w, pt_h = px_w / dpi * 72, px_h / dpi * 72
        b64 = base64.b64encode(png_bytes).decode("ascii")
        # PyMuPDF의 HTML 엔진은 <img>에 vertical-align을 적용하지 않아(테스트로
        # 확인) 이미지 하단이 텍스트 기준선에 맞춰진다 - 수식이 줄 높이보다
        # 커서 살짝 위로 떠 보일 수 있지만, 원문 그대로의 깨진 LaTeX 텍스트보다는
        # 훨씬 낫다.
        return f'<img src="data:image/png;base64,{b64}" width="{pt_w:.1f}" height="{pt_h:.1f}">'
    except Exception:
        return None


def _plain_text_with_bold_to_html(text: str) -> str:
    """"**볼드**" 마크다운만 처리하는 일반 텍스트 -> HTML 변환 (수식이 아닌
    구간, 그리고 한글이 섞여 렌더링할 수 없는 "가짜 수식" 구간에 공통으로 쓴다)."""
    parts = []
    pos = 0
    for m in _BOLD_RE.finditer(text):
        parts.append(html_escape(text[pos:m.start()]))
        parts.append(f"<b>{html_escape(m.group(1))}</b>")
        pos = m.end()
    parts.append(html_escape(text[pos:]))
    return "".join(parts)


def _inline_content_to_html(text: str, fontsize: float) -> str:
    """"**볼드**"와 "$인라인 수식$"/"$$블록 수식$$"이 섞인 한 문단 텍스트를,
    HTML 이스케이프된 일반 텍스트 + <b> + 수식 이미지가 섞인 HTML로 변환한다."""
    html_parts = []
    for chunk in _FORMULA_SPLIT_RE.split(text):
        if not chunk:
            continue
        is_block = chunk.startswith("$$") and chunk.endswith("$$")
        is_inline = not is_block and chunk.startswith("$") and chunk.endswith("$")
        if is_block or is_inline:
            formula = chunk.strip("$")
            # 한글이 섞인 "수식"(예: \text{여기서 ...})은 mathtext 폰트에 한글
            # 글리프가 없어 렌더링해도 네모 박스로 깨지므로 애초에 이미지로
            # 만들지 않는다.
            img_tag = None if _HANGUL_RE.search(formula) else _render_formula_img_tag(
                formula, fontsize=fontsize * (1.25 if is_block else 1.0)
            )
            if img_tag:
                html_parts.append(
                    f'<div style="text-align:center; margin:4pt 0;">{img_tag}</div>' if is_block else img_tag
                )
            else:
                # 렌더링을 시도하지 않았거나 실패한 경우, 전체 내보내기를 막지
                # 않도록 "$" 구분자만 뗀 원문을 일반 텍스트로 대체 표시한다.
                html_parts.append(_plain_text_with_bold_to_html(formula))
            continue

        html_parts.append(_plain_text_with_bold_to_html(chunk))
    return "".join(html_parts)


def _build_page_translation_html(text: str) -> str:
    """한 페이지 분량의 번역 전문을 문단 단위 HTML로 변환한다 (뷰어의 번역
    패널과 나란히 놓일 페이지이므로 문서 제목/페이지 번호 같은 반복 헤더는
    넣지 않는다 - 원본 페이지 쪽에 이미 그 정보가 그대로 보이기 때문)."""
    fontsize = 10.5
    parts = ['<div style="font-family: sans-serif;">']
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if para:
            parts.append(
                f'<p style="font-size: {fontsize}pt; line-height: 1.6; text-align: justify;">'
                f'{_inline_content_to_html(para, fontsize)}</p>'
            )
    parts.append("</div>")
    return "".join(parts)


def _build_memo_html(memos: dict) -> Optional[str]:
    entries = []
    for page_key in sorted(memos.keys(), key=lambda k: int(k.replace("page_", "")) if k.replace("page_", "").isdigit() else 0):
        page_num = page_key.replace("page_", "")
        for memo in memos.get(page_key, []):
            content = (memo.get("content") or "").strip()
            if not content:
                continue
            anchor = (memo.get("sentenceText") or "").strip()
            entries.append((page_num, anchor, content))

    if not entries:
        return None

    parts = [
        '<div style="font-family: sans-serif;">',
        '<h2 style="font-size: 16pt;">메모 (Memos)</h2>',
    ]
    for page_num, anchor, content in entries:
        parts.append(f'<h4 style="font-size: 11pt; margin-top: 14pt; margin-bottom: 2pt; color: #333;">{page_num}페이지</h4>')
        if anchor:
            snippet = anchor[:150] + ("…" if len(anchor) > 150 else "")
            parts.append(f'<p style="font-size: 9.5pt; color: #888; margin: 0 0 3pt; font-style: italic;">"{html_escape(snippet)}"</p>')
        parts.append(f'<p style="font-size: 10.5pt; line-height: 1.5; margin-top: 0;">{html_escape(content)}</p>')
    parts.append("</div>")
    return "".join(parts)


def _add_translation_pair_pages(out_doc: fitz.Document, src_doc: fitz.Document, translations: dict) -> None:
    """뷰어 화면(원문 | 번역 나란히 배치)과 동일한 모양으로, 원본 페이지마다
    같은 크기의 출력 페이지를 만들어 왼쪽엔 원본 페이지를(show_pdf_page로
    벡터 그대로 삽입 - 래스터화하지 않으므로 텍스트 선택/검색 그대로 유지),
    오른쪽엔 그 페이지의 번역 전문을 배치한다.

    원문과의 1:1 페어링(같은 페이지 번호 = 같은 출력 페이지)을 항상 유지하기
    위해, 번역이 원본 페이지 한 장 분량보다 길어도 별도 페이지로 넘기지
    않는다. 대신 insert_htmlbox(scale_low=0)로 필요한 만큼 글자 크기를
    무제한 축소해서라도 반드시 한 페이지 오른쪽 절반 안에 다 들어가게 한다.
    """
    for page_idx in range(src_doc.page_count):
        src_page = src_doc[page_idx]
        sr = src_page.rect
        translation_text = (translations.get(str(page_idx + 1)) or "").strip()

        pair_page = out_doc.new_page(width=sr.width * 2, height=sr.height)
        left_rect = fitz.Rect(0, 0, sr.width, sr.height)
        pair_page.show_pdf_page(left_rect, src_doc, page_idx)

        right_rect = fitz.Rect(sr.width, 0, sr.width * 2, sr.height) + (16, 16, -16, -16)
        if not translation_text:
            pair_page.insert_textbox(
                right_rect,
                "(번역 없음)",
                fontsize=10.5, color=(0.6, 0.6, 0.6), fontname=_KOREAN_TEXTBOX_FONT,
            )
            continue

        pair_page.insert_htmlbox(right_rect, _build_page_translation_html(translation_text), scale_low=0)


def generate_annotated_pdf(
    pdf_path: str,
    annotations: dict,
    translations: dict,
    memos: dict,
) -> bytes:
    """원본 PDF에 하이라이트/밑줄을 구워 넣고, 뷰어 화면처럼 원문과 번역을
    페이지마다 나란히(pair) 배치한 뒤, 메모 섹션을 이어붙인 최종 PDF를
    바이트로 반환한다.

    annotations: {"page_1": [{"type", "text", "color"}, ...], ...} (프론트 localStorage 형식)
    translations: {"1": "번역 텍스트", ...} (페이지 번호 -> 번역 전문)
    memos: {"page_1": [{"content", "sentenceText"}, ...], ...} (프론트 localStorage 형식)
    """
    src_doc = fitz.open(pdf_path)

    for page_key, page_annotations in (annotations or {}).items():
        m = re.match(r"page_(\d+)$", page_key)
        if not m:
            continue
        page_idx = int(m.group(1)) - 1
        if 0 <= page_idx < src_doc.page_count and page_annotations:
            _apply_annotations_to_page(src_doc[page_idx], page_annotations)

    out_doc = fitz.open()

    if translations:
        _add_translation_pair_pages(out_doc, src_doc, translations)
    else:
        # 번역이 없으면 페어링할 대상이 없으므로 원본 페이지만 그대로 담는다.
        out_doc.insert_pdf(src_doc)

    memo_html = _build_memo_html(memos or {})
    if memo_html:
        memo_doc = _run_story_pages(memo_html)
        out_doc.insert_pdf(memo_doc)
        memo_doc.close()

    result = out_doc.tobytes(garbage=4, deflate=True)
    out_doc.close()
    src_doc.close()
    return result
