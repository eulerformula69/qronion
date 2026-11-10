from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_terminal_reprint_uses_touch_keypad_instead_of_keyboard_input():
    source = (ROOT / "web/js/terminal-reprint.js").read_text(encoding="utf-8")

    assert 'id="terminal-reprint-number"' in source
    assert "readonly" in source
    assert "terminal-reprint-keypad" in source
    assert "data-reprint-digit" in source
    assert "appendReprintDigit" in source
    assert 'type="number"' not in source
