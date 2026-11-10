from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app import queue_time


def test_spring_clock_change_gives_a_23_hour_queue_day(monkeypatch):
    monkeypatch.setattr(queue_time, "QUEUE_TIME_ZONE", ZoneInfo("America/New_York"))
    start, end = queue_time.today_bounds(datetime(2026, 3, 9, 3, 59, tzinfo=UTC))
    assert start.astimezone(UTC) == datetime(2026, 3, 8, 5, tzinfo=UTC)
    assert end.astimezone(UTC) - start.astimezone(UTC) == timedelta(hours=23)
