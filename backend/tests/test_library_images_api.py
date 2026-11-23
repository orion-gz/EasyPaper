"""GET /library/{doc_id}/images HTTP 레벨 테스트.

extract_pdf_images()는 페이지마다 find_tables()/get_drawings() 등을 두
차례씩 훑는 무거운 연산이다. 텍스트 추출(extract_pages)과 달리 예전에는
디스크 캐시가 전혀 없어 문서를 열 때마다(같은 세션 안에서도) 매번
처음부터 재계산했다 - 이 테스트는 그 디스크 캐시가 실제로 재계산을
막아주는지 확인한다."""

from unittest.mock import patch


def _create_doc(isolated_dirs, doc_id="doc-1", username="testuser"):
    db = isolated_dirs["db"]
    db.db_save_document(doc_id, username, "paper.pdf", "/x/paper.pdf", 3, {"title": "Test Paper"})


def test_get_images_extracts_and_caches(test_client, isolated_dirs, tmp_path):
    _create_doc(isolated_dirs)
    pdf_path = tmp_path / "paper.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 200)

    fake_images = [{"page": 1, "bbox": [0.1, 0.1, 0.5, 0.5], "label": "Figure 1"}]
    with patch("services.pdf_parser.extract_pdf_images", return_value=fake_images) as mock_extract, \
         patch("routers.library.get_pdf_path", return_value=str(pdf_path)):
        res = test_client.get("/api/library/doc-1/images")

    assert res.status_code == 200
    assert res.json()["images"] == fake_images
    mock_extract.assert_called_once()

    # 두 번째 호출은 디스크 캐시를 써야 하므로 extract_pdf_images가 다시 호출되지 않아야 한다
    with patch("services.pdf_parser.extract_pdf_images") as mock_extract2, \
         patch("routers.library.get_pdf_path", return_value=str(pdf_path)):
        res2 = test_client.get("/api/library/doc-1/images")

    assert res2.status_code == 200
    assert res2.json()["images"] == fake_images
    mock_extract2.assert_not_called()


def test_get_images_other_users_document_returns_404(test_client, isolated_dirs):
    _create_doc(isolated_dirs, doc_id="doc-other", username="otheruser")
    res = test_client.get("/api/library/doc-other/images")
    assert res.status_code == 404


def test_window_extracts_only_missing_pages(test_client, isolated_dirs, tmp_path, monkeypatch):
    import json
    from pathlib import Path
    from types import SimpleNamespace

    import fitz
    from services import image_window

    _create_doc(isolated_dirs)
    pdf_path = tmp_path / "book.pdf"
    with fitz.open() as source:
        for n in range(1, 51):
            source.new_page().insert_text((20, 40), str(n))
        source.save(pdf_path)
    monkeypatch.setattr("routers.library.get_pdf_path", lambda _: str(pdf_path))
    monkeypatch.setattr(image_window, "CACHE_DIR", str(tmp_path))
    calls = []

    def run(command, **kwargs):
        with fitz.open(command[command.index("--pdf") + 1]) as subset:
            pages = [int(p.get_text().strip()) for p in subset]
        calls.append(pages)
        output = Path(command[command.index("--output") + 1])
        output.write_text(json.dumps([{"page": i} for i in range(1, len(pages) + 1)]))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(image_window.subprocess, "run", run)
    url = "/api/library/doc-1/images?page="
    assert test_client.get(url + "22&single=true").json()["images"] == [{"page": 22}]
    data = test_client.get(url + "22").json()
    assert data["images"] == [{"page": n} for n in range(7, 38)]
    assert test_client.get(url + "22").json() == data
    assert test_client.get(url + "24").json()["end"] == 39
    assert calls == [[22], [*range(7, 22), *range(23, 38)], [38, 39]]


def test_resolve_figure_uses_caption_not_body_reference(test_client, isolated_dirs, tmp_path, monkeypatch):
    import fitz
    from services import image_window

    _create_doc(isolated_dirs)
    path = tmp_path / "book.pdf"
    with fitz.open() as pdf:
        for line in ("See Fig 1-2 below.", "Figure 1: Other", "Fig 1-2: Target"):
            pdf.new_page().insert_text((60, 100), line)
        pdf.save(path)
    monkeypatch.setattr("routers.library.get_pdf_path", lambda _: str(path))
    monkeypatch.setattr(image_window, "CACHE_DIR", str(tmp_path))
    parsed = []

    def load_page(doc_id, doc, pdf_path, page, *, single):
        assert single
        parsed.append(page)
        return {"images": [{"page": page, "label": "Figure 1-2"}]}

    monkeypatch.setattr(image_window, "load_image_window", load_page)
    url = "/api/library/doc-1/figure-reference"
    response = test_client.get(url, params={"label": "Figure 1-2", "page": 1})
    assert response.json() == {"image": {"label": "Figure 1-2", "page": 3}}
    absent = test_client.get(url, params={"label": "Figure 1-3", "page": 1})
    assert absent.json() == {"image": None}
    assert parsed == [3]

    monkeypatch.setattr(image_window, "get_cached_pages", lambda *args: [
        {"page_num": 2, "text": "그림 A‑3: OCR caption"}])
    def load_ocr_page(doc_id, doc, pdf_path, page, *, single):
        assert single and page == 2
        return {"images": [{"page": page, "label": "Figure A-3"}]}
    monkeypatch.setattr(image_window, "load_image_window", load_ocr_page)
    response = test_client.get(url, params={"label": "Figure A-3", "page": 1})
    assert response.json()["image"] == {"page": 2, "label": "Figure A-3"}
