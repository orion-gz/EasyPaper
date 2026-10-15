"""Keyword navigation over the current user's documents, notes and questions."""
import json
from services.db import get_db, db_search_documents, _escape_like


def search_workspace(username: str, query: str, mode: str) -> list[dict]:
    query = query.strip()
    if query:
        docs = db_search_documents(username, query, document_mode=mode, limit=20)
    else:
        with get_db() as conn:
            rows = conn.execute(
                """SELECT id, filename, metadata FROM documents
                   WHERE username=? AND is_deleted=0 AND document_mode=?
                   ORDER BY COALESCE(NULLIF(json_extract(metadata, '$.last_read_at'), ''), created_at) DESC
                   LIMIT 20""", (username, mode),
            ).fetchall()
        docs = [dict(row) | {'metadata': json.loads(row['metadata'] or '{}')} for row in rows]
    results = [{'kind': 'document', 'doc_id': doc['id'], 'title': doc.get('metadata', {}).get('title') or doc['filename'], 'text': doc['filename']} for doc in docs[:20]]
    if not query:
        return results
    with get_db() as conn:
        memo_results = _search_memos(conn, username, mode, query)
        questions = conn.execute(
            '''SELECT c.doc_id, c.content, d.filename,
                      (SELECT COUNT(*) FROM chats previous WHERE previous.doc_id=c.doc_id
                       AND previous.role='user' AND previous.id<c.id) AS question_index
               FROM chats c JOIN documents d ON d.id=c.doc_id
               WHERE d.username=? AND d.is_deleted=0 AND d.document_mode=? AND c.role='user'
               AND c.content LIKE ? ESCAPE '\\' ORDER BY c.id DESC LIMIT 20''',
            (username, mode, '%' + _escape_like(query) + '%'),
        ).fetchall()
    results.extend(memo_results)
    for row in questions:
        results.append({'kind': 'question', 'doc_id': row['doc_id'], 'title': row['filename'], 'text': _snippet(row['content'], query), 'question': row['question_index']})
    return results


def _snippet(text: str, query: str) -> str:
    index = text.casefold().find(query.casefold())
    start = max(0, index - 45)
    return ('…' if start else '') + text[start:start + 180] + ('…' if len(text) > start + 180 else '')


def _search_memos(conn, username: str, mode: str, query: str) -> list[dict]:
    # Stream rows and stop once the result budget is exhausted. Preserve Unicode
    # casefold semantics instead of SQLite's ASCII-only LOWER/LIKE matching.
    memos = conn.execute(
        """SELECT m.doc_id, m.data, d.filename FROM memos m JOIN documents d ON d.id=m.doc_id
           WHERE d.username=? AND d.is_deleted=0 AND d.document_mode=? ORDER BY d.id""",
        (username, mode),
    )
    results = []
    for row in memos:
        try:
            data = json.loads(row['data'])
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        for page, items in data.items():
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                text = str(item.get('content') or '')
                if query.casefold() not in text.casefold():
                    continue
                try:
                    page_number = int(page.removeprefix('page_').removeprefix('section_'))
                except ValueError:
                    continue
                results.append({'kind': 'memo', 'doc_id': row['doc_id'], 'title': row['filename'], 'text': _snippet(text, query), 'page': page_number, 'memo_id': item.get('id')})
                if len(results) == 20:
                    return results
    return results
