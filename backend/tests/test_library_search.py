"""라이브러리 전체 검색(services.library.search_documents, db_search_documents) 테스트.

파일명/제목·카테고리와 페이지별 번역 텍스트를 가로지르는 검색과, 다른
사용자 문서가 결과에 섞이지 않는지를 확인한다.
"""

import json


def test_search_matches_filename(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "transformer_paper.pdf", "/x", 3, {"title": "Attention Is All You Need"})
    db.db_save_document("doc-2", "admin", "gan_paper.pdf", "/x", 2, {"title": "GAN"})

    results = library.search_documents("admin", "transformer")
    assert [d["id"] for d in results] == ["doc-1"]


def test_search_matches_title_in_metadata(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 1, {"title": "Generative Adversarial Networks"})

    results = library.search_documents("admin", "Generative")
    assert [d["id"] for d in results] == ["doc-1"]


def test_search_matches_translated_text(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 1, {"title": "GAN"})
    db.db_save_translation(
        "doc-1", 1,
        json.dumps({"translation": "이 논문은 셀프 어텐션 메커니즘을 다루지 않습니다.", "sentences": []}, ensure_ascii=False)
    )

    results = library.search_documents("admin", "셀프 어텐션")
    assert [d["id"] for d in results] == ["doc-1"]


def test_search_excludes_other_users_documents(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-mine", "admin", "p1.pdf", "/x", 1, {"title": "Attention Paper"})
    db.db_save_document("doc-other", "otheruser", "p2.pdf", "/x", 1, {"title": "Attention Survey"})

    results = library.search_documents("admin", "Attention")
    assert [d["id"] for d in results] == ["doc-mine"]


def test_search_excludes_trashed_documents_by_default(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 1, {"title": "Trashed Paper"})
    db.db_soft_delete_document("doc-1")

    assert library.search_documents("admin", "Trashed") == []


def test_search_empty_query_returns_no_results(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 1, {"title": "Anything"})

    assert library.search_documents("admin", "") == []
    assert library.search_documents("admin", "   ") == []


def test_search_no_match_returns_empty_list(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 1, {"title": "Something"})

    assert library.search_documents("admin", "xyzzy_no_such_term") == []


def test_search_wildcard_characters_are_treated_literally(isolated_dirs):
    """검색어에 SQL LIKE 와일드카드(%, _)가 그대로 들어와도 에러 없이, 리터럴
    문자로 취급되어야 한다 (모든 문서가 매칭되는 의도치 않은 동작 방지)."""
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "normal_paper.pdf", "/x", 1, {"title": "Normal"})

    results = library.search_documents("admin", "%")
    assert results == [], "와일드카드 %가 리터럴로 취급되어 아무 문서와도 매칭되지 않아야 한다"


def test_search_result_includes_translated_pages(isolated_dirs):
    library = isolated_dirs["library"]
    db = isolated_dirs["db"]
    db.db_save_document("doc-1", "admin", "p1.pdf", "/x", 2, {"title": "Searchable"})
    db.db_save_translation("doc-1", 1, json.dumps({"translation": "첫 페이지", "sentences": []}, ensure_ascii=False))

    results = library.search_documents("admin", "Searchable")
    assert results[0]["translated_pages"] == [1]



def test_search_matches_indexed_original_page_text(isolated_dirs):
    from services.context_retrieval import index_document_chunks
    db = isolated_dirs["db"]
    library = isolated_dirs["library"]
    db.db_save_document("doc-source", "admin", "manual.pdf", "/x", 2, {"title": "Manual"}, "general", "manual")
    index_document_chunks("doc-source", [
        {"page_num": 1, "text": "Ordinary introduction."},
        {"page_num": 2, "text": "Rotate the cryptographic recovery token before restart."},
    ])
    results = library.search_documents("admin", "cryptographic recovery", document_mode="general")
    assert [doc["id"] for doc in results] == ["doc-source"]
