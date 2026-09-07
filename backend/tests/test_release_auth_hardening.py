import asyncio

from main import app
from routers import upload
from routers.auth import ChangeCredentialsRequest, change_credentials
from services import auth


def test_password_hash_change_invalidates_existing_session(monkeypatch):
    password_hash = "old-hash"
    monkeypatch.setattr(auth, "get_app_password_hash", lambda: password_hash)
    token = auth.create_session_token("admin")
    assert auth.verify_session_token(token) is True

    password_hash = "new-hash"
    assert auth.verify_session_token(token) is False


def test_cors_uses_configured_origins_only():
    middleware = next(item for item in app.user_middleware if item.cls.__name__ == "CORSMiddleware")
    assert middleware.kwargs["allow_origins"] != ["*"]
    assert "http://localhost:5173" in middleware.kwargs["allow_origins"]


def test_credential_rename_updates_open_sessions(monkeypatch):
    upload.sessions["doc"] = {"username": "admin"}
    monkeypatch.setattr("services.db.get_user", lambda _username: {"password_hash": auth.hash_password("old")})
    monkeypatch.setattr("services.db.update_user_credentials", lambda *_args: True)
    monkeypatch.setattr("routers.auth.update_credentials_in_env", lambda *_args: None)

    response = type("Response", (), {"set_cookie": lambda *args, **kwargs: None})()
    body = ChangeCredentialsRequest(current_password="old", new_username="renamed", new_password="new")
    asyncio.run(change_credentials(response, body, "admin"))

    assert upload.sessions["doc"]["username"] == "renamed"
    upload.sessions.pop("doc", None)
