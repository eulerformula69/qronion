from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_board_does_not_render_empty_state_cards():
    sources = [
        read_text("web/js/board.js"),
        read_text("web/js/board-lite.js"),
    ]

    for source in sources:
        assert "Нет вызванных талонов" not in source
        assert "Нет вызванных билетов" not in source
        assert "Очередь ожидания пуста" not in source
