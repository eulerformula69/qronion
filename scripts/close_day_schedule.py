"""Simple in-process waiting for one-time close-day runs."""

from __future__ import annotations

import time
from datetime import datetime
from typing import Callable

from app.config import QUEUE_TIME_ZONE as LOCAL_TIMEZONE


INPUT_FORMAT = "%d.%m.%Y %H:%M"
MAX_SLEEP_SECONDS = 30


def parse_run_at(value: str, *, now: datetime | None = None) -> datetime:
    """Parse a local date and time and reject moments that have already passed."""
    try:
        run_at = datetime.strptime(value.strip(), INPUT_FORMAT).replace(
            tzinfo=LOCAL_TIMEZONE
        )
    except ValueError as error:
        raise ValueError(
            "используйте формат ДД.ММ.ГГГГ ЧЧ:ММ, например 24.07.2026 18:00"
        ) from error

    current_time = now or datetime.now(LOCAL_TIMEZONE)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=LOCAL_TIMEZONE)
    if datetime.fromtimestamp(run_at.timestamp(), LOCAL_TIMEZONE) != run_at:
        raise ValueError("местное время пропущено при переводе часов")
    if run_at.timestamp() <= current_time.timestamp():
        raise ValueError("дата и время должны быть в будущем")
    return run_at


def collect_interactive_schedule(input_func=input) -> list[str]:
    """Read one or more dates until the user submits an empty line."""
    print("Введите даты закрытия по одной строке в формате ДД.ММ.ГГГГ ЧЧ:ММ.")
    print("Пустая строка завершит ввод.")
    values: list[str] = []
    while True:
        value = input_func(f"Закрытие #{len(values) + 1}: ").strip()
        if not value:
            break
        values.append(value)
    if not values:
        raise ValueError("не указано ни одной даты закрытия")
    return values


def wait_until(
    run_at: datetime,
    *,
    now_func: Callable[[], datetime] | None = None,
    sleep_func: Callable[[float], None] = time.sleep,
) -> None:
    """Wait until a scheduled moment while checking the clock regularly."""
    get_now = now_func or (lambda: datetime.now(LOCAL_TIMEZONE))
    while True:
        remaining = run_at.timestamp() - get_now().timestamp()
        if remaining <= 0:
            return
        sleep_func(min(remaining, MAX_SLEEP_SECONDS))


def run_schedule(
    run_times: list[datetime],
    close_day_func: Callable[[], int],
    *,
    wait_func: Callable[[datetime], None] = wait_until,
) -> int:
    """Wait for each moment and run Close Day once at every scheduled time."""
    exit_code = 0
    for run_at in sorted(run_times):
        print(f"Следующее закрытие: {run_at:%d.%m.%Y в %H:%M} ({LOCAL_TIMEZONE.key})")
        wait_func(run_at)
        print(f"Запускаю Close Day: {run_at:%d.%m.%Y в %H:%M}")
        result = close_day_func()
        if result != 0:
            exit_code = result
    return exit_code
