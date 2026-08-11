"""라이브러리 엔드포인트의 문서 소유자 확인(IDOR 수정) 회귀 테스트.

get_current_user를 "testuser"로 고정하는 test_client fixture 위에서, 다른
사용자("otheruser") 소유의 문서에 접근을 시도해 전부 404로 막히는지 확인한다.
"""


def _create_doc_owned_by(isolated_dirs, doc_id: str, username: str):
    db = isolated_dirs["db"]
    db.db_save_document(doc_id, username, "paper.pdf", "/x/paper.pdf", 3, {"title": "Other's Paper"})


def test_get_document_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-other-1", "otheruser")
    res = test_client.get("/api/library/doc-other-1")
    assert res.status_code == 404


def test_get_own_document_succeeds(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-mine-1", "testuser")
    res = test_client.get("/api/library/doc-mine-1")
    assert res.status_code == 200
    assert res.json()["id"] == "doc-mine-1"


def test_delete_document_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-other-2", "otheruser")
    res = test_client.delete("/api/library/doc-other-2")
    assert res.status_code == 404

    # 실제로 지워지지 않았어야 한다
    db = isolated_dirs["db"]
    assert db.db_get_document("doc-other-2") is not None


def test_permanently_delete_document_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-other-3", "otheruser")
    res = test_client.delete("/api/library/doc-other-3/permanent")
    assert res.status_code == 404

    db = isolated_dirs["db"]
    assert db.db_get_document("doc-other-3") is not None, "다른 사용자 문서는 영구삭제도 막혀야 한다"


def test_restore_document_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-other-4", "otheruser")
    isolated_dirs["db"].db_soft_delete_document("doc-other-4")
    res = test_client.post("/api/library/doc-other-4/restore")
    assert res.status_code == 404


def test_update_metadata_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-other-5", "otheruser")
    res = test_client.put("/api/library/doc-other-5/metadata", json={"title": "Hijacked"})
    assert res.status_code == 404


def test_update_metadata_owned_by_self_succeeds(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-mine-2", "testuser")
    res = test_client.put("/api/library/doc-mine-2/metadata", json={"title": "My New Title"})
    assert res.status_code == 200
    assert res.json()["metadata"]["title"] == "My New Title"
    assert isolated_dirs["db"].db_get_document("doc-mine-2")["metadata"]["title"] == "My New Title"

    reloaded = test_client.get("/api/library/doc-mine-2")
    assert reloaded.status_code == 200
    assert reloaded.json()["metadata"]["title"] == "My New Title"


def test_library_list_only_returns_own_documents(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-mine-3", "testuser")
    _create_doc_owned_by(isolated_dirs, "doc-other-6", "otheruser")

    res = test_client.get("/api/library")
    assert res.status_code == 200
    ids = {d["id"] for d in res.json()["documents"]}
    assert ids == {"doc-mine-3"}


def test_library_search_only_returns_own_documents(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document("doc-mine-7", "testuser", "shared_topic.pdf", "/x", 1, {"title": "Attention Paper"})
    db.db_save_document("doc-other-7", "otheruser", "shared_topic2.pdf", "/x", 1, {"title": "Attention Survey"})

    res = test_client.get("/api/library/search", params={"q": "Attention"})
    assert res.status_code == 200
    ids = {d["id"] for d in res.json()["documents"]}
    assert ids == {"doc-mine-7"}


def test_library_search_route_does_not_shadow_document_id_route(test_client, isolated_dirs):
    """/library/search가 /library/{doc_id}보다 먼저 등록되어 있어야, "search"가
    doc_id로 잘못 매칭되지 않는다."""
    res = test_client.get("/api/library/search", params={"q": "nonexistent"})
    assert res.status_code == 200
    assert res.json() == {"documents": [], "total": 0}
