import pytest
import os
import fitz
from config import get_pdf_parser_engine, update_system_settings
from services.pdf_parser import extract_pages


def _make_test_pdf(path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "Hello world, this is a test paragraph for engine parity.", fontsize=11)
    doc.save(str(path))
    doc.close()


@pytest.mark.parametrize("engine", ["pymupdf", "pdfplumber"])
def test_extract_pages_schema_uses_page_num_key(tmp_path, engine):
    """네 엔진(pymupdf/pdfplumber/marker/mineru) 모두 페이지 번호를 "page_num"
    키로 반환해야 한다. pymupdf만 이 키를 쓰고 나머지는 "page" 키를 써서,
    translate.py/insight.py/translation_job.py가 page_num으로 직접
    서브스크립트하는 경로에서 KeyError/페이지 유실이 나던 회귀 방지용.
    marker/mineru는 무거운 모델이 필요해 이 테스트에서는 제외(설치돼 있지
    않으면 자동으로 pymupdf 폴백이 뜨는데, 그러면 이 테스트의 의도인
    "엔진별 반환 스키마 검증"과 어긋나므로)."""
    pdf_path = tmp_path / "doc.pdf"
    _make_test_pdf(pdf_path)

    pages = extract_pages(str(pdf_path), engine=engine)
    assert len(pages) >= 1
    for page in pages:
        assert "page_num" in page, f"{engine} 엔진이 page_num 키를 반환하지 않음: {page.keys()}"
        assert "page" not in page, f"{engine} 엔진이 여전히 구식 page 키를 반환함"
        assert isinstance(page["page_num"], int)


def test_pdf_parser_engine_config():
    # Test setting and retrieving pdf_parser_engine
    orig_engine = get_pdf_parser_engine()
    
    update_system_settings(
        ollama_host="http://localhost:11434",
        trans_provider="ollama",
        trans_model="gemma4:e4b",
        chat_provider="ollama",
        chat_model="gemma4:e4b",
        pdf_parser_engine="pdfplumber"
    )
    assert get_pdf_parser_engine() == "pdfplumber"

    # Restore original setting
    update_system_settings(
        ollama_host="http://localhost:11434",
        trans_provider="ollama",
        trans_model="gemma4:e4b",
        chat_provider="ollama",
        chat_model="gemma4:e4b",
        pdf_parser_engine=orig_engine
    )
    assert get_pdf_parser_engine() == orig_engine
