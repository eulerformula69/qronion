import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_operator_page_loads_operator_changelog_only():
    operator_html = read_text("queue/operator.html")

    assert '<script src="/queue/js/operator-changelog.js"></script>' in operator_html
    assert '<script src="/queue/js/app-version.js"></script>' in operator_html
    assert 'id="app-update-notification"' not in operator_html
    assert operator_html.index('app-version.js') < operator_html.index('operator-changelog.js')
    assert 'onclick="openOperatorChangelogHistory()"' in operator_html
    assert "Обновления" in operator_html

    other_pages = [
        "queue/board.html",
        "queue/terminal.html",
        "queue/admin.html",
    ]
    for page in other_pages:
        assert "operator-changelog.js" not in read_text(page)


def test_operator_changelog_is_independent_from_system_version():
    source = read_text("queue/js/operator-changelog.js")

    assert 'CHANGELOG_URL = "/queue/changelog/operator.json"' in source
    assert 'STORAGE_KEY = "operatorChangelogVersion"' in source
    assert "CHECK_INTERVAL_MS = 60000" in source
    assert "ACTIVITY_CHECK_COOLDOWN_MS = 30000" in source
    assert "/system/version" not in source
    assert "operatorAppVersion" not in source
    assert 'cache: "no-store"' in source
    assert "localStorage.setItem(STORAGE_KEY, version)" in source
    assert "localStorage.getItem(STORAGE_KEY) === version" in source
    assert "formatOperatorChangelogTitle(data, version)" in source
    assert "Обновление от ${data.date.trim()}, версия ${version}" in source
    assert "window.openOperatorChangelogHistory" in source
    assert "includePrevious: true" in source
    assert "saveVersion: false" in source


def test_operator_changelog_polling_shows_update_banner_without_modal():
    source = read_text("queue/js/operator-changelog.js")

    assert "pageChangelogVersion = version" in source
    assert "setInterval(() => loadOperatorChangelog({ checkForUpdate: true }), CHECK_INTERVAL_MS)" in source
    assert 'window.showAppUpdateNotification()' in source
    assert 'app-update-notification' not in source

    update_branch = source.index("if (options.checkForUpdate)")
    banner_call = source.index("showUpdateNotification();", update_branch)
    remembered_version = source.index("pageChangelogVersion = version;", banner_call)
    assert banner_call < remembered_version

    update_return = source.index("return;", banner_call)
    modal_call = source.index("showOperatorChangelog(data, options);", update_return)

    assert update_branch < banner_call < update_return < modal_call


def test_operator_changelog_click_check_uses_same_update_path_with_throttle():
    source = read_text("queue/js/operator-changelog.js")

    assert "let lastActivityCheckAt = 0" in source
    assert "function checkOperatorChangelogOnActivity()" in source
    assert "now - lastActivityCheckAt < ACTIVITY_CHECK_COOLDOWN_MS" in source
    assert "lastActivityCheckAt = now" in source
    assert "loadOperatorChangelog({ checkForUpdate: true });" in source
    assert 'document.addEventListener("click", checkOperatorChangelogOnActivity)' in source
    assert "showUpdateNotification();" in source
    assert "showOperatorChangelog(data, options);" in source

    handler = source.index("function checkOperatorChangelogOnActivity()")
    throttled_return = source.index("return;", handler)
    click_check = source.index("loadOperatorChangelog({ checkForUpdate: true });", handler)
    update_branch = source.index("if (options.checkForUpdate)")
    banner_call = source.index("showUpdateNotification();", update_branch)
    modal_call = source.index("showOperatorChangelog(data, options);", banner_call)

    assert handler < throttled_return < click_check
    assert update_branch < banner_call < modal_call


def test_operator_changelog_reload_shows_unread_popup_once():
    source = read_text("queue/js/operator-changelog.js")

    initial_load = source.index("loadOperatorChangelog();")
    interval_load = source.index("setInterval(() => loadOperatorChangelog({ checkForUpdate: true }), CHECK_INTERVAL_MS)")
    read_check = source.index("localStorage.getItem(STORAGE_KEY) === version")
    modal_call = source.index("showOperatorChangelog(data, options);")
    save_read = source.index("localStorage.setItem(STORAGE_KEY, version)")

    assert initial_load < interval_load
    assert read_check < modal_call
    assert save_read < read_check


def test_operator_changelog_fails_silent_on_bad_or_missing_file():
    source = read_text("queue/js/operator-changelog.js")

    assert "if (!response.ok) return;" in source
    assert "if (!isValidChangelog(data)) return;" in source
    assert "console.debug(\"Operator changelog load error:\", error)" in source


def test_operator_changelog_popup_is_centered_over_dimmed_operator_page():
    source = read_text("queue/css/operator.css")

    assert "body.operator-page .operator-changelog-overlay" in source
    assert "background: rgba(0, 0, 0, 0.62);" in source
    assert "body.operator-page .operator-changelog-modal" in source
    assert "text-align: left;" in source
    assert "justify-content: center;" in source


def test_operator_changelog_popup_can_show_previous_entries():
    source = read_text("queue/js/operator-changelog.js")
    css = read_text("queue/css/operator.css")

    assert "getPreviousEntries(data).forEach(entry => appendChangelogEntry(content, entry))" in source
    assert "operator-changelog-content" in source
    assert "operator-changelog-entry" in source
    assert "max-height: min(58vh, 520px);" in css


def test_operator_changelog_uses_playful_read_confirmation():
    source = read_text("queue/js/operator-changelog.js")
    settings_view = read_text("queue/js/admin/views/settings.view.js")
    css = read_text("queue/css/operator.css")

    playful_text = "Нажимая эту кнопку, я подтверждаю, что прочитал(а) все обновления"
    assert playful_text in settings_view
    assert 'const DEFAULT_CONFIRM_BUTTON_TEXT = "Понятно"' in source
    assert "closeButton.textContent = confirmButtonText" in source
    assert "operator_changelog_confirm_button_text" in settings_view
    assert "await loadConfirmationButtonText()" in source
    assert "initOperatorChangelog();" in source
    assert ".operator-changelog-actions .btn-primary" in css
    assert "white-space: normal" in css


def test_operator_changelog_json_has_operator_facing_russian_text():
    data = json.loads(read_text("queue/changelog/operator.json"))

    assert isinstance(data["version"], str)
    assert data["version"].strip()
    assert isinstance(data["date"], str)
    assert data["date"].strip()
    assert "title" not in data
    assert data["changes"]
    assert all(isinstance(item, str) and item.strip() for item in data["changes"])
    assert any("оператор" in item.lower() for item in data["changes"])
    assert data["previous"]
    assert all("version" in item and "date" in item and "changes" in item for item in data["previous"])


def test_operator_changelog_policy_exists():
    policy = read_text("docs/CHANGELOG_POLICY.md")

    assert "`queue/changelog/operator.json` обновляется только" in policy
    assert "Не обновлять operator changelog для изменений табло, терминала, админки, статистики" in policy
    assert "увеличить `version`" in policy
    assert "Писать только то, что важно оператору" in policy
