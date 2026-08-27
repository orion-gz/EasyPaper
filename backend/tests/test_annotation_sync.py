def _doc(isolated_dirs, doc_id="sync-doc", username="testuser"):
    isolated_dirs["db"].db_save_document(doc_id, username, "paper.pdf", "/x/paper.pdf", 2, {})


def _mutation(mid, operation, item_id, page_key="page_1", base_version=0, item=None):
    value = {"mutation_id": mid, "operation": operation, "item_id": item_id,
             "page_key": page_key, "base_version": base_version}
    if item is not None:
        value["item"] = item
    return value


def _patch(client, resource, client_id, mutations, doc_id="sync-doc"):
    return client.patch(f"/api/library/{doc_id}/{resource}", json={
        "client_id": client_id, "mutations": mutations,
    })


def test_init_db_adds_sync_columns_to_legacy_tables(isolated_dirs):
    db = isolated_dirs["db"]
    with db.get_db() as conn:
        conn.execute("DROP TABLE annotation_mutations")
        conn.execute("DROP TABLE annotations")
        conn.execute("DROP TABLE memos")
        conn.execute("CREATE TABLE annotations (doc_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)")
        conn.execute("CREATE TABLE memos (doc_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)")
        conn.commit()

    db.init_db()

    with db.get_db() as conn:
        annotation_columns = {row[1] for row in conn.execute("PRAGMA table_info(annotations)")}
        memo_columns = {row[1] for row in conn.execute("PRAGMA table_info(memos)")}
        mutation_table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'annotation_mutations'"
        ).fetchone()
    assert {"revision", "item_versions", "tombstones"}.issubset(annotation_columns)
    assert {"revision", "item_versions", "tombstones"}.issubset(memo_columns)
    assert mutation_table is not None


def test_schema_migrates_existing_blob_and_assigns_ids(isolated_dirs):
    db = isolated_dirs["db"]
    _doc(isolated_dirs)
    with db.get_db() as conn:
        conn.execute("INSERT INTO annotations (doc_id, data, updated_at) VALUES (?, ?, ?)",
                     ("sync-doc", '{"page_1":[{"text":"old","startOffset":1}]}', "old"))
        conn.commit()
    snapshot = db.db_get_annotations("sync-doc")
    item = snapshot["data"]["page_1"][0]
    assert item["id"].startswith("legacy_")
    assert snapshot["revision"] == 1
    assert snapshot["item_versions"][item["id"]] == 1


def test_independent_items_merge_and_retry_is_idempotent(test_client, isolated_dirs):
    _doc(isolated_dirs)
    first = _mutation("m1", "upsert", "a", item={"id": "a", "text": "A"})
    second = _mutation("m2", "upsert", "b", item={"id": "b", "text": "B"})
    assert _patch(test_client, "annotations", "mac", [first]).status_code == 200
    response = _patch(test_client, "annotations", "windows", [second]).json()
    assert {item["id"] for item in response["data"]["page_1"]} == {"a", "b"}
    retry = _patch(test_client, "annotations", "windows", [second]).json()
    assert retry["revision"] == response["revision"]
    assert retry["results"][0]["already_applied"] is True


def test_stale_update_creates_conflict_copy(test_client, isolated_dirs):
    _doc(isolated_dirs)
    created = _patch(test_client, "memos", "mac", [
        _mutation("create", "upsert", "memo", item={"id": "memo", "content": "original"})
    ]).json()
    version = created["item_versions"]["memo"]
    updated = _patch(test_client, "memos", "mac", [
        _mutation("edit", "upsert", "memo", base_version=version,
                  item={"id": "memo", "content": "server edit"})
    ]).json()
    conflict = _patch(test_client, "memos", "windows", [
        _mutation("stale", "upsert", "memo", base_version=version,
                  item={"id": "memo", "content": "local edit"})
    ]).json()
    assert conflict["results"][0]["conflict_copy"] is True
    assert {item["content"] for item in conflict["data"]["page_1"]} == {"server edit", "local edit"}
    assert updated["revision"] + 1 == conflict["revision"]


def test_stale_delete_preserves_newer_server_item(test_client, isolated_dirs):
    _doc(isolated_dirs)
    created = _patch(test_client, "memos", "one", [
        _mutation("create", "upsert", "memo", item={"id": "memo", "content": "v1"})
    ]).json()
    old_version = created["item_versions"]["memo"]
    _patch(test_client, "memos", "one", [
        _mutation("update", "upsert", "memo", base_version=old_version,
                  item={"id": "memo", "content": "v2"})
    ])
    response = _patch(test_client, "memos", "two", [
        _mutation("delete", "delete", "memo", base_version=old_version)
    ]).json()
    assert response["results"][0]["delete_conflict_preserved"] is True
    assert response["data"]["page_1"][0]["content"] == "v2"


def test_stale_update_after_delete_is_preserved_as_conflict_copy(test_client, isolated_dirs):
    _doc(isolated_dirs)
    created = _patch(test_client, "memos", "one", [
        _mutation("create", "upsert", "memo", item={"id": "memo", "content": "v1"})
    ]).json()
    version = created["item_versions"]["memo"]
    _patch(test_client, "memos", "one", [
        _mutation("delete", "delete", "memo", base_version=version)
    ])
    conflict = _patch(test_client, "memos", "two", [
        _mutation("stale-edit", "upsert", "memo", base_version=version,
                  item={"id": "memo", "content": "offline edit"})
    ]).json()
    assert conflict["results"][0]["conflict_copy"] is True
    assert conflict["data"]["page_1"][0]["content"] == "offline edit"
    assert "memo" in conflict["tombstones"]


def test_retried_legacy_conflict_does_not_duplicate_copy(test_client, isolated_dirs):
    _doc(isolated_dirs)
    payload = {"data": {"page_1": [{"id": "memo", "content": "server"}]}}
    assert test_client.put("/api/library/sync-doc/memos", json=payload).status_code == 200
    stale = {"data": {"page_1": [{"id": "memo", "content": "local"}]}}
    assert test_client.put("/api/library/sync-doc/memos", json=stale).status_code == 200
    first = test_client.get("/api/library/sync-doc/memos").json()
    assert test_client.put("/api/library/sync-doc/memos", json=stale).status_code == 200
    retried = test_client.get("/api/library/sync-doc/memos").json()
    assert len(retried["data"]["page_1"]) == 2
    assert retried["revision"] == first["revision"]


def test_delete_tombstone_blocks_legacy_resurrection(test_client, isolated_dirs):
    _doc(isolated_dirs)
    created = _patch(test_client, "annotations", "one", [
        _mutation("create", "upsert", "a", item={"id": "a", "text": "old"})
    ]).json()
    deleted = _patch(test_client, "annotations", "one", [
        _mutation("delete", "delete", "a", base_version=created["item_versions"]["a"])
    ]).json()
    assert "a" in deleted["tombstones"]
    assert test_client.put("/api/library/sync-doc/annotations", json={
        "data": {"page_1": [{"id": "a", "text": "old"}]},
    }).status_code == 200
    assert test_client.get("/api/library/sync-doc/annotations").json()["data"] == {}


def test_patch_enforces_ownership_and_payload_limit(test_client, isolated_dirs):
    _doc(isolated_dirs, "other-doc", "otheruser")
    denied = _patch(test_client, "memos", "client", [
        _mutation("m", "upsert", "x", item={"id": "x"})
    ], "other-doc")
    assert denied.status_code == 404
    _doc(isolated_dirs, "large-doc")
    large = _patch(test_client, "memos", "client", [
        _mutation("large", "upsert", "x", item={"id": "x", "content": "x" * (5 * 1024 * 1024)})
    ], "large-doc")
    assert large.status_code == 422
