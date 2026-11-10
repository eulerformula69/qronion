from datetime import UTC, date, datetime, time, timedelta

from app.config import QUEUE_TIME_ZONE


def utc_now() -> datetime:
    return datetime.now(UTC)


def local_midnight(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=QUEUE_TIME_ZONE)


def today_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    day = (now or utc_now()).astimezone(QUEUE_TIME_ZONE).date()
    return local_midnight(day), local_midnight(day + timedelta(days=1))
