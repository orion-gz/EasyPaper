"""
pytest 공용 fixture.

이 프로젝트는 UPLOAD_DIR/LIBRARY_DIR/CACHE_DIR/DB_PATH 등을 각 모듈이 import
시점에 자기 네임스페이스로 직접 바인딩해두는 구조라(`from config import
LIBRARY_DIR` 등), 테스트에서 실제 데이터를 건드리지 않으려면 config.py가
아니라 그 값을 실제로 사용하는 모듈(services.db/services.cache/
services.library)의 속성을 직접 monkeypatch해야 한다. 함수 본문은 그 값을
매 호출 시 모듈 전역에서 다시 읽으므로(재로드 불필요) 이 방식으로 충분하다.
"""

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest


@pytest.fixture()
def isolated_dirs(tmp_path, monkeypatch):
    """UPLOAD_DIR/LIBRARY_DIR/CACHE_DIR/DB_PATH를 임시 디렉터리로 격리한다."""
    import services.db as db
    import services.cache as cache
    import services.library as library

    upload_dir = tmp_path / "uploads"
    library_dir = tmp_path / "library"
    cache_dir = tmp_path / "cache"
    db_path = tmp_path / "test_easypaper.db"

    upload_dir.mkdir()
    library_dir.mkdir()
    cache_dir.mkdir()

    monkeypatch.setattr(db, "DB_PATH", str(db_path))
    monkeypatch.setattr(cache, "CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(library, "LIBRARY_DIR", str(library_dir))
    monkeypatch.setattr(library, "UPLOAD_DIR", str(upload_dir))

    db.init_db()

    return {
        "upload_dir": upload_dir,
        "library_dir": library_dir,
        "cache_dir": cache_dir,
        "db_path": db_path,
        "db": db,
        "cache": cache,
        "library": library,
    }


@pytest.fixture()
def test_client(isolated_dirs, monkeypatch):
    """격리된 DB 위에서 FastAPI 앱을 띄우고, 인증은 dependency override로
    우회한 TestClient를 반환한다 (실제 로그인 플로우 없이 라우터 로직만 검증)."""
    from fastapi.testclient import TestClient
    from main import app
    from services.auth import get_current_user, require_admin_user

    app.dependency_overrides[get_current_user] = lambda: "testuser"
    # The fixture exercises legacy system-management routes without performing
    # authentication. Model the master role explicitly now that Lab Mode has RBAC.
    app.dependency_overrides[require_admin_user] = lambda: "testuser"
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(require_admin_user, None)
