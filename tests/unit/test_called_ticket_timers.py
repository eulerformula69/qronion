from datetime import datetime, timedelta
from pathlib import Path

from app.models import Ticket
from app.services.tickets import (
    called_ticket_wait_remaining_seconds,
    recall_cooldown_remaining_seconds,
)


ROOT = Path(__file__).resolve().parents[2]


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_called_ticket_wait_is_enforced_from_server_time():
    now = datetime(2026, 7, 18, 12, 0, 0)
    ticket = Ticket(service_started_at=now - timedelta(seconds=45))

    assert called_ticket_wait_remaining_seconds(ticket, 180, now=now) == 135
    assert called_ticket_wait_remaining_seconds(
        ticket,
        180,
        now=now + timedelta(seconds=135),
    ) == 0


def test_ticket_without_service_started_at_has_no_artificial_wait():
    assert called_ticket_wait_remaining_seconds(
        Ticket(service_started_at=None), 180
    ) == 0


def test_operator_restores_service_timer_from_service_started_at():
    operator_source = read_text("web/js/operator.js")
    timer_source = read_text("web/js/operator-ticket-timers.js")
    html = read_text("web/operator.html")

    assert "currentTicketServiceStartedAt = parseTicketServiceStartedAt(ticket);" in operator_source
    assert "calledTicketWaitRemainingSeconds" in timer_source
    assert "currentTicketFinishRemainingSeconds" in timer_source
    assert "performance.now()" in timer_source
    assert "setInterval(updateCalledTicketTimers, 1000)" in timer_source
    assert 'id="service-timer-value"' in html
    assert 'id="service-timer" class="service-timer" aria-live="off" hidden' in html
    assert "serviceTimerContainer.hidden = !hasServerStartTime" in timer_source
    assert "Завершить через" in timer_source


def test_finish_button_uses_wait_state_but_other_actions_do_not():
    state_source = read_text("web/js/operator-ui-state.js")
    css = read_text("web/css/operator.css")

    assert 'button.id === "finish-btn" && isCalledTicketWaitActive()' in state_source
    assert '"current-ticket-action-inactive"' in state_source
    assert ".current-ticket-action-inactive" in css


def test_recall_cooldown_uses_latest_server_timestamp():
    now = datetime(2026, 7, 18, 12, 0, 10)
    ticket = Ticket(
        called_at=now - timedelta(seconds=30),
        last_recalled_at=now - timedelta(seconds=4),
    )

    assert recall_cooldown_remaining_seconds(ticket, now=now) == 6
    assert recall_cooldown_remaining_seconds(
        ticket,
        now=now + timedelta(seconds=6),
    ) == 0


def test_recall_cooldown_restores_from_server_state_after_reload():
    operator_source = read_text("web/js/operator.js")
    timer_source = read_text("web/js/operator-ticket-timers.js")
    state_source = read_text("web/js/operator-ui-state.js")

    assert "currentTicketRecallRemainingSeconds" in operator_source
    assert "recallCooldownRemainingSeconds" in timer_source
    assert "syncRecallCooldown();" in operator_source
    assert "waitingBeforeRecall" in state_source


def test_current_ticket_api_returns_server_authoritative_countdowns():
    router_source = read_text("app/routers/tickets.py")
    current_endpoint = router_source.split('def get_current_ticket', 1)[1]

    assert 'ticket_payload["finish_remaining_seconds"]' in current_endpoint
    assert 'ticket_payload["recall_remaining_seconds"]' in current_endpoint
    assert 'now = datetime.now()' in current_endpoint


def test_recall_response_returns_fresh_server_countdown():
    router_source = read_text("app/routers/tickets.py")
    recall_endpoint = router_source.split(
        'async def recall_ticket', 1
    )[1].split('@router.get("/tickets/current"', 1)[0]

    assert '"recall_remaining_seconds": recall_cooldown_remaining_seconds(' in recall_endpoint


def test_admin_can_configure_called_ticket_min_wait():
    modern_source = read_text("web/js/admin/views/settings.view.js")
    legacy_source = read_text("web/js/admin/settings.js")

    for source in (modern_source, legacy_source):
        assert "called_ticket_min_wait_seconds" in source
        assert "3600" in source


def test_resume_deferred_response_contains_serving_timestamp():
    router_source = read_text("app/routers/tickets.py")
    resume_endpoint = router_source.split(
        "async def _resume_operator_ticket", 1
    )[1].split('@router.post("/tickets/deferred/', 1)[0]

    assert '"called_at": ticket.called_at' in resume_endpoint
    assert '"service_started_at": ticket.service_started_at' in resume_endpoint
    assert 'source_status != "deferred"' in resume_endpoint
