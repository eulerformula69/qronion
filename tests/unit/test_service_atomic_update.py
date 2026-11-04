import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool
from app.models import Base, Service, ServiceGroup
from app.routers import services as routes


@pytest.fixture
def setup(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[ServiceGroup.__table__, Service.__table__])
    factory = sessionmaker(bind=engine)
    with factory() as db:
        db.add_all([ServiceGroup(id=1, name='Group'), Service(id=1, name='Before', status='active')])
        db.commit()
    monkeypatch.setattr(routes, 'SessionLocal', factory)
    async def broadcast(message):
        pass
    monkeypatch.setattr(routes.manager, 'broadcast', broadcast)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.verify_admin_session] = lambda: object()
    with TestClient(app) as client:
        yield client, factory
    engine.dispose()


def snapshot(factory):
    with factory() as db:
        row = db.get(Service, 1)
        return row.name, row.service_group_id, row.status, row.visible_on_terminal, row.operator_choice_enabled


def test_update_repeats_without_duplicates_and_preserves_rename_clients(setup):
    client, factory = setup
    payload = dict(name='After', service_group_id=1, status='inactive', visible_on_terminal=False, operator_choice_enabled=True)
    for _ in range(2):
        assert client.patch('/services/1', json=payload).status_code == 200
        assert snapshot(factory) == ('After', 1, 'inactive', 0, 1)
    with factory() as db:
        assert db.query(Service).count() == 1
    assert client.patch('/services/1', json={'name': 'Renamed'}).status_code == 200
    assert snapshot(factory) == ('Renamed', 1, 'inactive', 0, 1)


def test_invalid_group_changes_nothing(setup):
    client, factory = setup
    before = snapshot(factory)
    assert client.patch('/services/1', json={'name': 'Changed', 'service_group_id': 999}).status_code == 400
    assert snapshot(factory) == before


def test_commit_failure_rolls_back_and_retry_succeeds(setup, monkeypatch):
    client, factory = setup
    before = snapshot(factory)
    original = Session.commit
    def fail_after_flush(self):
        self.flush()
        raise RuntimeError('Simulated storage failure')
    monkeypatch.setattr(Session, 'commit', fail_after_flush)
    with pytest.raises(RuntimeError, match='Simulated storage failure'):
        client.patch('/services/1', json={'name': 'Changed', 'status': 'inactive'})
    assert snapshot(factory) == before
    monkeypatch.setattr(Session, 'commit', original)
    assert client.patch('/services/1', json={'name': 'Changed', 'status': 'inactive'}).status_code == 200
    assert snapshot(factory)[::2][:2] == ('Changed', 'inactive')
