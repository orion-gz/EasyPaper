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

import io
import re
from html import escape as html_escape
from typing import Optional

import fitz

_HIGHLIGHT_DEFAULT_COLOR = (1, 0.92, 0.23)  # 노랑
_UNDERLINE_DEFAULT_COLOR = (0.93, 0.26, 0.26)  # 빨강

# PyMuPDF 내장 CJK 폰트 - 기본 14종 폰트(helv 등)는 한글 글리프가 없어
# "??"로만 표시되므로, 한글이 섞인 텍스트는 반드시 이 폰트를 써야 한다.
_KOREAN_TEXTBOX_FONT = "korea"


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


def _run_story_pages(html: str, page_width: Optional[float] = None, page_height: Optional[float] = None) -> fitz.Document:
    """HTML을 fitz.Story로 흘려보내 필요한 만큼 자동으로 페이지를 나눈
    새 PDF 문서를 만들어 반환한다 (한글 포함 텍스트도 자연스럽게 렌더링됨).

    page_width/page_height를 지정하면 그 크기로 페이지를 생성한다 - 원본 PDF
    페이지와 나란히 배치(pair)할 번역 페이지를 원본과 동일한 크기로 맞추기
    위해 사용한다. 지정하지 않으면 기존처럼 A4 고정 크기를 쓴다.
    """
    buf = io.BytesIO()
    story = fitz.Story(html=html)
    writer = fitz.DocumentWriter(buf)
    if page_width and page_height:
        mediabox = fitz.Rect(0, 0, page_width, page_height)
        margin = min(48.0, page_width * 0.08, page_height * 0.08)
    else:
        mediabox = fitz.paper_rect("a4")
        margin = 48.0
    where = mediabox + (margin, margin, -margin, -margin)

    more = 1
    while more:
        device = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(device)
        writer.end_page()
    writer.close()

    buf.seek(0)
    return fitz.open("pdf", buf.read())


def _build_page_translation_html(text: str) -> str:
    """한 페이지 분량의 번역 전문을 문단 단위 HTML로 변환한다 (뷰어의 번역
    패널과 나란히 놓일 페이지이므로 문서 제목/페이지 번호 같은 반복 헤더는
    넣지 않는다 - 원본 페이지 쪽에 이미 그 정보가 그대로 보이기 때문)."""
    parts = ['<div style="font-family: sans-serif;">']
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if para:
            parts.append(f'<p style="font-size: 10.5pt; line-height: 1.6; text-align: justify;">{html_escape(para)}</p>')
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

    번역 텍스트가 원본 페이지 한 장 분량보다 길어 한 페이지에 다 들어가지
    않으면(_run_story_pages가 여러 페이지로 나눠 반환), 첫 페이지만 오른쪽
    절반에 배치하고 나머지는 "번역 계속" 전용 페이지로 바로 뒤에 이어붙인다.
    """
    for page_idx in range(src_doc.page_count):
        src_page = src_doc[page_idx]
        sr = src_page.rect
        translation_text = (translations.get(str(page_idx + 1)) or "").strip()

        pair_page = out_doc.new_page(width=sr.width * 2, height=sr.height)
        left_rect = fitz.Rect(0, 0, sr.width, sr.height)
        pair_page.show_pdf_page(left_rect, src_doc, page_idx)

        right_rect = fitz.Rect(sr.width, 0, sr.width * 2, sr.height)
        if not translation_text:
            pair_page.insert_textbox(
                right_rect + (16, 16, -16, -16),
                "(번역 없음)",
                fontsize=10.5, color=(0.6, 0.6, 0.6), fontname=_KOREAN_TEXTBOX_FONT,
            )
            continue

        trans_doc = _run_story_pages(
            _build_page_translation_html(translation_text),
            page_width=sr.width, page_height=sr.height,
        )
        try:
            if trans_doc.page_count > 0:
                pair_page.show_pdf_page(right_rect, trans_doc, 0)
                if trans_doc.page_count > 1:
                    out_doc.insert_pdf(trans_doc, from_page=1)
        finally:
            trans_doc.close()


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
