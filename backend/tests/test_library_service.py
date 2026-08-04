"""services/library.py 테스트 - 특히 문서 영구삭제 시 관련 파일이 전부
정리되는지(지난 세션 버그 수정)를 확인한다."""

import os


def test_permanently_delete_document_cleans_up_all_locations(isolated_dirs):
    db = isolated_dirs["db"]
    cache = isolated_dirs["cache"]
    library = isolated_dirs["library"]
    doc_id = "doc-cleanup-test"

    upload_dir = os.path.join(str(isolated_dirs["upload_dir"]), doc_id)
    os.makedirs(upload_dir, exist_ok=True)
    with open(os.path.join(upload_dir, "document.pdf"), "w") as f:
        f.write("original upload")

    lib_dir = os.path.join(str(isolated_dirs["library_dir"]), doc_id)
    os.makedirs(lib_dir, exist_ok=True)
    with open(os.path.join(lib_dir, "document.pdf"), "w") as f:
        f.write("library copy")

    with open(os.path.join(str(isolated_dirs["cache_dir"]), f"{doc_id}_page_1.json"), "w") as f:
        f.write("{}")
    with open(os.path.join(str(isolated_dirs["cache_dir"]), f"{doc_id}_page_2.json"), "w") as f:
        f.write("{}")

    db.db_save_document(doc_id, "admin", "test.pdf", "/x", 1, {})

    # 삭제 전 사전 조건 확인
    assert os.path.exists(upload_dir)
    assert os.path.exists(lib_dir)
    assert len([f for f in os.listdir(str(isolated_dirs["cache_dir"])) if f.startswith(doc_id)]) == 2
    assert db.db_get_document(doc_id) is not None

    result = library.permanently_delete_document(doc_id)

    assert result is True
    assert not os.path.exists(upload_dir), "업로드 원본 디렉터리가 삭제되어야 한다"
    assert not os.path.exists(lib_dir), "라이브러리 보관 디렉터리가 삭제되어야 한다"
    assert len([f for f in os.listdir(str(isolated_dirs["cache_dir"])) if f.startswith(doc_id)]) == 0, \
        "페이지별 번역 캐시 파일이 모두 삭제되어야 한다"
    assert db.db_get_document(doc_id) is None, "DB 레코드도 삭제되어야 한다"


def test_permanently_delete_nonexistent_document_returns_false(isolated_dirs):
    library = isolated_dirs["library"]
    assert library.permanently_delete_document("no-such-doc") is False


# list_documents()/get_document()의 translated_pages 계산은 예전에 문서마다
# 새 SQLite 커넥션을 열어 최대 3개의 쿼리를 던지는 N+1 패턴이었다(성능
# 문제). 여러 문서의 번역 행을 한 번에 모아 메모리에서 매칭하도록
# 바꿨는데, 이 리팩터링이 기존 suffix-fallback 규칙과 문서별 격리를 그대로
# 유지하는지가 핵심 리스크라 아래에서 확인한다.

def test_list_documents_returns_pages_for_matching_suffix(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})
    db.db_save_translation("doc-1", 1, "번역1", suffix="ko_formal")
    db.db_save_translation("doc-1", 2, "번역2", suffix="ko_formal")

    docs = library.list_documents("admin", target_lang="ko", style="formal", ignore_math=False, ignore_table=False, ignore_refs=False)
    assert docs[0]["translated_pages"] == [1, 2]


def test_list_documents_falls_back_to_most_recent_suffix_when_no_match(isolated_dirs):
    """요청한 suffix(예: 새 target_lang/style)로 번역된 페이지가 없으면,
    가장 최근에 저장된 다른 suffix의 번역 페이지를 대신 보여줘야 한다."""
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})
    db.db_save_translation("doc-1", 1, "old", suffix="en_casual")

    docs = library.list_documents("admin", target_lang="ko", style="formal", ignore_math=False, ignore_table=False, ignore_refs=False)
    assert docs[0]["translated_pages"] == [1]


def test_list_documents_isolates_translated_pages_per_document(isolated_dirs):
    """여러 문서의 번역 행을 한 번의 쿼리로 모아오는 방식이라, 다른 문서의
    페이지가 서로 뒤섞이지 않아야 한다."""
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})
    db.db_save_document("doc-2", "admin", "p2.pdf", "/x", 3, {})
    db.db_save_translation("doc-1", 1, "d1p1")
    db.db_save_translation("doc-1", 2, "d1p2")
    db.db_save_translation("doc-2", 5, "d2p5")

    docs = library.list_documents("admin")
    by_id = {d["id"]: d["translated_pages"] for d in docs}
    assert by_id["doc-1"] == [1, 2]
    assert by_id["doc-2"] == [5]


def test_list_documents_with_no_translations_returns_empty_pages(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})

    docs = library.list_documents("admin")
    assert docs[0]["translated_pages"] == []


def test_get_document_returns_pages_for_matching_suffix(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})
    db.db_save_translation("doc-1", 1, "번역1", suffix="ko_formal")

    doc = library.get_document("doc-1", target_lang="ko", style="formal", ignore_math=False, ignore_table=False, ignore_refs=False)
    assert doc["translated_pages"] == [1]


def test_get_document_falls_back_to_most_recent_suffix_when_no_match(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})
    db.db_save_translation("doc-1", 1, "old", suffix="en_casual")

    doc = library.get_document("doc-1", target_lang="ko", style="formal", ignore_math=False, ignore_table=False, ignore_refs=False)
    assert doc["translated_pages"] == [1]


def test_get_document_without_suffix_uses_most_recent_translation(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 3, {})
    db.db_save_translation("doc-1", 1, "번역1")

    doc = library.get_document("doc-1")
    assert doc["translated_pages"] == [1]


# ── get_reference_start_page / read_page_count ──────────────────────────
# "읽은 페이지 수"를 계산할 때 참고문헌 페이지를 본문에서 빼기 위한 로직.
# 대시보드/Reading History가 전부 이 두 함수를 공유한다(프론트의
# readPages.js readPageCount와 동일한 공식).

def _write_fake_pdf(isolated_dirs, doc_id, content=b"%PDF-1.4 fake"):
    pdf_path = str(isolated_dirs["upload_dir"] / f"{doc_id}.pdf")
    with open(pdf_path, "wb") as f:
        f.write(content)
    return pdf_path


def test_get_reference_start_page_computes_and_caches_from_pages(isolated_dirs):
    library = isolated_dirs["library"]
    cache = isolated_dirs["cache"]
    db = isolated_dirs["db"]
    pdf_path = _write_fake_pdf(isolated_dirs, "doc-ref-1")
    db.db_save_document("doc-ref-1", "admin", "p.pdf", pdf_path, 5, {})
    pages = [
        {"text": "Intro text"}, {"text": "Method text"},
        {"text": "References\n[1] Someone. A Paper. 2020."}, {"text": ""}, {"text": ""},
    ]
    cache.save_pages_cache("doc-ref-1", pdf_path, pages)

    doc = db.db_get_document("doc-ref-1")
    result = library.get_reference_start_page(doc)

    assert result == 3  # 0-based idx 2 -> 1-based 페이지 3
    # 계산 결과가 DB에 영구 저장되어야 다음 조회 시 재계산하지 않는다
    reloaded = db.db_get_document("doc-ref-1")
    assert reloaded["metadata"]["reference_start_page"] == 3


def test_get_reference_start_page_caches_none_when_no_references_section(isolated_dirs):
    library = isolated_dirs["library"]
    cache = isolated_dirs["cache"]
    db = isolated_dirs["db"]
    pdf_path = _write_fake_pdf(isolated_dirs, "doc-ref-2")
    db.db_save_document("doc-ref-2", "admin", "p.pdf", pdf_path, 3, {})
    cache.save_pages_cache("doc-ref-2", pdf_path, [{"text": "no references header anywhere"}] * 3)

    doc = db.db_get_document("doc-ref-2")
    assert library.get_reference_start_page(doc) is None

    reloaded = db.db_get_document("doc-ref-2")
    assert "reference_start_page" in reloaded["metadata"]
    assert reloaded["metadata"]["reference_start_page"] is None


def test_get_reference_start_page_skips_caching_when_pages_not_cached(isolated_dirs):
    """PDF 페이지 텍스트가 아직 디스크 캐시에 없으면(처리 중/실패 등),
    계산을 미루고 metadata에 아무것도 써넣지 않아 다음 기회에 재시도할 수
    있게 해야 한다."""
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    pdf_path = _write_fake_pdf(isolated_dirs, "doc-ref-3")
    db.db_save_document("doc-ref-3", "admin", "p.pdf", pdf_path, 3, {})

    doc = db.db_get_document("doc-ref-3")
    assert library.get_reference_start_page(doc) is None

    reloaded = db.db_get_document("doc-ref-3")
    assert "reference_start_page" not in reloaded["metadata"]


def test_get_reference_start_page_returns_cached_value_without_recomputing(isolated_dirs, monkeypatch):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-ref-4", "admin", "p.pdf", "/x", 5, {"reference_start_page": 4})

    import services.cache as cache_module
    def _boom(*a, **kw):
        raise AssertionError("이미 캐시된 값이 있으면 get_cached_pages를 다시 호출하면 안 된다")
    monkeypatch.setattr(cache_module, "get_cached_pages", _boom)

    doc = db.db_get_document("doc-ref-4")
    assert library.get_reference_start_page(doc) == 4


def test_read_page_count_completed_doc_excludes_references(isolated_dirs):
    library = isolated_dirs["library"]
    doc = {"id": "d1", "total_pages": 10, "metadata": {"read": True, "reference_start_page": 8}}
    assert library.read_page_count(doc) == 7  # 페이지 1~7만 본문, 8~10은 참고문헌


def test_read_page_count_in_progress_doc_caps_at_content_pages(isolated_dirs):
    library = isolated_dirs["library"]
    doc = {"id": "d1", "total_pages": 10, "metadata": {"last_page": 9, "reference_start_page": 8}}
    assert library.read_page_count(doc) == 7  # 진행 페이지가 참고문헌 구간을 넘어가도 본문 상한을 넘지 않는다


def test_read_page_count_in_progress_doc_within_content(isolated_dirs):
    library = isolated_dirs["library"]
    doc = {"id": "d1", "total_pages": 10, "metadata": {"last_page": 5, "reference_start_page": 8}}
    assert library.read_page_count(doc) == 5


def test_read_page_count_unread_doc_is_zero(isolated_dirs):
    library = isolated_dirs["library"]
    doc = {"id": "d1", "total_pages": 10, "metadata": {}}
    assert library.read_page_count(doc) == 0


def test_read_page_count_without_reference_info_falls_back_to_total_pages(isolated_dirs):
    library = isolated_dirs["library"]
    # pdf_path가 없어 get_reference_start_page가 None을 반환하는 경우(=참고문헌
    # 제외 정보를 아직 모름) - 본문 페이지 수를 total_pages 그대로로 본다.
    doc = {"id": "d1", "total_pages": 10, "metadata": {"read": True}}
    assert library.read_page_count(doc) == 10
