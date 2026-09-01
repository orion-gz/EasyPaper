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
    # 페이지 수는 항상 원본과 1:1로 유지된다(번역용 페이지가 뒤에 추가되지 않음)
    assert doc.page_count == 2

    src = fitz.open(sample_pdf)
    src_page_width = src[0].rect.width
    src.close()
    # 번역 영역은 원문보다 조금 좁은 90% 폭을 사용해야 한다.
    assert doc[0].rect.width == pytest.approx(src_page_width * 1.9, rel=0.01)

    page1_text = doc[0].get_text()
    assert "self-attention mechanisms" in page1_text  # 왼쪽: 원문 그대로(벡터 삽입, 텍스트 추출 가능)
    assert "셀프 어텐션" in page1_text  # 오른쪽: 같은 페이지에 번역이 나란히
    doc.close()


def test_generate_pdf_shrinks_long_translation_to_fit_single_page(sample_pdf):
    """번역이 원본 페이지 한 장에 다 들어가지 않을 만큼 길어도, 페어링(원문
    페이지 수 = 출력 페이지 수)을 깨는 별도 페이지를 추가하는 대신 글자
    크기를 줄여서라도 반드시 한 페이지 안에 담아야 한다."""
    long_translation = "이 문장은 페이지를 넘칠 정도로 아주 길게 반복되는 번역 텍스트입니다. " * 400
    translations = {"1": long_translation}
    result = generate_annotated_pdf(sample_pdf, {}, translations, {})
    doc = fitz.open("pdf", result)
    assert doc.page_count == 2  # 번역이 아무리 길어도 원본 페이지 수 그대로

    page1_text = doc[0].get_text()
    assert "self-attention mechanisms" in page1_text
    assert "아주 길게 반복되는" in page1_text  # 축소되어도 텍스트 자체는 온전히 들어가 있어야 함
    doc.close()


def test_generate_pdf_renders_markdown_bold_without_literal_asterisks(sample_pdf):
    """번역 텍스트의 "**볼드**" 마크다운이 <b> 태그로 변환되어야 하며, 원문
    그대로의 "**" 기호가 출력 텍스트에 남아있으면 안 된다."""
    translations = {"1": "이것은 **매우 중요한** 결과입니다."}
    result = generate_annotated_pdf(sample_pdf, {}, translations, {})
    doc = fitz.open("pdf", result)
    page1_text = doc[0].get_text()
    assert "**" not in page1_text
    assert "매우 중요한" in page1_text
    doc.close()


def test_generate_pdf_renders_latex_formula_as_image_not_raw_text(sample_pdf):
    """번역 텍스트의 LaTeX 수식($...$/$$...$$)은 원문 그대로의 "$", "\\sum"
    같은 기호로 노출되지 말고, 실제 렌더링된 이미지로 삽입되어야 한다."""
    translations = {"1": "손실 함수는 $f(x) = \\sum_{i=1}^n x_i$ 로 정의됩니다."}
    result = generate_annotated_pdf(sample_pdf, {}, translations, {})
    doc = fitz.open("pdf", result)
    page1_text = doc[0].get_text()
    assert "$" not in page1_text
    assert "\\sum" not in page1_text
    assert len(doc[0].get_images()) >= 1  # 수식이 이미지로 삽입됨
    doc.close()


def test_generate_pdf_falls_back_to_plain_text_for_korean_inside_formula(sample_pdf):
    """수식 렌더링용 폰트(matplotlib mathtext)에는 한글 글리프가 없어, 번역
    모델이 실수로 수식 안에 한글을 넣은 경우(예: \\text{여기서 ...}) 그대로
    이미지화하면 네모 박스(tofu)로 깨진다 - 이 경우는 이미지 대신 일반
    텍스트로 안전하게 대체되어야 하며, 예외 없이 내보내기가 끝나야 한다."""
    translations = {"1": "다음이 성립합니다: $\\int f(z) dz \\quad \\left(\\text{여기서 } z \\sim p(z)\\right)$"}
    result = generate_annotated_pdf(sample_pdf, {}, translations, {})
    doc = fitz.open("pdf", result)
    page1_text = doc[0].get_text()
    assert "여기서" in page1_text  # 렌더링 대신 텍스트로라도 내용은 보존되어야 함
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


def test_generate_article_pdf_includes_pairs_annotations_and_memos(tmp_path):
    import fitz
    from PIL import Image
    from services.pdf_export import generate_article_pdf
    article_dir = tmp_path / "article"; assets = article_dir / "assets"; assets.mkdir(parents=True)
    Image.new("RGB", (20, 20), "red").save(assets / "figure.png")
    manifest = {"blocks": [{"id": "block-1", "html": '<h1 data-block-id="block-1">Source title</h1><p>Source body</p><img src="assets/figure.png">', "text": "Source title Source body"}], "units": [{"index": 1, "id": "section-1", "title": "Source title", "block_ids": ["block-1"]}]}
    result = generate_article_pdf(manifest, {"1": "Translated body"}, {"section_1": [{"content": "Memo body", "sentenceText": "Source body"}]}, {"section_1": [{"type": "highlight", "text": "Source body", "color": "#eab308"}]}, str(article_dir))
    pdf = fitz.open(stream=result, filetype="pdf")
    text = "\n".join(page.get_text() for page in pdf)
    assert pdf.page_count >= 3
    assert "Source title" in text
    assert "Translated body" in text
    assert "Source body" in text
    assert "Memo body" in text
