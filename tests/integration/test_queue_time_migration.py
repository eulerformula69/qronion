from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from alembic import command
from sqlalchemy import text

from app import schema


def test_upgrade_preserves_irkutsk_ticket_and_can_be_repeated(empty_database):
    config = schema.migration_config()
    with empty_database.connect() as db:
        config.attributes["connection"] = db
        command.upgrade(config, "0001_initial")
    with empty_database.begin() as db:
        db.execute(text("""
            INSERT INTO tickets (created_at, called_at)
            VALUES ('2026-11-10 00:03', '2026-11-10 00:10')
        """))
    for _ in range(2):
        schema.upgrade_schema(empty_database)
        with empty_database.connect() as db:
            created, called = db.execute(text("SELECT created_at, called_at FROM tickets")).one()
            assert created == datetime(2026, 11, 9, 16, 3, tzinfo=UTC)
            assert (called - created).total_seconds() == 420


def test_numbering_uses_queue_midnight_across_rollback(empty_database, monkeypatch):
    monkeypatch.setattr(schema, "QUEUE_TIME_ZONE", ZoneInfo("America/New_York"))
    schema.upgrade_schema(empty_database)
    issue = text("INSERT INTO tickets (created_at) VALUES (:instant) RETURNING number")
    with empty_database.begin() as db:
        db.execute(text("SET LOCAL TIME ZONE 'Asia/Tokyo'"))
        for minute, number in [(58, 1), (59, 2)]:
            assert db.scalar(issue, {"instant": datetime(2099, 1, 2, 4, minute, tzinfo=UTC)}) == number
    midnight = {"instant": datetime(2099, 1, 2, 5, 0, tzinfo=UTC)}
    with empty_database.connect() as db:
        assert db.scalar(issue, midnight) == 1
        db.rollback()
    with empty_database.begin() as db:
        assert db.scalar(issue, midnight) == 1
        assert db.scalar(issue, midnight) == 2
