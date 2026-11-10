import asyncio
from datetime import UTC, datetime, timedelta
from operator import eq, ge, lt

import pytest

from app.models import Operator, Service, Ticket, Window, WindowService
from app.routers import tickets as tickets_router
from app.routers.tickets import call_specific_ticket
from app.schemas import CallSpecificRequest


@pytest.fixture(autouse=True)
def configured_deferred_limit(monkeypatch):
    monkeypatch.setattr(
        tickets_router,
        "get_system_settings_dict",
        lambda _db: {"max_deferred_tickets_per_operator": 3},
    )


class FakeTicketQuery:
    def __init__(self, tickets):
        self._tickets = list(tickets)
        self._order_desc = False

    def filter(self, *conditions):
        tickets = self._tickets
        for condition in conditions:
            field = condition.left.name
            value = condition.right.value
            op = condition.operator

            if op is eq:
                tickets = [ticket for ticket in tickets if getattr(ticket, field) == value]
            elif op.__name__ == "in_op":
                tickets = [ticket for ticket in tickets if getattr(ticket, field) in value]
            elif op is ge:
                tickets = [ticket for ticket in tickets if getattr(ticket, field) >= value]
            elif op is lt:
                tickets = [ticket for ticket in tickets if getattr(ticket, field) < value]
            else:
                raise AssertionError(f"Unexpected operator in test query: {op}")

        self._tickets = tickets
        return self

    def order_by(self, *order):
        self._order_desc = True
        return self

    def with_for_update(self, **kwargs):
        return self

    def first(self):
        tickets = self._tickets
        if self._order_desc:
            tickets = sorted(tickets, key=lambda ticket: ticket.finished_at, reverse=True)
        return tickets[0] if tickets else None

    def scalar(self):
        return len(self._tickets)


class FakeDb:
    def __init__(self, tickets, windows=None, window_services=None):
        self._tickets = tickets
        self._windows = windows or []
        self._window_services = window_services or []
        self.committed = False
        self.closed = False

    def query(self, model):
        if model is Ticket:
            return FakeTicketQuery(self._tickets)
        if model is Window:
            return FakeTicketQuery(self._windows)
        if model is WindowService:
            return FakeTicketQuery(self._window_services)
        return FakeTicketQuery(self._tickets)

    def commit(self):
        self.committed = True

    def refresh(self, item):
        return item

    def close(self):
        self.closed = True


@pytest.mark.parametrize("ticket_status", ["finished", "cancelled"])
def test_call_specific_rejects_non_waiting_ticket(monkeypatch, ticket_status):
    ticket = Ticket(
        id=10,
        number=42,
        status=ticket_status,
        created_at=datetime.now(UTC) - timedelta(hours=1),
    )
    db = FakeDb([ticket])
    monkeypatch.setattr(tickets_router, "SessionLocal", lambda: db)

    response = asyncio.run(
        call_specific_ticket(
            CallSpecificRequest(number=42),
            operator=Operator(id=7, window_id=3),
        )
    )

    assert response == {"detail": "Ожидающий талон с таким номером за сегодня не найден"}
    assert ticket.status == ticket_status
    assert db.committed is False


def test_call_specific_calls_today_waiting_ticket(monkeypatch):
    now = datetime.now(UTC)
    service = Service(id=5, name="Consultation")
    ticket = Ticket(
        id=10,
        number=42,
        service_id=service.id,
        status="waiting",
        target_window_id=None,
        created_at=now,
    )
    ticket.service = service
    window = Window(id=3, name="3")
    operator = Operator(id=7, window_id=window.id)
    db = FakeDb(
        [ticket],
        windows=[window],
        window_services=[WindowService(window_id=window.id, service_id=service.id)],
    )
    broadcasts = []

    async def fake_broadcast_board():
        broadcasts.append(("board", None))

    async def fake_broadcast_ticket_called(called_ticket, called_window):
        broadcasts.append(("called", called_ticket, called_window))

    monkeypatch.setattr(tickets_router, "SessionLocal", lambda: db)
    monkeypatch.setattr(tickets_router, "broadcast_board", fake_broadcast_board)
    monkeypatch.setattr(
        tickets_router,
        "broadcast_ticket_called",
        fake_broadcast_ticket_called,
    )

    response = asyncio.run(
        call_specific_ticket(CallSpecificRequest(number=42), operator=operator)
    )

    assert response["id"] == 10
    assert response["number"] == 42
    assert response["status"] == "called"
    assert response["called_at"] == ticket.called_at
    assert response["service_name"] == "Consultation"
    assert ticket.status == "called"
    assert ticket.completion_reason is None
    assert ticket.operator_id == operator.id
    assert ticket.window_id == operator.window_id
    assert ticket.target_window_id is None
    assert ticket.called_at is not None
    assert ticket.finished_at is None
    assert db.committed is True
    assert db.closed is True
    assert broadcasts == [("board", None), ("called", ticket, window)]
