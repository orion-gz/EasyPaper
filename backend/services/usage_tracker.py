"""
Antigravity CLI 사용량 트래킹
- agy 호출 시마다 카운트 (번역 청크 + 채팅)
- 오늘 / 이번 주 / 이번 달 단위 집계
- DB에 저장 (easypaper.db 활용)
"""

import sqlite3
from datetime import datetime, date, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "easypaper.db"

# 일일 소프트 한도 (agy 정책에 따라 조정 가능)
DAILY_SOFT_LIMIT = 1000  # requests/day 기준


def _conn():
    c = sqlite3.connect(str(DB_PATH))
    c.row_factory = sqlite3.Row
    return c


def init_usage_table():
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS agy_usage (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        TEXT    NOT NULL,           -- ISO timestamp
                day       TEXT    NOT NULL,           -- YYYY-MM-DD
                week      TEXT    NOT NULL,           -- YYYY-Www
                month     TEXT    NOT NULL,           -- YYYY-MM
                call_type TEXT    NOT NULL DEFAULT '' -- 'translate' | 'chat'
            )
        """)
        c.commit()


def record_call(call_type: str = "translate"):
    """agy 호출 한 건 기록"""
    now = datetime.utcnow()
    day = now.strftime("%Y-%m-%d")
    week = now.strftime("%Y-W%W")
    month = now.strftime("%Y-%m")
    with _conn() as c:
        c.execute(
            "INSERT INTO agy_usage (ts, day, week, month, call_type) VALUES (?,?,?,?,?)",
            (now.isoformat(), day, week, month, call_type)
        )
        c.commit()


def get_usage_stats() -> dict:
    """오늘 / 이번 주 / 이번 달 사용량 반환"""
    now = datetime.utcnow()
    today = now.strftime("%Y-%m-%d")
    this_week = now.strftime("%Y-W%W")
    this_month = now.strftime("%Y-%m")

    with _conn() as c:
        day_count = c.execute(
            "SELECT COUNT(*) FROM agy_usage WHERE day=?", (today,)
        ).fetchone()[0]
        week_count = c.execute(
            "SELECT COUNT(*) FROM agy_usage WHERE week=?", (this_week,)
        ).fetchone()[0]
        month_count = c.execute(
            "SELECT COUNT(*) FROM agy_usage WHERE month=?", (this_month,)
        ).fetchone()[0]
        total_count = c.execute(
            "SELECT COUNT(*) FROM agy_usage"
        ).fetchone()[0]

    daily_remaining = max(0, DAILY_SOFT_LIMIT - day_count)
    daily_pct = round(day_count / DAILY_SOFT_LIMIT * 100, 1) if DAILY_SOFT_LIMIT > 0 else 0

    return {
        "today": day_count,
        "this_week": week_count,
        "this_month": month_count,
        "total": total_count,
        "daily_limit": DAILY_SOFT_LIMIT,
        "daily_remaining": daily_remaining,
        "daily_used_pct": daily_pct,
    }
