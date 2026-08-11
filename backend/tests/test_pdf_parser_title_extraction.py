"""services/pdf_parser.py의 _extract_paper_title() 테스트 - 논문 제목 추출 시
저자 이름이나 "1. Introduction" 같은 번호 매겨진 섹션 헤더가 제목에 섞여
들어가지 않는지 확인."""

import fitz

from services.pdf_parser import _extract_paper_title, get_pdf_metadata


def test_numbered_section_header_not_included_in_title(tmp_path):
    """제목과 "1. Introduction" 섹션 헤더의 폰트 크기가 비슷한 경우에도
    섹션 헤더는 제목에서 제외되어야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    title = "A Novel Approach to Efficient Neural Network Training"
    page.insert_text((50, 80), title, fontsize=18)
    page.insert_text((50, 200), "1. Introduction", fontsize=15)
    page.insert_text((50, 230), "This paper studies the problem of...", fontsize=11)

    path = tmp_path / "with_section_header.pdf"
    doc.save(str(path))
    doc.close()

    result_doc = fitz.open(str(path))
    extracted_title = _extract_paper_title(result_doc)
    result_doc.close()

    assert extracted_title == title
    assert "Introduction" not in extracted_title


def test_author_line_not_included_in_title(tmp_path):
    """제목 아래에 큰 폰트로 표기된 저자 이름 줄은 제목에서 제외되어야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    title = "Understanding Deep Learning Generalization"
    page.insert_text((50, 80), title, fontsize=18)
    page.insert_text((50, 200), "John Smith, Jane Doe, Alex Kim", fontsize=15)
    page.insert_text((50, 230), "Department of Computer Science, University of Example", fontsize=10)
    page.insert_text((50, 280), "Abstract", fontsize=11)

    path = tmp_path / "with_author_line.pdf"
    doc.save(str(path))
    doc.close()

    result_doc = fitz.open(str(path))
    extracted_title = _extract_paper_title(result_doc)
    result_doc.close()

    assert extracted_title == title
    assert "Smith" not in extracted_title
    assert "University" not in extracted_title


def test_multiline_title_without_extra_gap_still_extracted_fully(tmp_path):
    """줄바꿈 간격이 일반적인 다줄 제목은 그대로 온전히 추출되어야 한다
    (간격 기반 컷오프가 정상적인 제목까지 잘라내지 않는지 확인)."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    line1 = "A Comprehensive Study of Transformer Architectures"
    line2 = "for Long-Context Language Modeling"
    page.insert_text((50, 80), line1, fontsize=18)
    page.insert_text((50, 105), line2, fontsize=18)
    page.insert_text((50, 200), "John Smith", fontsize=15)

    path = tmp_path / "multiline_title.pdf"
    doc.save(str(path))
    doc.close()

    result_doc = fitz.open(str(path))
    extracted_title = _extract_paper_title(result_doc)
    result_doc.close()

    assert line1 in extracted_title
    assert line2 in extracted_title
    assert "Smith" not in extracted_title


def test_large_article_type_label_does_not_hide_real_title(tmp_path):
    """실제 제목보다 큰 문서 유형 라벨 대신 그 아래의 다줄 제목을 선택한다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    page.insert_text((50, 45), "RESEARCH ARTICLE", fontsize=24)
    line1 = "Reliable Title Extraction from"
    line2 = "Heterogeneous Scientific Documents"
    page.insert_text((50, 105), line1, fontsize=18)
    page.insert_text((50, 130), line2, fontsize=18)
    page.insert_text((50, 190), "Alice Kim, Bob Smith", fontsize=13)
    page.insert_text((50, 245), "Abstract", fontsize=12)
    page.insert_text((50, 270), "Scientific PDFs use many different layouts and styles.", fontsize=10)

    path = tmp_path / "with_article_type_label.pdf"
    doc.save(str(path))
    doc.close()

    result_doc = fitz.open(str(path))
    extracted_title = _extract_paper_title(result_doc)
    result_doc.close()

    assert extracted_title == f"{line1} {line2}"
    assert "RESEARCH ARTICLE" not in extracted_title


def test_large_journal_masthead_does_not_become_title(tmp_path):
    """페이지 최상단의 큰 저널 masthead를 자동 추출 제목으로 저장하지 않는다."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    page.insert_text((50, 45), "INTERNATIONAL JOURNAL OF ROBOTICS", fontsize=22)
    title = "Learning Robust Manipulation Policies from Sparse Feedback"
    page.insert_text((50, 110), title, fontsize=18)
    page.insert_text((50, 180), "Jane Doe", fontsize=13)
    page.insert_text((50, 245), "Abstract", fontsize=12)
    page.insert_text((50, 270), "We study manipulation learning with limited feedback.", fontsize=10)

    path = tmp_path / "with_journal_masthead.pdf"
    doc.save(str(path))
    doc.close()

    result_doc = fitz.open(str(path))
    extracted_title = _extract_paper_title(result_doc)
    result_doc.close()

    assert extracted_title == title
    assert "JOURNAL" not in extracted_title


def test_pdf_editor_watermark_does_not_become_title(tmp_path):
    """PDF 편집기 워터마크가 본문 문장과 한 행으로 합쳐져도
    실제 제목 후보를 대신하지 않아야 한다."""
    doc = fitz.open()
    page = doc.new_page(width=700, height=842)

    title = "Muon Optimizer Accelerates Grokking"
    page.insert_text((50, 80), title, fontsize=18)
    page.insert_text(
        (25, 300),
        "Created in Master PDF Editor checkpoints to support future research.",
        fontsize=15,
    )
    page.insert_textbox(
        fitz.Rect(50, 360, 650, 650),
        "This paper investigates optimizer behavior and generalization. " * 20,
        fontsize=10,
    )
    doc.set_metadata({"title": title})

    path = tmp_path / "master_pdf_editor_watermark.pdf"
    doc.save(str(path))
    doc.close()

    result_doc = fitz.open(str(path))
    extracted_title = _extract_paper_title(result_doc)
    result_doc.close()

    assert extracted_title == title
    assert get_pdf_metadata(str(path))["title"] == title
