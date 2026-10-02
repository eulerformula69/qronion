from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.models import Ticket
from app.routers import tickets as tickets_router
from app.schemas import CancelTicketRequest, DeferTicketRequest
from app.services.tickets import (
    create_window_redirect_ticket,
    defer_ticket,
    redirect_called_ticket,
    resume_cancelled_ticket,
    resume_deferred_ticket,
    return_ticket_to_queue,
)


def test_return_ticket_to_queue_does_not_change_redirect_count():
    now = datetime(2026, 7, 1, 10, 0)
    ticket = Ticket(
        status="called",
        completion_reason="completed",
        operator_id=7,
        window_id=3,
        target_window_id=4,
        called_at=now - timedelta(minutes=3),
        finished_at=now - timedelta(minutes=1),
        queue_entered_at=now - timedelta(minutes=10),
        returned_to_queue_count=0,
    )

    return_ticket_to_queue(ticket, now=now)

    assert ticket.status == "waiting"
    assert ticket.completion_reason is None
    assert ticket.operator_id is None
    assert ticket.window_id is None
    assert ticket.target_window_id is None
    assert ticket.called_at is None
    assert ticket.finished_at is None
    assert ticket.queue_entered_at == now
    assert ticket.returned_to_queue_count == 0


def test_return_ticket_to_queue_preserves_existing_redirect_count():
    now = datetime(2026, 7, 1, 10, 0)
    ticket = Ticket(status="called", returned_to_queue_count=1)

    return_ticket_to_queue(ticket, now=now)

    assert ticket.returned_to_queue_count == 1


def test_defer_ticket_keeps_ticket_owned_by_current_operator_and_window():
    now = datetime(2026, 7, 8, 10, 0)
    ticket = Ticket(
        status="called",
        completion_reason=None,
        operator_id=1,
        window_id=2,
        target_window_id=9,
        called_at=now - timedelta(minutes=4),
        finished_at=None,
    )

    defer_ticket(
        ticket,
        operator_id=7,
        window_id=3,
        reason="missing_document",
        now=now,
    )

    assert ticket.status == "deferred"
    assert ticket.completion_reason is None
    assert ticket.operator_id == 7
    assert ticket.window_id == 3
    assert ticket.target_window_id is None
    assert ticket.defer_reason == "missing_document"
    assert ticket.deferred_at == now
    assert ticket.called_at == now - timedelta(minutes=4)
    assert ticket.finished_at is None


def test_resume_deferred_ticket_returns_ticket_to_service_without_general_queue():
    now = datetime(2026, 7, 8, 10, 30)
    deferred_at = now - timedelta(minutes=10)
    ticket = Ticket(
        status="deferred",
        completion_reason=None,
        operator_id=7,
        window_id=3,
        target_window_id=None,
        defer_reason="pays",
        deferred_at=deferred_at,
        called_at=now - timedelta(minutes=20),
        finished_at=None,
    )

    resume_deferred_ticket(
        ticket,
        operator_id=7,
        window_id=3,
        now=now,
    )

    assert ticket.status == "serving"
    assert ticket.completion_reason is None
    assert ticket.operator_id == 7
    assert ticket.window_id == 3
    assert ticket.target_window_id is None
    assert ticket.called_at == now - timedelta(minutes=20)
    assert ticket.service_started_at == now
    assert ticket.defer_reason is None
    assert ticket.deferred_at is None
    assert ticket.finished_at is None


def test_resume_cancelled_ticket_returns_ticket_to_service():
    now = datetime(2026, 7, 19, 12, 0)
    ticket = SimpleNamespace(
        status="cancelled",
        completion_reason="cancelled",
        operator_id=3,
        window_id=7,
        target_window_id=None,
        called_at=now - timedelta(minutes=5),
        last_recalled_at=now - timedelta(minutes=4),
        finished_at=now - timedelta(minutes=3),
        defer_reason=None,
        deferred_at=None,
        cancel_reason="Клиент не явился",
    )

    resume_cancelled_ticket(ticket, operator_id=3, window_id=7, now=now)

    assert ticket.status == "called"
    assert ticket.completion_reason is None
    assert ticket.called_at == now
    assert ticket.finished_at is None
    assert ticket.cancel_reason is None


def test_create_window_redirect_ticket_preserves_finished_source_stage():
    called_at = datetime(2026, 7, 2, 12, 25)
    redirected_at = datetime(2026, 7, 2, 12, 30)
    ticket = Ticket(
        id=1771,
        number=119,
        service_id=2,
        status="called",
        completion_reason=None,
        root_ticket_id=None,
        operator_id=None,
        window_id=7,
        target_window_id=None,
        created_at=datetime(2026, 7, 2, 12, 14),
        queue_entered_at=datetime(2026, 7, 2, 12, 14),
        called_at=called_at,
        finished_at=None,
        returned_to_queue_count=2,
    )

    redirected_ticket = create_window_redirect_ticket(
        ticket,
        target_window_id=19,
        operator_id=5,
        now=redirected_at,
    )

    assert ticket.status == "finished"
    assert ticket.completion_reason == "redirected"
    assert ticket.root_ticket_id == 1771
    assert ticket.operator_id == 5
    assert ticket.window_id == 7
    assert ticket.target_window_id == 19
    assert ticket.called_at == called_at
    assert ticket.finished_at == redirected_at

    assert redirected_ticket.number == 119
    assert redirected_ticket.service_id == 2
    assert redirected_ticket.status == "waiting"
    assert redirected_ticket.completion_reason == "redirected"
    assert redirected_ticket.root_ticket_id == 1771
    assert redirected_ticket.operator_id is None
    assert redirected_ticket.window_id is None
    assert redirected_ticket.target_window_id == 19
    assert redirected_ticket.created_at == redirected_at
    assert redirected_ticket.queue_entered_at == redirected_at
    assert redirected_ticket.called_at is None
    assert redirected_ticket.finished_at is None
    assert redirected_ticket.returned_to_queue_count == 3


def test_redirect_called_ticket_reuses_source_record():
    called_at = datetime(2026, 7, 2, 12, 25)
    ticket = Ticket(
        id=1771,
        number=119,
        service_id=2,
        status="called",
        root_ticket_id=1500,
        operator_id=5,
        window_id=7,
        called_at=called_at,
        service_started_at=None,
        returned_to_queue_count=2,
    )

    redirect_called_ticket(
        ticket,
        service_id=4,
        target_window_id=19,
        now=datetime(2026, 7, 2, 12, 30),
    )

    assert ticket.id == 1771
    assert ticket.root_ticket_id == 1500
    assert ticket.service_id == 4
    assert ticket.status == "waiting"
    assert ticket.completion_reason == "redirected"
    assert ticket.operator_id is None
    assert ticket.window_id is None
    assert ticket.target_window_id == 19
    assert ticket.called_at is None
    assert ticket.finished_at is None
    assert ticket.returned_to_queue_count == 3


class ActiveTicketQuery:
    def __init__(self, ticket):
        self.ticket = ticket

    def filter(self, *conditions):
        return self

    def first(self):
        return self.ticket

    def scalar(self):
        return 0


class ActiveTicketDb:
    def __init__(self, ticket):
        self.ticket = ticket
        self.committed = False
        self.refreshed = None
        self.closed = False

    def query(self, model):
        return ActiveTicketQuery(self.ticket)

    def commit(self):
        self.committed = True

    def refresh(self, ticket):
        self.refreshed = ticket

    def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_cancel_ticket_accepts_other_comment_reason(monkeypatch):
    now = datetime(2026, 7, 8, 10, 0)
    ticket = Ticket(
        number=55,
        status="called",
        operator_id=7,
        window_id=3,
        called_at=now,
    )
    db = ActiveTicketDb(ticket)
    broadcasts = []
    board_updates = []

    async def fake_broadcast(message):
        broadcasts.append(message)

    async def fake_broadcast_board():
        board_updates.append(True)

    monkeypatch.setattr(tickets_router, "SessionLocal", lambda: db)
    from app.services import ticket_status

    monkeypatch.setattr(ticket_status.manager, "broadcast", fake_broadcast)
    monkeypatch.setattr(ticket_status, "broadcast_board", fake_broadcast_board)
    monkeypatch.setattr(tickets_router, "ensure_client_operations_allowed", lambda *_: None)

    result = await tickets_router.cancel_current_ticket(
        CancelTicketRequest(reason="Другое: клиент ушёл"),
        operator=type("Operator", (), {"id": 7, "window_id": 3})(),
    )

    assert result["cancel_reason"] == "Другое: клиент ушёл"
    assert ticket.cancel_reason == "Другое: клиент ушёл"
    assert ticket.status == "cancelled"
    assert ticket.completion_reason == "cancelled"
    assert db.committed is True
    assert db.refreshed is ticket
    assert db.closed is True
    assert [message["type"] for message in broadcasts] == [
        "ticket.updated", "queue_updated"
    ]
    assert broadcasts[0]["previousStatus"] == "called"
    assert broadcasts[0]["status"] == "cancelled"
    assert board_updates == [True]


@pytest.mark.asyncio
async def test_defer_ticket_accepts_other_comment_reason(monkeypatch):
    now = datetime(2026, 7, 8, 10, 0)
    ticket = Ticket(
        number=56,
        status="called",
        operator_id=7,
        window_id=3,
        called_at=now,
    )
    db = ActiveTicketDb(ticket)
    broadcasts = []
    board_updates = []

    async def fake_broadcast(message):
        broadcasts.append(message)

    async def fake_broadcast_board():
        board_updates.append(True)

    monkeypatch.setattr(tickets_router, "SessionLocal", lambda: db)
    monkeypatch.setattr(tickets_router.manager, "broadcast", fake_broadcast)
    monkeypatch.setattr(tickets_router, "broadcast_board", fake_broadcast_board)
    monkeypatch.setattr(tickets_router, "ensure_client_operations_allowed", lambda *_: None)
    monkeypatch.setattr(
        tickets_router,
        "get_system_settings_dict",
        lambda _db: {"max_deferred_tickets_per_operator": 3},
    )

    result = await tickets_router.defer_current_ticket(
        DeferTicketRequest(reason="Другое: клиент вернётся позже"),
        operator=type("Operator", (), {"id": 7, "window_id": 3})(),
    )

    assert result["defer_reason"] == "Другое: клиент вернётся позже"
    assert ticket.defer_reason == "Другое: клиент вернётся позже"
    assert ticket.status == "deferred"
    assert db.committed is True
    assert db.refreshed is ticket
    assert db.closed is True
    assert broadcasts == [{"type": "queue_updated"}]
    assert board_updates == [True]
