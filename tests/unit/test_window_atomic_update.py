import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from app.models import Base, Service, Window, WindowService, Operator
from app.routers import windows as routes


@pytest.fixture
def setup(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Service.__table__, Window.__table__, WindowService.__table__, Operator.__table__])
    factory = sessionmaker(bind=engine)
    with factory() as db:
        db.add_all([Window(id=1, name='D1', status='online'), Service(id=1, name='A', status='active'), Service(id=2, name='B', status='inactive'), WindowService(window_id=1, service_id=1, priority=1)])
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
        row = db.get(Window, 1)
        links = [(x.service_id, x.priority) for x in db.query(WindowService).order_by(WindowService.service_id)]
        statuses = [(x.id, x.status) for x in db.query(Service).order_by(Service.id)]
        return row.name, row.status, links, statuses


def test_repeat_update_replaces_links_and_recalculates_removed_services(setup):
    client, factory = setup
    payload = dict(name='New', status='online', services=[dict(service_id=2, priority=3)])
    for _ in range(2):
        assert client.patch('/windows/1', json=payload).status_code == 200
        assert snapshot(factory) == ('New', 'online', [(2, 3)], [(1, 'inactive'), (2, 'active')])
    assert client.patch('/windows/1', json={'name': 'Renamed'}).status_code == 200
    assert snapshot(factory)[:3] == ('Renamed', 'online', [(2, 3)])


def test_invalid_service_or_priority_changes_nothing(setup):
    client, factory = setup
    before = snapshot(factory)
    for service_id, priority in [(999, 1), (1, 0), (1, 101)]:
        assert client.patch('/windows/1', json=dict(name='Changed', services=[dict(service_id=service_id, priority=priority)])).status_code == 400
        assert snapshot(factory) == before


def test_failed_commit_rolls_back_every_field_and_retry_succeeds(setup, monkeypatch):
    client, factory = setup
    before = snapshot(factory)
    original = Session.commit
    def fail(self):
        self.flush()
        raise RuntimeError('Storage failure')
    payload = dict(name='New', status='offline', services=[dict(service_id=2, priority=4)])
    monkeypatch.setattr(Session, 'commit', fail)
    with pytest.raises(RuntimeError, match='Storage failure'):
        client.patch('/windows/1', json=payload)
    assert snapshot(factory) == before
    monkeypatch.setattr(Session, 'commit', original)
    assert client.patch('/windows/1', json=payload).status_code == 200
    assert snapshot(factory)[:3] == ('New', 'offline', [(2, 4)])
