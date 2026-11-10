from datetime import datetime, timedelta
from operator import eq, ge, lt

from app.config import QUEUE_TIME_ZONE

import pytest
from fastapi import HTTPException

from app.models import Service, Ticket
from app.routers.tickets import build_reprint_ticket_payload


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

    def first(self):
        tickets = self._tickets
        if self._order_desc:
            tickets = sorted(tickets, key=lambda ticket: ticket.created_at, reverse=True)
        return tickets[0] if tickets else None

    def count(self):
        return len(self._tickets)


class FakeDb:
    def __init__(self, tickets):
        self._tickets = tickets

    def query(self, model):
        assert model is Ticket
        return FakeTicketQuery(self._tickets)


def make_ticket(number, created_at, service_name="Service", **kwargs):
    ticket = Ticket(
        id=kwargs.pop("id", number),
        number=number,
        created_at=created_at,
        status=kwargs.pop("status", "waiting"),
        service_id=kwargs.pop("service_id", 1),
        window_id=kwargs.pop("window_id", None),
        operator_id=kwargs.pop("operator_id", None),
        target_window_id=kwargs.pop("target_window_id", None),
    )
    ticket.service = Service(id=ticket.service_id, name=service_name)
    return ticket


def test_build_reprint_ticket_payload_finds_today_ticket():
    now = datetime(2026, 6, 29, 12, 0, tzinfo=QUEUE_TIME_ZONE)
    ticket = make_ticket(
        42,
        datetime(2026, 6, 29, 9, 30, tzinfo=QUEUE_TIME_ZONE),
        service_name="Consultation",
        id=10,
        window_id=3,
        operator_id=7,
    )
    waiting_before = make_ticket(41, datetime(2026, 6, 29, 9, 20, tzinfo=QUEUE_TIME_ZONE), id=9)
    finished_before = make_ticket(40, datetime(2026, 6, 29, 9, 10, tzinfo=QUEUE_TIME_ZONE), id=8, status="finished")

    payload = build_reprint_ticket_payload(
        FakeDb([ticket, waiting_before, finished_before]),
        42,
        now=now,
    )

    assert payload == {
        "id": 10,
        "number": 42,
        "service_name": "Consultation",
        "waiting_before": 1,
        "date": "29.06.2026 09:30",
    }
    assert ticket.status == "waiting"
    assert ticket.window_id == 3
    assert ticket.operator_id == 7


def test_build_reprint_ticket_payload_raises_when_ticket_missing():
    now = datetime(2026, 6, 29, 12, 0, tzinfo=QUEUE_TIME_ZONE)

    with pytest.raises(HTTPException) as exc_info:
        build_reprint_ticket_payload(FakeDb([]), 42, now=now)

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Талон за сегодня не найден"


def test_build_reprint_ticket_payload_does_not_find_yesterday_ticket():
    now = datetime(2026, 6, 29, 12, 0, tzinfo=QUEUE_TIME_ZONE)
    yesterday_ticket = make_ticket(42, now - timedelta(days=1), id=10)

    with pytest.raises(HTTPException) as exc_info:
        build_reprint_ticket_payload(FakeDb([yesterday_ticket]), 42, now=now)

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Талон за сегодня не найден"
