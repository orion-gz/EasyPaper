from main import app


def test_install_endpoints_only_allow_post():
    expected = {
        "/api/settings/install-ollama",
        "/api/settings/install-claude-code",
        "/api/settings/install-codex",
        "/api/settings/install-antigravity",
    }
    routes = {route.path: route.methods for route in app.routes if route.path in expected}

    assert routes.keys() == expected
    assert all(methods == {"POST"} for methods in routes.values())
