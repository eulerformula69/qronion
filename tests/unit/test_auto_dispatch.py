from datetime import datetime, timedelta
from operator import eq

import pytest

from app.models import Operator, Ticket, Window
from app.services import auto_dispatch


class FakeScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar(self):
        return self.value


class FakeQuery:
    def __init__(self, rows):
        self.rows = list(rows)

    def join(self, *args, **kwargs):
        return self

    def with_for_update(self, **kwargs):
        return self

    def filter(self, *conditions):
        for condition in conditions:
            if not hasattr(condition, "left"):
                continue
            field = condition.left.name
            value = getattr(condition.right, "value", None)
            if condition.operator is eq:
                self.rows = [row for row in self.rows if getattr(row, field) == value]
            elif condition.operator.__name__ == "in_op":
                self.rows = [row for row in self.rows if getattr(row, field) in value]
            else:
                raise AssertionError(f"Unsupported condition: {condition.operator}")
        return self

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None


class FakeDb:
    def __init__(self, *, operator, window, tickets=(), has_lock=True):
        self.operator = operator
        self.window = window
        self.tickets = list(tickets)
        self.has_lock = has_lock
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def execute(self, statement, params=None):
        return FakeScalarResult(self.has_lock)

    def query(self, model):
        if model is Operator:
            return FakeQuery([self.operator])
        if model is Window:
            return FakeQuery([self.window])
        if model is Ticket:
            return FakeQuery(self.tickets)
        raise AssertionError(f"Unexpected model: {model}")

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def refresh(self, item):
        return item

    def close(self):
        self.closed = True


def configure_dispatch(
    monkeypatch,
    db,
    *,
    claim_result=(None, False),
    has_waiting_ticket=True,
):
    monkeypatch.setattr(auto_dispatch, "SessionLocal", lambda: db)
    monkeypatch.setattr(
        auto_dispatch,
        "get_system_settings_dict",
        lambda session: {
            "auto_call_enabled": True,
            "auto_call_delay_seconds": 10,
            "max_deferred_tickets_per_operator": 3,
        },
    )
    monkeypatch.setattr(auto_dispatch, "claim_next_ticket", lambda *args, **kwargs: claim_result)
    monkeypatch.setattr(
        auto_dispatch,
        "_has_waiting_ticket_for_operator",
        lambda *args, **kwargs: has_waiting_ticket,
    )

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(auto_dispatch, "broadcast_ticket_called", noop)
    monkeypatch.setattr(auto_dispatch, "broadcast_board", noop)
    monkeypatch.setattr(auto_dispatch.manager, "broadcast", noop)


@pytest.mark.asyncio
async def test_dispatcher_persists_deadline_before_calling(monkeypatch):
    now = datetime(2026, 8, 1, 12, 0)
    operator = Operator(id=1, window_id=3, auto_call_mode="default")
    window = Window(id=3, status="online")
    db = FakeDb(operator=operator, window=window)
    configure_dispatch(monkeypatch, db)
    events = []

    async def record_event(message):
        events.append(message)

    monkeypatch.setattr(auto_dispatch.manager, "broadcast", record_event)

    dispatched = await auto_dispatch.run_auto_dispatch_once(now=now)

    assert dispatched == 0
    assert operator.next_auto_call_at == now + timedelta(seconds=10)
    assert db.committed is True
    assert events == [{"type": "auto_dispatch_updated"}]


@pytest.mark.asyncio
async def test_dispatcher_uses_persisted_due_deadline_after_restart(monkeypatch):
    now = datetime(2026, 8, 1, 12, 0)
    operator = Operator(
        id=1,
        window_id=3,
        auto_call_mode="default",
        next_auto_call_at=now - timedelta(seconds=1),
    )
    window = Window(id=3, status="online")
    ticket = Ticket(id=5, number=42, status="called", window_id=3, operator_id=1)
    db = FakeDb(operator=operator, window=window)
    configure_dispatch(monkeypatch, db, claim_result=(ticket, True))

    dispatched = await auto_dispatch.run_auto_dispatch_once(now=now)

    assert dispatched == 1
    assert operator.next_auto_call_at is None


@pytest.mark.asyncio
async def test_dispatcher_stops_when_another_instance_holds_lock(monkeypatch):
    operator = Operator(id=1, window_id=3, auto_call_mode="default")
    db = FakeDb(operator=operator, window=Window(id=3, status="online"), has_lock=False)
    configure_dispatch(monkeypatch, db)

    dispatched = await auto_dispatch.run_auto_dispatch_once()

    assert dispatched == 0
    assert operator.next_auto_call_at is None
    assert db.rolled_back is True


@pytest.mark.asyncio
async def test_dispatcher_clears_deadline_for_offline_operator(monkeypatch):
    now = datetime(2026, 8, 1, 12, 0)
    operator = Operator(
        id=1,
        window_id=3,
        auto_call_mode="default",
        next_auto_call_at=now - timedelta(seconds=1),
    )
    db = FakeDb(operator=operator, window=Window(id=3, status="offline"))
    configure_dispatch(monkeypatch, db)

    dispatched = await auto_dispatch.run_auto_dispatch_once(now=now)

    assert dispatched == 0
    assert operator.next_auto_call_at is None


@pytest.mark.asyncio
async def test_dispatcher_clears_deadline_when_queue_is_empty(monkeypatch):
    now = datetime(2026, 8, 1, 12, 0)
    operator = Operator(
        id=1,
        window_id=3,
        auto_call_mode="default",
        next_auto_call_at=now,
    )
    db = FakeDb(operator=operator, window=Window(id=3, status="online"))
    configure_dispatch(monkeypatch, db, has_waiting_ticket=False)

    dispatched = await auto_dispatch.run_auto_dispatch_once(now=now)

    assert dispatched == 0
    assert operator.next_auto_call_at is None


@pytest.mark.asyncio
async def test_dispatcher_does_nothing_when_operator_feature_flag_is_disabled(monkeypatch):
    now = datetime(2026, 8, 1, 12, 0)
    operator = Operator(
        id=1,
        window_id=3,
        auto_call_mode="disabled",
        next_auto_call_at=now,
    )
    db = FakeDb(operator=operator, window=Window(id=3, status="online"))
    configure_dispatch(monkeypatch, db)

    dispatched = await auto_dispatch.run_auto_dispatch_once(now=now)

    assert dispatched == 0
    assert operator.next_auto_call_at is None


@pytest.mark.asyncio
async def test_dispatcher_does_not_assign_new_ticket_when_deferred_limit_is_reached(monkeypatch):
    now = datetime(2026, 8, 1, 12, 0)
    operator = Operator(
        id=1,
        window_id=3,
        auto_call_mode="default",
        next_auto_call_at=now,
    )
    deferred = [
        Ticket(id=ticket_id, status="deferred", operator_id=1, window_id=3)
        for ticket_id in (9, 10, 11)
    ]
    db = FakeDb(
        operator=operator,
        window=Window(id=3, status="online"),
        tickets=deferred,
    )
    configure_dispatch(monkeypatch, db)

    dispatched = await auto_dispatch.run_auto_dispatch_once(now=now)

    assert dispatched == 0
    assert operator.next_auto_call_at is None


@pytest.mark.asyncio
async def test_dispatcher_can_continue_below_deferred_limit(monkeypatch):
    now = datetime(2026, 8, 1, 12, 0)
    operator = Operator(id=1, window_id=3, auto_call_mode="default", next_auto_call_at=now)
    deferred = Ticket(id=9, status="deferred", operator_id=1, window_id=3)
    db = FakeDb(
        operator=operator,
        window=Window(id=3, status="online"),
        tickets=[deferred],
    )
    configure_dispatch(monkeypatch, db)

    dispatched = await auto_dispatch.run_auto_dispatch_once(now=now)

    assert dispatched == 0
    assert operator.next_auto_call_at is None


def test_browser_does_not_own_server_managed_auto_call_timer():
    source = open("web/js/operator.js", encoding="utf-8").read()

    assert "auto_call_server_managed" in source
    assert "autoDispatchCountdownTimer" in source
    assert "Следующий клиент через ${remaining} сек." in source
    assert "await callNext({ autoCall: true });" not in source


def test_operator_refreshes_current_ticket_immediately_after_server_call():
    source = open("web/js/operator.js", encoding="utf-8").read()
    websocket = source.split("operatorSocket.onmessage", 1)[1]
    websocket = websocket.split("operatorSocket.onclose", 1)[0]

    assert 'data.type === "ticket_called"' in websocket
    assert 'setCurrentTicket({...data.ticket, status: "called"})' in websocket
    assert "loadCurrentTicket()" in websocket
    assert "loadCurrentTicket()," in source.split(
        "async function refreshQueueAndAutoCall", 1
    )[1].split("function showToast", 1)[0]


def test_operator_sees_notice_after_server_calls_client():
    source = open("web/js/operator.js", encoding="utf-8").read()
    websocket = source.split("operatorSocket.onmessage", 1)[1]
    websocket = websocket.split("operatorSocket.onclose", 1)[0]

    assert "Сейчас к вам должен подойти клиент №${data.number}" in websocket
    assert '"success"' in websocket


def test_admin_labels_delay_as_server_call_countdown():
    modern = open("web/js/admin/views/settings.view.js", encoding="utf-8").read()
    legacy = open("web/js/admin/operators.js", encoding="utf-8").read()

    assert "До автоматического вызова, секунд" in modern
    assert "До системного вызова, сек." in legacy
