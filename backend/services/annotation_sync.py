"""Versioned, item-level synchronization for annotations and memos."""

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from services.db import get_db


RESOURCES = {"annotations", "memos"}


def _check_resource(resource: str) -> None:
    if resource not in RESOURCES:
        raise ValueError("Unsupported sync resource")


def _legacy_id(resource: str, page_key: str, item: dict, index: int) -> str:
    identity = {key: value for key, value in item.items() if key not in {"id", "version"}}
    encoded = json.dumps(
        [resource, page_key, identity, index], ensure_ascii=False, sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"legacy_{hashlib.sha256(encoded).hexdigest()[:24]}"


def normalize_data(resource: str, data: dict) -> tuple[dict, bool]:
    normalized: dict = {}
    changed = False
    for page_key, raw_items in (data or {}).items():
        if not isinstance(raw_items, list):
            continue
        items = []
        for index, raw_item in enumerate(raw_items):
            if not isinstance(raw_item, dict):
                continue
            item = dict(raw_item)
            if not item.get("id"):
                item["id"] = _legacy_id(resource, page_key, item, index)
                changed = True
            items.append(item)
        normalized[page_key] = items
    return normalized, changed


def empty_snapshot() -> dict:
    return {"data": {}, "updated_at": None, "revision": 0, "item_versions": {}, "tombstones": {}}


def _write(conn, resource: str, doc_id: str, snapshot: dict) -> str:
    updated_at = datetime.now(timezone.utc).isoformat()
    conn.execute(
        f"""INSERT INTO {resource} (doc_id, data, updated_at, revision, item_versions, tombstones)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          data = excluded.data, updated_at = excluded.updated_at,
          revision = excluded.revision, item_versions = excluded.item_versions,
          tombstones = excluded.tombstones""",
        (doc_id, json.dumps(snapshot["data"], ensure_ascii=False), updated_at,
         snapshot["revision"], json.dumps(snapshot["item_versions"]),
         json.dumps(snapshot["tombstones"])),
    )
    snapshot["updated_at"] = updated_at
    return updated_at


def _read(conn, resource: str, doc_id: str) -> Optional[dict]:
    row = conn.execute(
        f"SELECT data, updated_at, revision, item_versions, tombstones FROM {resource} WHERE doc_id = ?",
        (doc_id,),
    ).fetchone()
    if not row:
        return None
    data, normalized = normalize_data(resource, json.loads(row["data"]))
    snapshot = {
        "data": data,
        "updated_at": row["updated_at"],
        "revision": int(row["revision"] or 0),
        "item_versions": json.loads(row["item_versions"] or "{}"),
        "tombstones": json.loads(row["tombstones"] or "{}"),
    }
    if normalized or (data and snapshot["revision"] == 0):
        snapshot["revision"] = max(1, snapshot["revision"])
        for items in data.values():
            for item in items:
                snapshot["item_versions"].setdefault(item["id"], snapshot["revision"])
        _write(conn, resource, doc_id, snapshot)
    return snapshot


def _find(data: dict, item_id: str):
    for page_key, items in data.items():
        for index, item in enumerate(items):
            if item.get("id") == item_id:
                return page_key, index, item
    return None, None, None


def _remove(data: dict, item_id: str):
    page_key, index, item = _find(data, item_id)
    if page_key is not None:
        del data[page_key][index]
        if not data[page_key]:
            del data[page_key]
    return item


def _has_conflict_copy(data: dict, item_id: str, incoming: dict) -> bool:
    comparable = {key: value for key, value in incoming.items() if key not in {"id", "conflict_of"}}
    for items in data.values():
        for item in items:
            if item.get("conflict_of") != item_id:
                continue
            existing = {key: value for key, value in item.items() if key not in {"id", "conflict_of"}}
            if existing == comparable:
                return True
    return False


def get_snapshot(resource: str, doc_id: str) -> Optional[dict]:
    _check_resource(resource)
    with get_db() as conn:
        snapshot = _read(conn, resource, doc_id)
        conn.commit()
        return snapshot


def legacy_merge(resource: str, doc_id: str, incoming: dict) -> dict:
    """Merge legacy PUT data; a missing item never means delete."""
    _check_resource(resource)
    incoming, _ = normalize_data(resource, incoming)
    with get_db() as conn:
        snapshot = _read(conn, resource, doc_id) or empty_snapshot()
        for page_key, items in incoming.items():
            for incoming_item in items:
                item = incoming_item
                item_id = item["id"]
                if item_id in snapshot["tombstones"]:
                    continue
                _, _, existing = _find(snapshot["data"], item_id)
                if existing == item:
                    continue
                if existing is not None:
                    if _has_conflict_copy(snapshot["data"], item_id, item):
                        continue
                    item = {**item, "id": str(uuid.uuid4()), "conflict_of": item_id}
                    item_id = item["id"]
                snapshot["revision"] += 1
                snapshot["data"].setdefault(page_key, []).append(item)
                snapshot["item_versions"][item_id] = snapshot["revision"]
        _write(conn, resource, doc_id, snapshot)
        conn.commit()
        return snapshot


def apply_mutations(resource: str, doc_id: str, client_id: str, mutations: list[dict]) -> dict:
    _check_resource(resource)
    results = []
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        snapshot = _read(conn, resource, doc_id) or empty_snapshot()
        changed = False
        for mutation in mutations:
            mutation_id = mutation["mutation_id"]
            prior = conn.execute(
                """SELECT result FROM annotation_mutations
                   WHERE resource = ? AND doc_id = ? AND client_id = ? AND mutation_id = ?""",
                (resource, doc_id, client_id, mutation_id),
            ).fetchone()
            if prior:
                result = json.loads(prior["result"])
                result["already_applied"] = True
                results.append(result)
                continue

            item_id = mutation["item_id"]
            base_version = int(mutation.get("base_version") or 0)
            tombstone = snapshot["tombstones"].get(item_id) or {}
            current_version = int(snapshot["item_versions"].get(item_id) or tombstone.get("version", 0))
            page_key, _, current_item = _find(snapshot["data"], item_id)
            result = {"mutation_id": mutation_id, "item_id": item_id, "applied": False,
                      "already_applied": False, "conflict_copy": False,
                      "delete_conflict_preserved": False}

            if mutation["operation"] == "delete":
                if item_id in snapshot["tombstones"]:
                    result["already_applied"] = True
                elif current_item is not None and base_version == current_version:
                    _remove(snapshot["data"], item_id)
                    snapshot["revision"] += 1
                    snapshot["item_versions"][item_id] = snapshot["revision"]
                    snapshot["tombstones"][item_id] = {"version": snapshot["revision"], "page_key": page_key}
                    result["applied"], changed = True, True
                elif current_item is not None:
                    result["delete_conflict_preserved"] = True
                else:
                    snapshot["revision"] += 1
                    snapshot["item_versions"][item_id] = snapshot["revision"]
                    snapshot["tombstones"][item_id] = {
                        "version": snapshot["revision"], "page_key": mutation.get("page_key")}
                    result["applied"], changed = True, True
            else:
                item = {**(mutation.get("item") or {}), "id": item_id}
                if current_item == item:
                    result["already_applied"] = True
                elif current_item is None and item_id not in snapshot["tombstones"] and base_version == 0:
                    snapshot["revision"] += 1
                    snapshot["data"].setdefault(mutation["page_key"], []).append(item)
                    snapshot["item_versions"][item_id] = snapshot["revision"]
                    result["applied"], changed = True, True
                elif current_item is not None and base_version == current_version:
                    _remove(snapshot["data"], item_id)
                    snapshot["revision"] += 1
                    snapshot["data"].setdefault(mutation["page_key"], []).append(item)
                    snapshot["item_versions"][item_id] = snapshot["revision"]
                    result["applied"], changed = True, True
                else:
                    copy_id = str(uuid.uuid4())
                    copy_item = {**item, "id": copy_id, "conflict_of": item_id}
                    snapshot["revision"] += 1
                    snapshot["data"].setdefault(mutation["page_key"], []).append(copy_item)
                    snapshot["item_versions"][copy_id] = snapshot["revision"]
                    result.update({"conflict_copy": True, "conflict_copy_id": copy_id})
                    changed = True

            conn.execute(
                """INSERT INTO annotation_mutations
                   (resource, doc_id, client_id, mutation_id, result, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (resource, doc_id, client_id, mutation_id, json.dumps(result),
                 datetime.now(timezone.utc).isoformat()),
            )
            results.append(result)

        if changed:
            _write(conn, resource, doc_id, snapshot)
        conn.commit()
    return {**snapshot, "results": results}
