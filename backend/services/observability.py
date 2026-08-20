"""Privacy-preserving document-mode operational metrics."""
from __future__ import annotations
from datetime import datetime, timezone

ALLOWED_EVENTS = {
    "upload", "translation", "chat_retrieval", "chat_citation", "overview",
    "vocabulary", "workspace_switch", "screen_error",
}


def record_document_mode_event(username: str, event: str, document_mode: str | None = None,
                               document_type: str | None = None, status: str = "ok",
                               duration_ms: int | None = None, numeric_value: float | None = None) -> None:
    """Record only categorical/timing values; document text and prompts are never accepted."""
    if event not in ALLOWED_EVENTS:
        raise ValueError("unsupported metric event")
    from services.db import get_db
    with get_db() as conn:
        conn.execute(
            """INSERT INTO document_mode_metrics
               (username,event,document_mode,document_type,status,duration_ms,numeric_value,created_at)
               VALUES(?,?,?,?,?,?,?,?)""",
            (username, event, document_mode, document_type, status,
             max(0, int(duration_ms)) if duration_ms is not None else None,
             float(numeric_value) if numeric_value is not None else None,
             datetime.now(timezone.utc).isoformat()),
        )
        # 지표는 원문 없이도 운영 판단에 충분하며 90일 이후 자동 만료한다.
        conn.execute("DELETE FROM document_mode_metrics WHERE created_at < datetime('now', '-90 days')")
        conn.commit()


def summarize_document_mode_metrics(username: str) -> list[dict]:
    from services.db import get_db
    with get_db() as conn:
        rows = conn.execute(
            """SELECT event, document_mode, document_type, status, COUNT(*) AS count,
                      ROUND(AVG(duration_ms), 1) AS avg_duration_ms,
                      ROUND(AVG(numeric_value), 3) AS avg_numeric_value
               FROM document_mode_metrics WHERE username = ?
               GROUP BY event, document_mode, document_type, status
               ORDER BY event, document_mode, document_type, status""",
            (username,),
        ).fetchall()
    return [dict(row) for row in rows]
