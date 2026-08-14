"""PDF parser package-management endpoints must require authentication."""

import pytest


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        (
            "get",
            "/api/settings/install-pdf-parser",
            {"params": {"parser_id": "unsupported"}},
        ),
        (
            "post",
            "/api/settings/uninstall-pdf-parser",
            {"json": {"parser_id": "unsupported"}},
        ),
    ],
)
def test_pdf_parser_package_management_rejects_unauthenticated_requests(
    test_client, monkeypatch, method, path, kwargs
):
    """Authentication must run before parser validation or package operations."""
    from main import app
    import services.auth as auth_service

    app.dependency_overrides.pop(auth_service.get_current_user, None)
    monkeypatch.setattr(auth_service, "get_skip_login", lambda: False)

    response = getattr(test_client, method)(path, **kwargs)

    assert response.status_code == 401
    assert response.json() == {"detail": "로그인이 필요합니다."}
