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


def test_clear_cache_sequence_clears_all_without_reparsing(test_client, isolated_dirs, tmp_path, monkeypatch):
    """활성 세션과 번역본이 있는 상태에서 번역 캐시와 PDF 추출 캐시를 순서대로
    삭제할 때, PDF 파싱 함수가 호출되지 않고 두 캐시와 세션이 모두 삭제되는지 검증한다."""
    import json
    from services.cache import (
        save_translation_cache,
        get_cached_translation,
    )
    from services.library import (
        save_translation as lib_save_translation,
        get_translation as lib_get_translation,
    )
    from routers.upload import sessions
    import services.pdf_parser as pdf_parser
    import routers.upload as upload_module

    pdf_path = tmp_path / "doc.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 300)

    doc_info = save_document("doc-test-seq", "paper_seq.pdf", str(pdf_path), 2, {}, "testuser")
    doc_id = doc_info["id"]

    # 1. 디스크 추출 캐시 생성
    save_pages_cache(doc_id, str(pdf_path), [{"page_num": 1, "text": "p1"}, {"page_num": 2, "text": "p2"}])
    save_images_cache(doc_id, str(pdf_path), [{"page_num": 1, "images": []}])

    # 2. 디스크 번역 캐시 및 라이브러리 번역본 저장
    save_translation_cache(doc_id, 1, json.dumps({"translation": "번역 1", "sentences": []}))
    lib_save_translation(doc_id, 1, json.dumps({"translation": "번역 1", "sentences": []}))

    # 3. 메모리 활성 세션 등록
    sessions[doc_id] = {
        "pdf_path": str(pdf_path),
        "filename": "paper_seq.pdf",
        "pages": [{"page_num": 1, "text": "p1"}, {"page_num": 2, "text": "p2"}],
        "total_pages": 2,
        "username": "testuser",
        "metadata": {},
    }

    # 4. 파싱 함수가 호출되면 즉시 실패하도록 감시/차단
    parse_called = []
    def fail_if_parse_called(*args, **kwargs):
        parse_called.append(args)
        raise RuntimeError("PDF 파싱 함수가 호출되면 안 됩니다!")

    monkeypatch.setattr(pdf_parser, "extract_pages", fail_if_parse_called)
    monkeypatch.setattr(upload_module, "extract_pages", fail_if_parse_called)

    # 5. 뷰어의 수정된 호출 순서대로 실행: 번역 캐시 삭제 -> PDF 추출 캐시 삭제
    res_trans = test_client.post(f"/api/translate/{doc_id}/clear-cache")
    assert res_trans.status_code == 200

    res_doc = test_client.post(f"/api/library/{doc_id}/clear-cache")
    assert res_doc.status_code == 200

    # 6. 검증: 파싱 함수는 한 번도 호출되지 않았어야 함
    assert len(parse_called) == 0

    # 7. 검증: PDF 추출 캐시 삭제 확인
    assert get_cached_pages(doc_id, str(pdf_path)) is None
    assert get_cached_images(doc_id, str(pdf_path)) is None

    # 8. 검증: 번역 캐시 및 라이브러리 번역본 삭제 확인
    assert get_cached_translation(doc_id, 1) is None
    assert lib_get_translation(doc_id, 1) is None

    # 9. 검증: 메모리 세션 제거 확인
    assert doc_id not in sessions


def test_clear_translation_cache_without_session_does_not_reparse(test_client, isolated_dirs, tmp_path, monkeypatch):
    """세션이 메모리에 없고 PDF 추출 캐시도 없는 상태에서 번역 캐시를 삭제하더라도,
    PDF 재파싱 없이 라이브러리 문서 소유권만 확인하여 정상 삭제되는지 검증한다."""
    import json
    from services.cache import (
        save_translation_cache,
        get_cached_translation,
    )
    from services.library import (
        save_translation as lib_save_translation,
        get_translation as lib_get_translation,
    )
    from routers.upload import sessions
    import services.pdf_parser as pdf_parser
    import routers.upload as upload_module

    pdf_path = tmp_path / "doc2.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake" + b"\0" * 300)

    doc_info = save_document("doc-no-session", "paper_no_session.pdf", str(pdf_path), 2, {}, "testuser")
    doc_id = doc_info["id"]

    # 세션은 없고 번역 저장본만 존재하는 상태
    sessions.pop(doc_id, None)
    save_translation_cache(doc_id, 1, json.dumps({"translation": "남은 번역", "sentences": []}))
    lib_save_translation(doc_id, 1, json.dumps({"translation": "남은 번역", "sentences": []}))

    # 파싱 함수 차단
    parse_called = []
    def fail_if_parse_called(*args, **kwargs):
        parse_called.append(args)
        raise RuntimeError("PDF 파싱 함수가 호출되면 안 됩니다!")

    monkeypatch.setattr(pdf_parser, "extract_pages", fail_if_parse_called)
    monkeypatch.setattr(upload_module, "extract_pages", fail_if_parse_called)

    res_trans = test_client.post(f"/api/translate/{doc_id}/clear-cache")
    assert res_trans.status_code == 200
    assert len(parse_called) == 0
    assert get_cached_translation(doc_id, 1) is None
    assert lib_get_translation(doc_id, 1) is None
def test_translation_reset_waits_for_cancelled_job(isolated_dirs, monkeypatch):
    """취소 처리 중 기록한 번역/잡 상태도 초기화가 끝나기 전에 삭제한다."""
    import asyncio
    import os
    from routers.translate import clear_translation_cache
    from routers.upload import sessions
    from services.cache import save_translation_cache, get_cached_translation
    import services.translation_job as translation_job
    from services.translation_job import _running_tasks, _save_job, _job_path, get_job_status
    from services.document_tasks import create_task, get_task

    monkeypatch.setattr(translation_job, "LIBRARY_DIR", str(isolated_dirs["library_dir"]))

    doc_id = "reset-cancelled-job"
    sessions[doc_id] = {"username": "testuser"}
    other_task = create_task(doc_id, "summary", {}, [1])

    async def run():
        async def job():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                save_translation_cache(doc_id, 1, "stale translation")
                _save_job(doc_id, {"status": "cancelled", "completed_pages": [1], "target_pages": [1]})

        task = asyncio.create_task(job())
        _running_tasks[doc_id] = task
        await asyncio.sleep(0)
        await clear_translation_cache(doc_id, current_user="testuser")
        assert task.done()
        assert get_cached_translation(doc_id, 1) is None
        assert not os.path.exists(_job_path(doc_id))
        assert doc_id not in _running_tasks
        assert get_job_status(doc_id) is None
        assert get_task(other_task["id"]) is not None

    try:
        asyncio.run(run())
    finally:
        sessions.pop(doc_id, None)

