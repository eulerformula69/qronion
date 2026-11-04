from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_board_marks_deferred_ticket_with_operator_window_note():
    source = (ROOT / "queue" / "js" / "board.js").read_text(encoding="utf-8")

    assert 't.status === "deferred"' in source
    assert "Отложен оператором" in source
    assert "t.window_name" in source
    assert "waiting-deferred-note" in source


def test_deferred_ticket_note_has_secondary_text_style():
    source = (ROOT / "queue" / "css" / "board.css").read_text(encoding="utf-8")

    assert ".waiting-deferred-note" in source


def test_media_profile_uses_lite_deferred_ticket_renderer():
    script = (ROOT / "queue" / "js" / "board-lite.js").read_text(encoding="utf-8")
    bootstrap = (ROOT / "queue" / "js" / "board-bootstrap.js").read_text(encoding="utf-8")

    assert "Отложен оператором" in script
    assert 'screen === "media"' in bootstrap
    assert '/queue/js/board-lite.js' in bootstrap
