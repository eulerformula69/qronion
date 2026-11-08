"""Check durable issuance results through the HTTP API."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import get_current_terminal
from app.models import Service, Ticket, TicketCreationRequest
from app.routers import ticket_creation


@pytest.fixture
def api(database, monkeypatch):
    monkeypatch.setattr(ticket_creation, "SessionLocal", database)
    app = FastAPI()
    app.include_router(ticket_creation.router)
    app.dependency_overrides[get_current_terminal] = lambda: True

    async def no_broadcast(*args):
        pass

    monkeypatch.setattr(ticket_creation.manager, "broadcast", no_broadcast)
    monkeypatch.setattr(ticket_creation, "broadcast_board", no_broadcast)
    with TestClient(app) as client:
        yield client


def payload():
    return {"request_id": str(uuid4()), "service_id": 1}


def test_retry_returns_original_receipt_even_after_service_changes(api, database):
    request = payload()
    first = api.post('/tickets/', json=request)
    assert first.status_code == 200, first.text
    with database.begin() as db:
        db.get(Service, 1).status = 'inactive'
    retry = api.post('/tickets/', json=request)
    assert retry.status_code == 200
    assert retry.json() == first.json()
    with database() as db:
        assert db.query(Ticket).count() == 1


def test_concurrent_identical_requests_create_one_ticket(api, database):
    request = payload()
    start = Barrier(2)

    def send():
        start.wait(timeout=5)
        return api.post('/tickets/', json=request)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(send) for _ in range(2)]
        responses = [future.result(timeout=12) for future in futures]
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    with database() as db:
        assert db.query(Ticket).count() == 1
        assert db.query(TicketCreationRequest).count() == 1


def test_lost_response_after_commit_can_be_recovered(api, database, monkeypatch):
    request = payload()

    async def fail():
        raise RuntimeError('connection lost after commit')

    monkeypatch.setattr(ticket_creation, 'broadcast_board', fail)
    assert api.post('/tickets/', json=request).status_code == 500
    recovered = api.post('/tickets/', json=request)
    assert recovered.status_code == 200
    with database() as db:
        assert db.query(Ticket).count() == 1
        assert recovered.json()['id'] == db.query(Ticket).one().id


def test_failure_before_commit_rolls_back_receipt_and_ticket(api, database, monkeypatch):
    request = payload()
    session_type = database.class_
    original_commit = session_type.commit

    def fail(db):
        db.flush()
        raise RuntimeError('commit failed')

    monkeypatch.setattr(session_type, 'commit', fail)
    assert api.post('/tickets/', json=request).status_code == 500
    with database() as db:
        assert db.query(Ticket).count() == 0
        assert db.query(TicketCreationRequest).count() == 0
    monkeypatch.setattr(session_type, 'commit', original_commit)
    assert api.post('/tickets/', json=request).status_code == 200
    assert api.post('/tickets/', json=request).status_code == 200
    with database() as db:
        assert db.query(Ticket).count() == 1


def test_changed_payload_is_rejected_and_new_request_creates_new_ticket(api):
    request = payload()
    first = api.post('/tickets/', json=request)
    assert first.status_code == 200
    assert api.post('/tickets/', json={**request, 'window_id': 2}).status_code == 409
    second = api.post('/tickets/', json=payload())
    assert second.status_code == 200
    assert second.json()['id'] != first.json()['id']


def test_invalid_request_id_is_rejected(api):
    assert api.post('/tickets/', json={'service_id': 1, 'request_id': 'bad'}).status_code == 422
