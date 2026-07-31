"""services/pdf_parser.py의 _extract_paper_title() 테스트 - 논문 제목 추출 시
저자 이름이나 "1. Introduction" 같은 번호 매겨진 섹션 헤더가 제목에 섞여
들어가지 않는지 확인."""

import fitz

from services.pdf_parser import _extract_paper_title


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
