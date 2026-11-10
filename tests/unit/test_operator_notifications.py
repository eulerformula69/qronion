from pathlib import Path

from app.routers.operators import build_service_notification_payload


ROOT = Path(__file__).resolve().parents[2]


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_operator_service_notification_payload_defaults_to_bool():
    payload = build_service_notification_payload(7, "Consultation", 1, 1)

    assert payload == {
        "service_id": 7,
        "service_name": "Consultation",
        "priority": 1,
        "enabled": True,
    }


def test_operator_notification_api_routes_exist():
    source = read_text("app/routers/operators.py")

    assert '"/operator/service-notifications"' in source
    assert '"/operator/service-notifications/{service_id}"' in source
    assert "OperatorServiceNotification" in source
    assert "enabled_by_service_id.get(service.id, True)" in source


def test_operator_details_returns_notification_state():
    source = read_text("app/routers/operators.py")

    assert '"notifications_enabled": item["enabled"]' in source
    assert '"id": item["service_id"]' in source


def test_operator_service_checkboxes_are_rendered_and_saved():
    source = read_text("web/js/operator.js")

    assert "serviceNotificationSettings = new Map" in source
    assert "service-notification-checkbox" in source
    assert "toggleServiceNotification" in source
    assert "/operator/service-notifications/" in source
    assert 'method: "PATCH"' in source


def test_new_ticket_notifications_are_filtered_by_service_setting():
    source = read_text("web/js/operator.js")

    assert "isServiceNotificationEnabled(t.service_id)" in source
    assert "ticketsForNotification" in source
    assert "playNewTicketSound();" in source
    assert "showNewTicketSystemNotification(ticketsForNotification)" in source
