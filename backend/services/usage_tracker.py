"""
Antigravity CLI 사용량 트래킹
- agy 호출 시마다 카운트 (번역 청크 + 채팅)
- 오늘 / 이번 주 / 이번 달 단위 집계
- DB에 저장 (easypaper.db 활용)
"""

import os
import sqlite3
from datetime import datetime, date, timedelta, timezone
from pathlib import Path

# DB_PATH 환경변수가 있으면 그대로 쓰고(Docker/데스크탑 앱 등에서 데이터 볼륨/
# 사용자 데이터 디렉토리 경로로 오버라이드), 없으면 기존과 동일하게 backend/
# 상대경로로 폴백한다. services/db.py의 DB_PATH와 동일한 파일을 가리켜야
# 하는데 이쪽만 env override를 지원하지 않아 패키징된 앱에서 사용량 기록이
# db.py가 쓰는 실제 DB와 다른 파일에 저장되거나 쓰기 실패할 수 있었다.
DB_PATH = os.getenv("DB_PATH") or str(Path(__file__).parent.parent / "easypaper.db")

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
    now = datetime.now(timezone.utc)
    day = now.strftime("%Y-%m-%d")
    week = now.strftime("%Y-W%W")
    month = now.strftime("%Y-%m")
    with _conn() as c:
        c.execute(
            "INSERT INTO agy_usage (ts, day, week, month, call_type) VALUES (?,?,?,?,?)",
            (now.isoformat(), day, week, month, call_type)
        )
        c.commit()


def _get_antigravity_cloud_quota(retry=True) -> dict:
    import os
    import json
    import urllib.request
    import urllib.error
    import subprocess
    import sys

    # Add parent directory to sys.path to allow imports from config if needed
    sys.path.append(str(Path(__file__).parent.parent))
    try:
        from config import get_agy_path, get_agy_env
    except ImportError:
        def get_agy_path():
            import shutil
            return shutil.which("agy") or "agy"
        def get_agy_env():
            env = os.environ.copy()
            if "HOME" not in env or not env["HOME"]:
                env["HOME"] = os.path.expanduser("~")
            if "USER" not in env or not env["USER"]:
                try:
                    import getpass
                    env["USER"] = getpass.getuser()
                except Exception:
                    pass
            return env

    token_path = os.path.expanduser("~/.gemini/antigravity-cli/antigravity-oauth-token")
    if not os.path.exists(token_path):
        return None

    try:
        with open(token_path, "r") as f:
            token_data = json.load(f)
    except Exception:
        return None

    access_token = token_data.get("token", {}).get("access_token")
    if not access_token:
        return None

    url = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }

    try:
        req = urllib.request.Request(url, headers=headers, method="POST", data=b"{}")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            buckets = data.get("buckets", [])
            if not buckets:
                return None
            
            # Find the minimum remaining fraction
            min_fraction = min(b.get("remainingFraction", 1.0) for b in buckets)
            
            # Map remaining fraction to request numbers
            daily_limit = DAILY_SOFT_LIMIT
            daily_remaining = int(min_fraction * daily_limit)
            today_count = daily_limit - daily_remaining
            daily_pct = round((1.0 - min_fraction) * 100, 1)

            # Get database totals for this week/month/total as context
            now = datetime.now(timezone.utc)
            this_week = now.strftime("%Y-W%W")
            this_month = now.strftime("%Y-%m")
            try:
                with _conn() as c:
                    week_count = c.execute(
                        "SELECT COUNT(*) FROM agy_usage WHERE week=?", (this_week,)
                    ).fetchone()[0]
                    month_count = c.execute(
                        "SELECT COUNT(*) FROM agy_usage WHERE month=?", (this_month,)
                    ).fetchone()[0]
                    total_count = c.execute(
                        "SELECT COUNT(*) FROM agy_usage"
                    ).fetchone()[0]
            except Exception:
                week_count = today_count
                month_count = today_count
                total_count = today_count

            # Ensure total/month/week counts are at least equal to today's count
            week_count = max(week_count, today_count)
            month_count = max(month_count, today_count)
            total_count = max(total_count, today_count)

            return {
                "today": today_count,
                "this_week": week_count,
                "this_month": month_count,
                "total": total_count,
                "daily_limit": daily_limit,
                "daily_remaining": daily_remaining,
                "daily_used_pct": daily_pct,
            }

    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and retry:
            agy_path = get_agy_path()
            if not os.path.exists(agy_path):
                agy_path = "agy"
            try:
                subprocess.run(
                    [agy_path, "--dangerously-skip-permissions", "models"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5.0,
                    env=get_agy_env()
                )
                return _get_antigravity_cloud_quota(retry=False)
            except Exception:
                pass
        return None
    except Exception:
        return None


def get_usage_stats() -> dict:
    """오늘 / 이번 주 / 이번 달 사용량 반환"""
    # Try fetching cloud quota first
    real_stats = _get_antigravity_cloud_quota()
    if real_stats:
        return real_stats

    # Fallback to local DB stats
    now = datetime.now(timezone.utc)
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

