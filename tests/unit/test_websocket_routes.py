from types import SimpleNamespace

import pytest

from app.application import app
from app.connections import ConnectionManager
from app.routers import websocket


async def connect_and_disconnect(path):
    incoming = iter([
        {"type": "websocket.connect"},
        {"type": "websocket.disconnect", "code": 1000},
    ])
    sent = []

    async def receive():
        return next(incoming)

    async def send(message):
        sent.append(message)

    await app({
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "scheme": "ws",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "subprotocols": [],
    }, receive, send)
    return sent


@pytest.mark.asyncio
async def test_removed_operator_channel_rejects_connection_without_database_access(monkeypatch):
    def unexpected_database_access():
        pytest.fail("Removed channel must not access operator sessions")

    monkeypatch.setattr(websocket, "SessionLocal", unexpected_database_access)

    sent = await connect_and_disconnect("/ws/operator/7")

    assert [message["type"] for message in sent] == ["websocket.close"]


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/ws/terminal", "/ws/board"])
async def test_active_channels_accept_and_release_connections(monkeypatch, path):
    manager = ConnectionManager()
    closed = []
    monkeypatch.setattr(websocket, "manager", manager)
    monkeypatch.setattr(
        websocket, "SessionLocal", lambda: SimpleNamespace(close=lambda: closed.append(True))
    )
    monkeypatch.setattr(websocket, "get_board_state", lambda: {"type": "board_state"})

    sent = await connect_and_disconnect(path)

    assert sent[0]["type"] == "websocket.accept"
    assert not manager.active_connections
    if path == "/ws/board":
        assert sent[1]["type"] == "websocket.send"
        assert "board_state" in sent[1]["text"]
    else:
        assert closed == [True]
