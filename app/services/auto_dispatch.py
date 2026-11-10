import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import or_, text

from app.queue_time import utc_now
from app.connections import manager
from app.database import SessionLocal
from app.models import Operator, Ticket, Window, WindowService
from app.services.operators import resolve_operator_auto_call_enabled
from app.services.settings import get_system_settings_dict
from app.services.ticket_lifecycle import ACTIVE_TICKET_STATUSES
from app.services.tickets import (
    broadcast_board,
    broadcast_ticket_called,
    claim_next_ticket,
)


LOGGER = logging.getLogger(__name__)
DISPATCHER_LOCK_ID = 71620412
DISPATCHER_INTERVAL_SECONDS = 1


def _next_deadline(now: datetime, delay_seconds: int) -> datetime:
    return now + timedelta(seconds=max(0, delay_seconds))


def _has_waiting_ticket_for_operator(db, operator: Operator) -> bool:
    targeted_ticket = db.query(Ticket.id).filter(
        Ticket.status == "waiting",
        Ticket.target_window_id == operator.window_id,
    ).first()
    if targeted_ticket:
        return True

    return db.query(Ticket.id).join(
        WindowService,
        Ticket.service_id == WindowService.service_id,
    ).filter(
        WindowService.window_id == operator.window_id,
        Ticket.status == "waiting",
        Ticket.target_window_id.is_(None),
    ).first() is not None


async def run_auto_dispatch_once(*, now: datetime | None = None) -> int:
    """Reconcile deadlines and dispatch every operator that is due."""
    current_time = now or utc_now()
    dispatched: list[tuple[Ticket, Window]] = []
    deadlines_created = False
    db = SessionLocal()
    try:
        settings = get_system_settings_dict(db)
        has_lock = db.execute(
            text("SELECT pg_try_advisory_xact_lock(:lock_id)"),
            {"lock_id": DISPATCHER_LOCK_ID},
        ).scalar()
        if not has_lock:
            db.rollback()
            return 0

        delay_seconds = settings["auto_call_delay_seconds"]
        operators = (
            db.query(Operator)
            .join(Window, Operator.window_id == Window.id)
            .filter(or_(
                Window.status == "online",
                Operator.next_auto_call_at.isnot(None),
            ))
            .with_for_update(skip_locked=True, of=Operator)
            .all()
        )

        for operator in operators:
            window = db.query(Window).filter(Window.id == operator.window_id).first()
            enabled = resolve_operator_auto_call_enabled(
                operator,
                settings["auto_call_enabled"],
            )
            active_ticket = db.query(Ticket).filter(
                Ticket.window_id == operator.window_id,
                Ticket.status.in_(ACTIVE_TICKET_STATUSES),
            ).first()
            deferred_count = len(db.query(Ticket).filter(
                Ticket.operator_id == operator.id,
                Ticket.window_id == operator.window_id,
                Ticket.status == "deferred",
            ).all())
            deferred_limit_reached = (
                deferred_count >= settings["max_deferred_tickets_per_operator"]
            )

            if (
                not enabled
                or not window
                or window.status != "online"
                or active_ticket
                or deferred_limit_reached
            ):
                operator.next_auto_call_at = None
                continue

            if operator.next_auto_call_at is None:
                if not _has_waiting_ticket_for_operator(db, operator):
                    continue
                operator.next_auto_call_at = _next_deadline(current_time, delay_seconds)
                deadlines_created = True

            if operator.next_auto_call_at > current_time:
                continue

            ticket, claimed = claim_next_ticket(
                db,
                operator=operator,
                require_online=True,
                called_at=current_time,
                balance_settings=settings,
            )
            if claimed and ticket:
                operator.next_auto_call_at = None
                dispatched.append((ticket, window))
            elif ticket:
                operator.next_auto_call_at = None
            else:
                operator.next_auto_call_at = None

        db.commit()

        for ticket, window in dispatched:
            db.refresh(ticket)
            await broadcast_ticket_called(ticket, window)
        if dispatched:
            await manager.broadcast({"type": "queue_updated"})
            await broadcast_board()
        elif deadlines_created:
            await manager.broadcast({"type": "auto_dispatch_updated"})
        return len(dispatched)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


async def auto_dispatch_worker() -> None:
    """Keep server-owned auto-call deadlines moving after startup and restarts."""
    while True:
        try:
            await run_auto_dispatch_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("Auto-dispatch iteration failed")
        await asyncio.sleep(DISPATCHER_INTERVAL_SECONDS)
