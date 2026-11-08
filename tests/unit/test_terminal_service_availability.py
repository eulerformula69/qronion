from pathlib import Path

from app.models import AVAILABLE_WINDOW_STATUSES


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def read_text(relative_path: str) -> str:
    return (PROJECT_ROOT / relative_path).read_text(encoding="utf-8")


def test_online_and_break_windows_keep_terminal_services_available():
    assert AVAILABLE_WINDOW_STATUSES == {"online", "break"}


def test_terminal_service_paths_keep_automatic_and_manual_status_rules_separate():
    services_router = read_text("app/routers/services.py")
    tickets_router = read_text("app/routers/ticket_creation.py")
    operator_service = read_text("app/services/operators.py")

    assert 'Service.operator_choice_allow_offline == 1' in services_router
    assert 'available_statuses.add("offline")' in tickets_router
    assert 'Service.operator_choice_allow_offline == 1' in operator_service
    assert 'Window.status == "online"' in services_router
