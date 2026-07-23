"""services/pdf_export.py 테스트 - 번역/하이라이트/밑줄/메모가 포함된 PDF 생성."""

import fitz
import pytest

from services.pdf_export import generate_annotated_pdf


@pytest.fixture()
def sample_pdf(tmp_path):
    """2페이지짜리 간단한 영문 PDF를 만들어 경로를 반환한다."""
    doc = fitz.open()
    p1 = doc.new_page()
    p1.insert_textbox(
        fitz.Rect(50, 50, 545, 700),
        "Transformer Architecture\n\nThe transformer relies on self-attention mechanisms.",
        fontsize=12, fontname="helv",
    )
    p2 = doc.new_page()
    p2.insert_textbox(
        fitz.Rect(50, 50, 545, 700),
        "Results\n\nOur experiments show strong performance.",
        fontsize=12, fontname="helv",
    )
    path = tmp_path / "source.pdf"
    doc.save(str(path))
    doc.close()
    return str(path)


def test_generate_pdf_preserves_original_pages(sample_pdf):
    result = generate_annotated_pdf(sample_pdf, {}, {}, {})
    doc = fitz.open("pdf", result)
    assert doc.page_count == 2  # 주석/번역/메모가 전부 없으면 원본 페이지 수 그대로
    doc.close()


def test_generate_pdf_bakes_highlight_annotation(sample_pdf):
    annotations = {"page_1": [{"type": "highlight", "text": "self-attention mechanisms", "color": "#eab308"}]}
    result = generate_annotated_pdf(sample_pdf, annotations, {}, {})
    doc = fitz.open("pdf", result)
    page1_annots = list(doc[0].annots())
    assert len(page1_annots) == 1
    assert page1_annots[0].type[1] == "Highlight"
    doc.close()


def test_generate_pdf_bakes_underline_annotation(sample_pdf):
    annotations = {"page_1": [{"type": "underline", "text": "self-attention mechanisms", "color": "#ef4444"}]}
    result = generate_annotated_pdf(sample_pdf, annotations, {}, {})
    doc = fitz.open("pdf", result)
    page1_annots = list(doc[0].annots())
    assert len(page1_annots) == 1
    assert page1_annots[0].type[1] == "Underline"
    doc.close()


def test_generate_pdf_skips_annotation_when_text_not_found(sample_pdf):
    """페이지에 없는 문구를 하이라이트하려 해도 예외 없이 조용히 건너뛰어야 한다."""
    annotations = {"page_1": [{"type": "highlight", "text": "this text does not exist anywhere", "color": "#eab308"}]}
    result = generate_annotated_pdf(sample_pdf, annotations, {}, {})
    doc = fitz.open("pdf", result)
    assert len(list(doc[0].annots())) == 0
    doc.close()


def test_generate_pdf_pairs_original_and_translation_per_page(sample_pdf):
    """뷰어 화면처럼 원문과 번역이 페이지마다 나란히(같은 출력 페이지의 좌/우)
    배치되어야 한다 - 번역을 별도 섹션으로 뒤에 이어붙이는 대신."""
    translations = {
        "1": "트랜스포머 아키텍처는 셀프 어텐션 메커니즘에 의존합니다.",
        "2": "우리의 실험은 강력한 성능을 보여줍니다.",
    }
    result = generate_annotated_pdf(sample_pdf, {}, translations, {})
    doc = fitz.open("pdf", result)
    # 각 번역이 원본 페이지 절반 폭에 다 들어가는 짧은 텍스트이므로, 페이지
    # 수는 원본과 동일하게 유지되고(번역용 페이지가 뒤에 추가되지 않음)
    assert doc.page_count == 2

    src = fitz.open(sample_pdf)
    src_page_width = src[0].rect.width
    src.close()
    # 출력 페이지는 원본 폭의 2배(좌: 원문, 우: 번역)여야 한다
    assert doc[0].rect.width == pytest.approx(src_page_width * 2, rel=0.01)

    page1_text = doc[0].get_text()
    assert "self-attention mechanisms" in page1_text  # 왼쪽: 원문 그대로(벡터 삽입, 텍스트 추출 가능)
    assert "셀프 어텐션" in page1_text  # 오른쪽: 같은 페이지에 번역이 나란히
    doc.close()


def test_generate_pdf_shows_placeholder_for_page_without_translation(sample_pdf):
    """일부 페이지만 번역이 있는 경우, 번역이 없는 페이지는 페어링이 깨지지
    않도록 안내 문구만 표시하고 페이지 자체는 그대로 유지해야 한다."""
    translations = {"1": "트랜스포머 아키텍처는 셀프 어텐션 메커니즘에 의존합니다."}
    result = generate_annotated_pdf(sample_pdf, {}, translations, {})
    doc = fitz.open("pdf", result)
    assert doc.page_count == 2
    assert "번역 없음" in doc[1].get_text()
    assert "Results" in doc[1].get_text()  # 왼쪽 원문은 그대로 보여야 함
    doc.close()


def test_generate_pdf_appends_memo_page(sample_pdf):
    memos = {"page_1": [{"content": "이 부분이 핵심입니다.", "sentenceText": "self-attention mechanisms"}]}
    result = generate_annotated_pdf(sample_pdf, {}, {}, memos)
    doc = fitz.open("pdf", result)
    assert doc.page_count > 2

    full_text = "".join(page.get_text() for page in doc)
    assert "이 부분이 핵심입니다" in full_text
    doc.close()


def test_generate_pdf_with_no_memo_content_adds_no_memo_page(sample_pdf):
    """memo content가 비어있으면 메모 섹션 자체를 추가하지 않아야 한다."""
    memos = {"page_1": [{"content": "  ", "sentenceText": "something"}]}
    result = generate_annotated_pdf(sample_pdf, {}, {}, memos)
    doc = fitz.open("pdf", result)
    assert doc.page_count == 2
    doc.close()


def test_generate_pdf_handles_invalid_page_key_gracefully(sample_pdf):
    """존재하지 않는 페이지 번호나 잘못된 키 형식이 들어와도 에러 없이 무시해야 한다."""
    annotations = {
        "page_999": [{"type": "highlight", "text": "anything", "color": "#eab308"}],
        "not-a-page-key": [{"type": "highlight", "text": "anything", "color": "#eab308"}],
    }
    result = generate_annotated_pdf(sample_pdf, annotations, {}, {})
    doc = fitz.open("pdf", result)
    assert doc.page_count == 2
    doc.close()
