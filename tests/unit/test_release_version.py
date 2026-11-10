from pathlib import Path

from fastapi.testclient import TestClient

from app.application import app
from app.release_middleware import _version_html


ROOT = Path(__file__).resolve().parents[2]


def test_changelog_update_button_only_loads_on_operator_page():
    operator_source = (ROOT / "web" / "operator.html").read_text(encoding="utf-8")
    assert '/js/app-version.js' in operator_source

    pages_without_update_button = [
        "login.html",
        "admin.html",
        "terminal.html",
        "board.html",
    ]

    for page_name in pages_without_update_button:
        source = (ROOT / "web" / page_name).read_text(encoding="utf-8")
        assert '/js/app-version.js' not in source, page_name


def test_changelog_update_notification_offers_one_click_reload_without_polling_system_version():
    source = (ROOT / "web" / "js" / "app-version.js").read_text(encoding="utf-8")

    assert 'button.textContent = "Обновить"' in source
    assert 'window.location.reload()' in source
    assert 'window.showAppUpdateNotification = showUpdateNotification' in source
    assert 'notification.id = "app-release-notification"' in source
    assert '/system/version' not in source
    assert 'setInterval' not in source


def test_html_assets_receive_release_version():
    source = b'<head><link href="/css/base.css"></head><script src="/js/app.js"></script>'

    result = _version_html(source, "abc123")

    assert b'<meta name="app-version" content="abc123">' in result
    assert b'/css/base.css?v=abc123' in result
    assert b'/js/app.js?v=abc123' in result


def test_version_endpoint_and_html_are_not_cached():
    client = TestClient(app)

    version_response = client.get("/system/version")
    html_response = client.get("/login.html")

    assert version_response.headers["cache-control"] == "no-store"
    assert html_response.headers["cache-control"] == "no-store"
    assert '<meta name="app-version"' in html_response.text
    assert '/js/app-version.js' not in html_response.text


def test_home_and_old_board_bookmark_open_the_new_pages():
    client = TestClient(app)
    for original, destination in [
        ("/", "/login.html"),
        ("/queue/board.html?screen=media", "/board.html?screen=media"),
    ]:
        response = client.get(original)
        assert response.status_code == 200
        assert str(response.url) == "http://testserver" + destination
        assert '<meta name="app-version"' in response.text
