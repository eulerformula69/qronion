import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.schema import upgrade_schema
from app.models import Operator, Service, Window, WindowService


@pytest.fixture
def empty_database():
    url = os.environ.get("QRONION_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set QRONION_TEST_DATABASE_URL to run PostgreSQL tests")
    engine = create_engine(url)
    if engine.dialect.name != "postgresql":
        pytest.fail("Integration tests require PostgreSQL")
    schema = "test_claim_" + uuid4().hex
    try:
        with engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        isolated = create_engine(
            url, connect_args={"options": f"-csearch_path={schema} -cstatement_timeout=8000"}
        )
        try:
            yield isolated
        finally:
            isolated.dispose()
    finally:
        with engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        engine.dispose()


@pytest.fixture
def database(empty_database):
    upgrade_schema(empty_database)
    sessions = sessionmaker(empty_database, expire_on_commit=False)
    with sessions.begin() as db:
        db.add(Service(id=1, name="Test service", status="active"))
        db.add_all([Window(id=i, name=str(i), status="online") for i in (1, 2)])
        db.flush()
        for i in (1, 2):
            db.add(Operator(id=i, name=str(i), login=str(i), password="unused", window_id=i))
            db.add(WindowService(window_id=i, service_id=1, priority=1))
    yield sessions
