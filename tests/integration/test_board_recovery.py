"""Recover board state through its public WebSocket after missed events."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.connections import ConnectionManager
from app.models import Operator, Ticket
from app.routers import websocket
from app.services import tickets
from app.services.tickets import claim_next_ticket


def test_board_sync_and_reconnect_recover_committed_state(database, monkeypatch):
    monkeypatch.setattr(tickets, 'SessionLocal', database)
    manager = ConnectionManager()
    monkeypatch.setattr(websocket, 'manager', manager)
    with database.begin() as db:
        db.add(Ticket(id=1, number=42, service_id=1, status='waiting'))
    app = FastAPI()
    app.include_router(websocket.router)
    with TestClient(app) as client:
        with client.websocket_connect('/ws/board') as board:
            initial = board.receive_json()
            assert [ticket['number'] for ticket in initial['waiting']] == [42]
            assert initial['called'] == []
            # Simulate a committed assignment whose broadcast never happened.
            with database.begin() as db:
                ticket, claimed = claim_next_ticket(db, operator=db.get(Operator, 1))
                assert claimed
            for message in ['not-json', 'null', '[]', '{"type":"unknown"}']:
                board.send_text(message)
            board.send_json({'type': 'board_sync'})
            recovered = board.receive_json()
            assert recovered['waiting'] == []
            assert [(ticket['number'], ticket['window_name']) for ticket in recovered['called']] == [(42, '1')]
            board.send_json({'type': 'board_sync'})
            assert board.receive_json() == recovered
        with client.websocket_connect('/ws/board') as board:
            assert board.receive_json() == recovered
            with database.begin() as db:
                db.get(Ticket, 1).status = 'finished'
            board.send_json({'type': 'board_sync'})
            assert board.receive_json()['called'] == []
    assert not manager.active_connections
