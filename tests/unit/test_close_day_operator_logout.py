import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from starlette.websockets import WebSocketState

from app.connections import ConnectionManager
from app.routers.websocket import receive_text_or_none
from scripts.closeDay import build_argument_parser, main, notify_clients
from scripts.close_day_schedule import parse_run_at, run_schedule, wait_until


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_close_day_without_flags_prints_help_and_does_not_run(capsys):
    assert main([]) == 0

    output = capsys.readouterr().out
    assert "--finish-tickets" in output
    assert "--cancel-tickets" in output
    assert "--operator-offline" in output
    assert "--operator-online" in output
    assert "--operator-break" in output


def test_close_day_requires_ticket_and_operator_choices():
    parser = build_argument_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(["--finish-tickets"])
    with pytest.raises(SystemExit):
        parser.parse_args(["--operator-offline"])


def test_close_day_parses_explicit_choices():
    args = build_argument_parser().parse_args(
        ["--cancel-tickets", "--operator-online"]
    )

    assert args.ticket_action == "cancel"
    assert args.operator_action == "online"


def test_close_day_parses_operator_break():
    args = build_argument_parser().parse_args(
        ["--finish-tickets", "--operator-break"]
    )

    assert args.operator_action == "break"


def test_close_day_passes_explicit_choices_to_operation(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "scripts.closeDay.run_close_day_once",
        lambda **options: calls.append(options) or 0,
    )

    assert main(["--cancel-tickets", "--operator-online"]) == 0
    assert calls == [
        {"ticket_action": "cancel", "operator_action": "online"}
    ]


class FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.messages = []

    async def accept(self):
        self.accepted = True

    async def send_json(self, message):
        self.messages.append(message)


@pytest.mark.asyncio
async def test_receive_text_treats_already_closed_websocket_as_disconnect():
    class ClosedWebSocket:
        application_state = WebSocketState.DISCONNECTED

        async def receive_text(self):
            raise RuntimeError(
                'WebSocket is not connected. Need to call "accept" first.'
            )

    assert await receive_text_or_none(ClosedWebSocket()) is None


@pytest.mark.asyncio
async def test_connection_manager_sends_message_by_session_id():
    manager = ConnectionManager()
    websocket = FakeWebSocket()

    await manager.connect(websocket)
    manager.session_id_to_ws["operator-session"] = websocket
    manager.ws_id_to_session_id[id(websocket)] = "operator-session"

    await manager.send_to_sessions(
        ["operator-session", "missing-session"],
        {"type": "session_expired"},
    )

    assert websocket.messages == [{"type": "session_expired"}]


@pytest.mark.asyncio
async def test_close_day_notification_includes_deleted_operator_sessions(monkeypatch):
    sent_messages = []

    class FakeConnection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def send(self, message):
            sent_messages.append(message)

    monkeypatch.setattr(
        "scripts.closeDay.websockets.connect",
        lambda *args, **kwargs: FakeConnection(),
    )

    await notify_clients(("session-a", "session-b"))

    assert json.loads(sent_messages[0]) == {
        "type": "close_day_updated",
        "deleted_session_ids": ["session-a", "session-b"],
    }


def test_close_day_session_expiration_redirects_operator_without_browser_alert():
    websocket_source = (PROJECT_ROOT / "app/routers/websocket.py").read_text(
        encoding="utf-8"
    )
    operator_source = (PROJECT_ROOT / "web/js/operator.js").read_text(
        encoding="utf-8"
    )

    assert '"silent": True' in websocket_source
    assert "if (options.silent)" in operator_source
    assert "OperatorFeedback.acknowledge" in operator_source
    assert "alert(" not in operator_source
    assert "handleExpiredSession(data.message, { silent: data.silent === true })" in operator_source


def test_parse_close_day_schedule_uses_irkutsk_time():
    run_at = parse_run_at(
        "24.07.2026 18:00",
        now=datetime(2026, 7, 22, 12, 0, tzinfo=ZoneInfo("Asia/Irkutsk")),
    )

    assert run_at.isoformat() == "2026-07-24T18:00:00+08:00"


def test_wait_until_checks_clock_in_short_intervals():
    timezone = ZoneInfo("Asia/Irkutsk")
    moments = iter(
        [
            datetime(2026, 7, 22, 12, 0, tzinfo=timezone),
            datetime(2026, 7, 22, 12, 0, 30, tzinfo=timezone),
            datetime(2026, 7, 22, 12, 1, tzinfo=timezone),
        ]
    )
    sleeps = []

    wait_until(
        datetime(2026, 7, 22, 12, 1, tzinfo=timezone),
        now_func=lambda: next(moments),
        sleep_func=sleeps.append,
    )

    assert sleeps == [30, 30]


def test_run_schedule_sorts_times_and_runs_every_close_day():
    timezone = ZoneInfo("Asia/Irkutsk")
    first = datetime(2026, 7, 24, 18, 0, tzinfo=timezone)
    second = datetime(2026, 7, 25, 14, 0, tzinfo=timezone)
    waited = []
    close_day_calls = []

    def close_day_once():
        close_day_calls.append(True)
        return 0

    result = run_schedule(
        [second, first],
        close_day_once,
        wait_func=waited.append,
    )

    assert waited == [first, second]
    assert close_day_calls == [True, True]
    assert result == 0


def test_schedule_rejects_past_date():
    with pytest.raises(ValueError, match="в будущем"):
        parse_run_at(
            "21.07.2026 18:00",
            now=datetime(2026, 7, 22, 12, 0, tzinfo=ZoneInfo("Asia/Irkutsk")),
        )
