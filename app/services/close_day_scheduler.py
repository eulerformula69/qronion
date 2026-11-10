"""Persistent weekly close-day scheduler."""

import asyncio
from datetime import datetime
from app.config import QUEUE_TIME_ZONE

from sqlalchemy.exc import SQLAlchemyError

from app.connections import manager
from app.database import SessionLocal
from app.models import CloseDaySchedule
from app.services.close_day import close_day
from app.services.tickets import broadcast_board


POLL_SECONDS = 20


def get_or_create_schedule(db) -> CloseDaySchedule:
    schedule = db.query(CloseDaySchedule).filter(CloseDaySchedule.id == 1).first()
    if schedule:
        return schedule
    schedule = CloseDaySchedule(id=1)
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    return schedule


def serialize_schedule(schedule: CloseDaySchedule) -> dict:
    weekdays = sorted({int(value) for value in schedule.weekdays.split(",") if value.strip().isdigit()})
    return {
        "enabled": bool(schedule.enabled),
        "weekdays": weekdays,
        "run_time": schedule.run_time,
        "operator_action": schedule.operator_action,
        "ticket_action": schedule.ticket_action,
        "last_run_date": schedule.last_run_date,
    }


def claim_due_schedule(db, now: datetime) -> dict | None:
    schedule = get_or_create_schedule(db)
    now = now.astimezone(QUEUE_TIME_ZONE)
    today = now.date().isoformat()
    if not schedule.enabled or now.weekday() not in serialize_schedule(schedule)["weekdays"]:
        return None
    if now.strftime("%H:%M") < schedule.run_time or schedule.last_run_date == today:
        return None
    schedule.last_run_date = today
    db.commit()
    return serialize_schedule(schedule)


async def run_due_close_day(now: datetime | None = None) -> bool:
    db = SessionLocal()
    schedule = None
    try:
        current = now or datetime.now(QUEUE_TIME_ZONE)
        schedule = claim_due_schedule(db, current)
        if not schedule:
            return False
        result = close_day(db, ticket_action=schedule["ticket_action"], operator_action=schedule["operator_action"])
    except (SQLAlchemyError, ValueError) as error:
        db.rollback()
        if schedule:
            stored = db.query(CloseDaySchedule).filter(CloseDaySchedule.id == 1).first()
            if stored:
                stored.last_run_date = None
                db.commit()
        print(f"[CloseDay scheduler] Ошибка: {error}")
        return False
    finally:
        db.close()

    try:
        await manager.send_to_sessions(
            result.deleted_session_ids,
            {"type": "session_expired", "message": "Смена закрыта", "silent": True},
        )
        await manager.broadcast({"type": "close_day_updated", "deleted_session_ids": list(result.deleted_session_ids)})
        await broadcast_board()
    except Exception as error:
        print(f"[CloseDay scheduler] Смена закрыта, но клиенты не обновлены: {error}")
    return True


async def close_day_scheduler_worker() -> None:
    while True:
        try:
            await run_due_close_day()
        except Exception as error:
            print(f"[CloseDay scheduler] Ошибка фонового процесса: {error}")
        await asyncio.sleep(POLL_SECONDS)
