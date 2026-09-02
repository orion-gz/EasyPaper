"""
자동 업데이트 확인 서비스
- 현재 실행 중인 커밋(버전) 조회
- 원격(origin/main)과 비교해 새 버전 존재 여부 및 변경 로그(커밋 목록) 조회
- 업데이트 확인 주기 설정 및 마지막 확인 시각, 마지막으로 안내한 버전을
  app_meta 테이블에 저장/조회
"""

import asyncio
import subprocess
from datetime import datetime, timezone
from typing import Optional

from config import get_project_root
from services.db import db_get_meta, db_set_meta

VALID_INTERVALS = ("daily", "weekly", "never")
DEFAULT_INTERVAL = "weekly"

_current_version_cache: Optional[str] = None
_current_version_date_cache: Optional[str] = None


async def _run_git(*args: str, timeout: float = 30.0) -> tuple[int, str, str]:
    """git 명령을 프로젝트 루트에서 실행하고 (returncode, stdout, stderr)를 반환합니다."""
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=get_project_root(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        await proc.wait()
        return 1, "", "git 명령이 시간 초과되었습니다."
    return (
        proc.returncode,
        stdout.decode("utf-8", errors="replace").strip(),
        stderr.decode("utf-8", errors="replace").strip(),
    )


async def get_current_version() -> str:
    """이 프로세스가 현재 실행 중인 커밋의 짧은 해시를 반환합니다.

    실행 중에는 바뀌지 않는 값이라(재시작해야 새 버전이 반영됨) 최초 1회만
    계산해 캐시한다.
    """
    global _current_version_cache
    if _current_version_cache:
        return _current_version_cache
    code, out, _ = await _run_git("rev-parse", "--short", "HEAD")
    _current_version_cache = out if code == 0 and out else "unknown"
    return _current_version_cache


async def get_current_version_date() -> Optional[str]:
    """현재 실행 중인 커밋의 날짜(YYYY-MM-DD)를 반환합니다. 버전 해시 자체는 그대로
    두고, 화면에 표시할 때 사람이 읽기 쉽도록 날짜를 함께 보여주기 위한 값이다."""
    global _current_version_date_cache
    if _current_version_date_cache:
        return _current_version_date_cache
    _current_version_date_cache = await _get_commit_date("HEAD")
    return _current_version_date_cache


async def _get_commit_date(ref: str) -> Optional[str]:
    code, out, _ = await _run_git("log", "-1", "--format=%cd", "--date=format:%Y-%m-%d", ref)
    return out if code == 0 and out else None


async def check_for_update() -> dict:
    """원격 origin/main을 fetch해 현재 버전과 비교합니다.

    반환값: {ok, current_version, current_version_date, latest_version,
    latest_version_date, update_available, changelog, error?}
    changelog는 현재 버전에는 없고 최신 버전에는 있는 커밋들의 {sha, subject} 목록
    (오래된 순 → 최신 순). *_version_date는 해시 자체는 그대로 두고 화면에 표시할
    때 사람이 읽기 쉽도록 덧붙이는 커밋 날짜(YYYY-MM-DD)다.
    """
    current_version = await get_current_version()
    current_version_date = await get_current_version_date()

    fetch_code, _, fetch_err = await _run_git("fetch", "origin", "main")
    if fetch_code != 0:
        return {
            "ok": False,
            "current_version": current_version,
            "current_version_date": current_version_date,
            "latest_version": current_version,
            "latest_version_date": current_version_date,
            "update_available": False,
            "changelog": [],
            "error": f"원격 저장소 확인 실패: {fetch_err or '알 수 없는 오류'}",
        }

    latest_code, latest_out, latest_err = await _run_git("rev-parse", "--short", "origin/main")
    if latest_code != 0 or not latest_out:
        return {
            "ok": False,
            "current_version": current_version,
            "current_version_date": current_version_date,
            "latest_version": current_version,
            "latest_version_date": current_version_date,
            "update_available": False,
            "changelog": [],
            "error": f"최신 버전 확인 실패: {latest_err or '알 수 없는 오류'}",
        }
    latest_version = latest_out

    db_set_meta("last_update_checked_at", datetime.now(timezone.utc).isoformat())

    if latest_version == current_version:
        return {
            "ok": True,
            "current_version": current_version,
            "current_version_date": current_version_date,
            "latest_version": latest_version,
            "latest_version_date": current_version_date,
            "update_available": False,
            "changelog": [],
        }

    latest_version_date = await _get_commit_date("origin/main")
    changelog = await _get_changelog(current_version, "origin/main")
    return {
        "ok": True,
        "current_version": current_version,
        "current_version_date": current_version_date,
        "latest_version": latest_version,
        "latest_version_date": latest_version_date,
        "update_available": True,
        "changelog": changelog,
    }


async def _get_changelog(from_ref: str, to_ref: str) -> list[dict]:
    """from_ref(제외)부터 to_ref(포함)까지의 커밋 목록을 오래된 순으로 반환합니다.

    머지 커밋("Merge pull request ...")은 실제 작업 내용이 아니라 노이즈이므로
    --no-merges로 제외한다.
    """
    code, out, _ = await _run_git(
        "log", "--no-merges", "--pretty=format:%h|%s", f"{from_ref}..{to_ref}"
    )
    if code != 0 or not out:
        return []
    entries = []
    for line in reversed(out.splitlines()):
        if "|" not in line:
            continue
        sha, _, subject = line.partition("|")
        subject = subject.strip()
        if subject:
            entries.append({"sha": sha.strip(), "subject": subject})
    return entries


async def get_repository_changelog_markdown() -> Optional[str]:
    """현재 체크아웃의 커밋 이력을 날짜별 Markdown으로 생성합니다.

    CHANGELOG.md를 사람이 매번 갱신하지 않아도 설정 > 정보에 현재 실행 중인
    코드까지 반영하기 위한 값이다. Git 메타데이터가 없는 패키지 실행 환경에서는
    호출자가 번들된 CHANGELOG.md를 사용할 수 있도록 None을 반환한다.
    """
    code, out, _ = await _run_git(
        "log", "--no-merges", "--date=short",
        "--pretty=format:%cd%x1f%h%x1f%s", "HEAD",
    )
    if code != 0 or not out:
        return None

    lines = [
        "# Changelog", "",
        "EasyPaper의 Git 커밋 이력에서 자동 생성된 변경 이력입니다.", "",
    ]
    current_date = None
    for line in out.splitlines():
        parts = line.split("\x1f", 2)
        if len(parts) != 3:
            continue
        date, sha, subject = (part.strip() for part in parts)
        if not subject:
            continue
        if date != current_date:
            if current_date is not None:
                lines.append("")
            lines.extend([f"## {date}", ""])
            current_date = date
        lines.append(f"- {subject} (`{sha}`)")

    return "\n".join(lines).rstrip() + "\n" if current_date else None


def get_update_check_config() -> dict:
    interval = db_get_meta("update_check_interval") or DEFAULT_INTERVAL
    if interval not in VALID_INTERVALS:
        interval = DEFAULT_INTERVAL
    return {
        "interval": interval,
        "last_checked_at": db_get_meta("last_update_checked_at"),
    }


def set_update_check_interval(interval: str) -> dict:
    if interval not in VALID_INTERVALS:
        raise ValueError(f"잘못된 확인 주기입니다: {interval}")
    db_set_meta("update_check_interval", interval)
    return get_update_check_config()


async def get_post_update_notice() -> dict:
    """직전 재시작으로 버전이 바뀌었다면(=방금 업데이트됨) 딱 한 번만 안내 정보를
    반환합니다. 이미 안내한 버전이면 show=False를 반환하고, 최초 실행(기록이
    아예 없는 경우)에는 지금 버전을 기준값으로만 저장해두고 안내하지 않습니다
    (업데이트된 게 아니라 그냥 처음 뜬 것이므로).
    """
    current_version = await get_current_version()
    current_version_date = await get_current_version_date()
    last_shown = db_get_meta("last_shown_update_version")

    if last_shown is None:
        db_set_meta("last_shown_update_version", current_version)
        return {"show": False, "version": current_version, "version_date": current_version_date, "changelog": []}

    if last_shown == current_version:
        return {"show": False, "version": current_version, "version_date": current_version_date, "changelog": []}

    changelog = await _get_changelog(last_shown, "HEAD")
    db_set_meta("last_shown_update_version", current_version)
    return {"show": True, "version": current_version, "version_date": current_version_date, "changelog": changelog}
