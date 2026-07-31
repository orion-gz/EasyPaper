"""annotations/memos 서버 미러 엔드포인트 테스트.

localStorage가 원본이고 서버는 best-effort 백업/동기화 미러일 뿐이므로,
1) 저장된 적 없는 문서는 빈 데이터를 에러 없이 반환하고,
2) PUT 후 GET이 동일한 데이터를 그대로 왕복시키며,
3) 다른 사용자 소유 문서는 GET/PUT 모두 404로 막히는지(존재 여부 노출 없이)
확인한다. test_library_ownership_api.py의 fixture/스타일을 그대로 따른다.
"""


def _create_doc_owned_by(isolated_dirs, doc_id: str, username: str):
    db = isolated_dirs["db"]
    db.db_save_document(doc_id, username, "paper.pdf", "/x/paper.pdf", 3, {"title": "Other's Paper"})


def test_get_annotations_with_no_saved_data_returns_empty_shape(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-anno-empty", "testuser")
    res = test_client.get("/api/library/doc-anno-empty/annotations")
    assert res.status_code == 200
    assert res.json() == {"data": {}, "updated_at": None}


def test_get_memos_with_no_saved_data_returns_empty_shape(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-memo-empty", "testuser")
    res = test_client.get("/api/library/doc-memo-empty/memos")
    assert res.status_code == 200
    assert res.json() == {"data": {}, "updated_at": None}


def test_put_then_get_annotations_round_trips(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-anno-rt", "testuser")
    payload = {"data": {"page_1": [{"id": "h1", "text": "hello"}]}}

    put_res = test_client.put("/api/library/doc-anno-rt/annotations", json=payload)
    assert put_res.status_code == 200
    assert put_res.json() == {"status": "ok"}

    get_res = test_client.get("/api/library/doc-anno-rt/annotations")
    assert get_res.status_code == 200
    body = get_res.json()
    assert body["data"] == payload["data"]
    assert body["updated_at"] is not None


def test_put_then_get_memos_round_trips(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-memo-rt", "testuser")
    payload = {"data": {"page_1": [{"id": "m1", "text": "note", "x": 10, "y": 20}]}}

    put_res = test_client.put("/api/library/doc-memo-rt/memos", json=payload)
    assert put_res.status_code == 200
    assert put_res.json() == {"status": "ok"}

    get_res = test_client.get("/api/library/doc-memo-rt/memos")
    assert get_res.status_code == 200
    body = get_res.json()
    assert body["data"] == payload["data"]
    assert body["updated_at"] is not None


def test_get_annotations_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-anno-other", "otheruser")
    res = test_client.get("/api/library/doc-anno-other/annotations")
    assert res.status_code == 404


def test_put_annotations_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-anno-other-2", "otheruser")
    res = test_client.put("/api/library/doc-anno-other-2/annotations", json={"data": {"page_1": []}})
    assert res.status_code == 404

    # 실제로 저장되지 않았어야 한다
    db = isolated_dirs["db"]
    assert db.db_get_annotations("doc-anno-other-2") is None


def test_get_memos_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-memo-other", "otheruser")
    res = test_client.get("/api/library/doc-memo-other/memos")
    assert res.status_code == 404


def test_put_memos_owned_by_other_user_returns_404(test_client, isolated_dirs):
    _create_doc_owned_by(isolated_dirs, "doc-memo-other-2", "otheruser")
    res = test_client.put("/api/library/doc-memo-other-2/memos", json={"data": {"page_1": []}})
    assert res.status_code == 404

    db = isolated_dirs["db"]
    assert db.db_get_memos("doc-memo-other-2") is None


def test_annotations_and_memos_on_nonexistent_document_return_404(test_client, isolated_dirs):
    res_get = test_client.get("/api/library/doc-does-not-exist/annotations")
    assert res_get.status_code == 404
    res_put = test_client.put("/api/library/doc-does-not-exist/annotations", json={"data": {}})
    assert res_put.status_code == 404
    res_get_m = test_client.get("/api/library/doc-does-not-exist/memos")
    assert res_get_m.status_code == 404
    res_put_m = test_client.put("/api/library/doc-does-not-exist/memos", json={"data": {}})
    assert res_put_m.status_code == 404
