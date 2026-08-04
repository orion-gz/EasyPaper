"""POST /library/{doc_id}/clear-cache 테스트 - 단일 문서의 PDF 텍스트 및 이미지 추출
디스크 캐시를 정리하는 엔드포인트 및 서비스 함수 테스트."""

from services.cache import save_pages_cache, save_images_cache, get_cached_pages, get_cached_images, clear_document_cache
from services.library import save_document


def test_clear_document_cache_service(isolated_dirs, tmp_path):
    pdf_path = tmp_path / "doc.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 300)

    save_pages_cache("doc-1", str(pdf_path), [{"page_num": 1, "text": "a"}])
    save_images_cache("doc-1", str(pdf_path), [{"page_num": 1, "images": []}])
    save_pages_cache("doc-2", str(pdf_path), [{"page_num": 1, "text": "b"}])

    # doc-1 캐시만 삭제
    count, freed_bytes = clear_document_cache("doc-1")
    assert count == 2
    assert freed_bytes > 0

    assert get_cached_pages("doc-1", str(pdf_path)) is None
    assert get_cached_images("doc-1", str(pdf_path)) is None
    # doc-2 캐시는 유지되어야 함
    assert get_cached_pages("doc-2", str(pdf_path)) == [{"page_num": 1, "text": "b"}]


def test_clear_document_cache_endpoint(test_client, isolated_dirs, tmp_path):
    pdf_path = tmp_path / "doc.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 300)

    doc_info = save_document("doc-test-1", "test_paper.pdf", str(pdf_path), 5, {}, "testuser")

    doc_id = doc_info["id"]


    save_pages_cache(doc_id, str(pdf_path), [{"page_num": 1, "text": "test"}])
    save_images_cache(doc_id, str(pdf_path), [{"page_num": 1, "images": []}])

    res = test_client.post(f"/api/library/{doc_id}/clear-cache")
    assert res.status_code == 200
    body = res.json()
    assert body["cleared_files"] == 2
    assert body["freed_bytes"] > 0
    assert body["message"] == "PDF 추출 캐시가 삭제되었습니다."

    assert get_cached_pages(doc_id, str(pdf_path)) is None
    assert get_cached_images(doc_id, str(pdf_path)) is None


def test_clear_document_cache_endpoint_not_found(test_client, isolated_dirs):
    res = test_client.post("/api/library/non-existent-doc/clear-cache")
    assert res.status_code == 404
