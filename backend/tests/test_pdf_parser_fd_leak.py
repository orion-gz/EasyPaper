"""_extract_pages_pymupdf / get_pdf_metadata / extract_pdf_images가 파싱 도중
예외가 나도 fitz.Document를 닫는지 확인하는 회귀 테스트.

수정 전에는 doc.close()가 함수 마지막 줄에만 있어, 중간에 예외가 나면
파일 디스크립터가 회수되지 않았다(반복 업로드/재시도 시 FD 고갈로 서버
전체가 죽을 수 있는 문제)."""

import pytest

import fitz

import services.pdf_parser as pdf_parser


def _make_pdf(tmp_path, pages=1):
    doc = fitz.open()
    for _ in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 72), "Hello world, this is a test PDF page.")
    pdf_path = tmp_path / "test.pdf"
    doc.save(str(pdf_path))
    doc.close()
    return str(pdf_path)


def test_extract_pages_pymupdf_closes_doc_on_exception(tmp_path, monkeypatch):
    pdf_path = _make_pdf(tmp_path)
    opened = []
    real_open = fitz.open

    def spy_open(path):
        d = real_open(path)
        opened.append(d)
        return d

    monkeypatch.setattr(pdf_parser.fitz, "open", spy_open)
    monkeypatch.setattr(pdf_parser, "_extract_page", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))

    with pytest.raises(RuntimeError):
        pdf_parser._extract_pages_pymupdf(pdf_path)

    assert len(opened) == 1
    assert opened[0].is_closed, "예외 발생 시에도 fitz.Document가 닫혀야 한다"


def test_get_pdf_metadata_closes_doc_on_exception(tmp_path, monkeypatch):
    pdf_path = _make_pdf(tmp_path)
    opened = []
    real_open = fitz.open

    def spy_open(path):
        d = real_open(path)
        opened.append(d)
        return d

    monkeypatch.setattr(pdf_parser.fitz, "open", spy_open)
    monkeypatch.setattr(pdf_parser, "_extract_paper_title", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))

    with pytest.raises(RuntimeError):
        pdf_parser.get_pdf_metadata(pdf_path)

    assert len(opened) == 1
    assert opened[0].is_closed, "예외 발생 시에도 fitz.Document가 닫혀야 한다"


def test_extract_pdf_images_closes_doc_on_exception(tmp_path, monkeypatch):
    pdf_path = _make_pdf(tmp_path)
    opened = []
    real_open = fitz.open

    def spy_open(path):
        d = real_open(path)
        opened.append(d)
        return d

    monkeypatch.setattr(pdf_parser.fitz, "open", spy_open)
    monkeypatch.setattr(
        pdf_parser,
        "_extract_pdf_images_from_doc",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    with pytest.raises(RuntimeError):
        pdf_parser.extract_pdf_images(pdf_path, engine="pymupdf")

    assert len(opened) == 1
    assert opened[0].is_closed, "예외 발생 시에도 fitz.Document가 닫혀야 한다"


def test_extract_pdf_images_normal_path_still_returns_list(tmp_path):
    pdf_path = _make_pdf(tmp_path, pages=1)
    result = pdf_parser.extract_pdf_images(pdf_path, engine="pymupdf")
    assert isinstance(result, list)
