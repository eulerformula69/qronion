import asyncio
import math
from datetime import datetime, timedelta

from sqlalchemy import case, func, text
from sqlalchemy.orm import Session

from app.connections import manager
from app.database import SessionLocal
from app.models import (
    Operator, OperatorStatusPeriod, Service, Ticket, Window, WindowService,
)
from app.services.settings import get_system_settings_dict
from app.services.ticket_lifecycle import ACTIVE_TICKET_STATUSES

RECALL_COOLDOWN_SECONDS = 10


def called_ticket_wait_remaining_seconds(
    ticket: Ticket,
    min_wait_seconds: int,
    *,
    now: datetime | None = None,
) -> int:
    """Return the server-authoritative minimum service time remaining."""
    if not ticket.service_started_at:
        return 0
    current_time = now or datetime.now()
    available_at = ticket.service_started_at + timedelta(
        seconds=max(0, min_wait_seconds)
    )
    return max(0, math.ceil((available_at - current_time).total_seconds()))


def recall_cooldown_remaining_seconds(
    ticket: Ticket,
    *,
    now: datetime | None = None,
) -> int:
    call_times = [
        value for value in (ticket.called_at, ticket.last_recalled_at)
        if value is not None
    ]
    if not call_times:
        return 0
    available_at = max(call_times) + timedelta(seconds=RECALL_COOLDOWN_SECONDS)
    return max(0, math.ceil((available_at - (now or datetime.now())).total_seconds()))


def queue_order_expr():
    return func.coalesce(Ticket.queue_entered_at, Ticket.created_at)


def _lock_next_ticket(query):
    """Lock one eligible ticket without waiting for another caller's choice."""
    return query.with_for_update(skip_locked=True, of=Ticket).first()


def _operator_auto_call_enabled(operator: Operator, global_enabled: bool) -> bool:
    mode = getattr(operator, "auto_call_mode", None) or "default"
    if mode == "enabled":
        return True
    if mode == "disabled":
        return False
    return global_enabled


def select_low_load_winner_id(ranking: list[tuple]) -> int | None:
    return min(ranking)[3] if ranking else None


def low_load_auto_call_winner(
    db: Session,
    *,
    ticket: Ticket,
    settings: dict,
    now: datetime | None = None,
) -> int | None:
    """Choose a stable eligible operator from transactional database state."""
    if not settings.get("auto_call_balance_enabled", True):
        return None
    queue_size = db.query(Ticket).filter(Ticket.status == "waiting").count()
    if queue_size > settings["auto_call_balance_queue_threshold"]:
        return None

    candidates = (
        db.query(Operator)
        .join(Window, Operator.window_id == Window.id)
        .join(WindowService, WindowService.window_id == Window.id)
        .join(Service, Service.id == WindowService.service_id)
        .filter(
            Window.status == "online",
            WindowService.service_id == ticket.service_id,
            Service.is_archived == 0,
            Service.status == "active",
        )
        .all()
    )
    current_operator_ids = {
        row[0] for row in db.query(Ticket.operator_id)
        .filter(Ticket.status == "called", Ticket.operator_id.isnot(None))
        .all()
    }
    current_operator_ids.update(
        row[0] for row in db.query(Ticket.operator_id)
        .filter(Ticket.status == "serving", Ticket.operator_id.isnot(None))
        .all()
    )
    candidates = [
        candidate for candidate in candidates
        if candidate.id not in current_operator_ids
        and _operator_auto_call_enabled(candidate, settings["auto_call_enabled"])
    ]
    if len(candidates) < settings["auto_call_balance_min_free_operators"]:
        return None

    current_time = now or datetime.now()
    today_start = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
    ranking = []
    for candidate in candidates:
        completed_count = db.query(Ticket).filter(
            Ticket.operator_id == candidate.id,
            Ticket.status == "finished",
            Ticket.completion_reason.in_(("completed", "redirected")),
            Ticket.finished_at >= today_start,
        ).count()
        last_finished_at = db.query(func.max(Ticket.finished_at)).filter(
            Ticket.operator_id == candidate.id,
            Ticket.status == "finished",
            Ticket.finished_at >= today_start,
        ).scalar()
        online_started_at = db.query(func.min(OperatorStatusPeriod.started_at)).filter(
            OperatorStatusPeriod.operator_id == candidate.id,
            OperatorStatusPeriod.status == "online",
            OperatorStatusPeriod.ended_at.is_(None),
        ).scalar()
        ranking.append((
            completed_count,
            last_finished_at or datetime.min,
            online_started_at or datetime.min,
            candidate.id,
        ))
    return select_low_load_winner_id(ranking)


def claim_next_ticket(
    db: Session,
    *,
    operator: Operator,
    require_online: bool = False,
    called_at: datetime | None = None,
    balance_settings: dict | None = None,
) -> tuple[Ticket | None, bool]:
    """Select and assign the next ticket inside the caller's transaction."""
    if balance_settings:
        db.execute(text("SELECT pg_advisory_xact_lock(71620411)"))
    window = (
        db.query(Window)
        .filter(Window.id == operator.window_id)
        .with_for_update()
        .first()
    )
    if not window:
        return None, False
    if require_online and window.status != "online":
        return None, False

    current = db.query(Ticket).filter(
        Ticket.window_id == operator.window_id,
        Ticket.status == "called",
    ).first()
    if not current:
        current = db.query(Ticket).filter(
            Ticket.window_id == operator.window_id,
            Ticket.status == "serving",
        ).first()
    if current:
        return current, False

    ticket = _lock_next_ticket(
        db.query(Ticket)
        .filter(
            Ticket.status == "waiting",
            Ticket.target_window_id == operator.window_id,
        )
        .order_by(queue_order_expr().asc())
    )
    if not ticket:
        ticket = _lock_next_ticket(
            db.query(Ticket)
            .join(WindowService, Ticket.service_id == WindowService.service_id)
            .filter(
                WindowService.window_id == operator.window_id,
                Ticket.status == "waiting",
                Ticket.target_window_id.is_(None),
            )
            .order_by(WindowService.priority.asc(), queue_order_expr().asc())
        )
    if not ticket:
        return None, False

    # A ticket explicitly routed to this window must not participate in the
    # general low-load competition between operators. The target is the
    # dispatch decision for this ticket.
    is_targeted_to_operator = ticket.target_window_id == operator.window_id
    if balance_settings and not is_targeted_to_operator:
        winner_id = low_load_auto_call_winner(
            db,
            ticket=ticket,
            settings=balance_settings,
            now=called_at,
        )
        if winner_id is not None and winner_id != operator.id:
            return None, False

    ticket.status = "called"
    ticket.completion_reason = None
    ticket.operator_id = operator.id
    ticket.window_id = operator.window_id
    ticket.target_window_id = None
    ticket.called_at = called_at or datetime.now()
    ticket.service_started_at = None
    ticket.last_recalled_at = None
    ticket.finished_at = None
    ticket.defer_reason = None
    ticket.deferred_at = None
    ticket.cancel_reason = None
    db.flush()
    return ticket, True


def return_ticket_to_queue(ticket: Ticket, *, now: datetime | None = None):
    returned_at = now or datetime.now()

    ticket.status = "waiting"
    ticket.completion_reason = None
    ticket.operator_id = None
    ticket.window_id = None
    ticket.target_window_id = None
    ticket.called_at = None
    ticket.service_started_at = None
    ticket.finished_at = None
    ticket.defer_reason = None
    ticket.deferred_at = None
    ticket.cancel_reason = None
    ticket.queue_entered_at = returned_at


def defer_ticket(
    ticket: Ticket,
    *,
    operator_id: int,
    window_id: int,
    reason: str,
    now: datetime | None = None,
) -> None:
    deferred_at = now or datetime.now()

    ticket.status = "deferred"
    ticket.completion_reason = None
    ticket.operator_id = operator_id
    ticket.window_id = window_id
    ticket.target_window_id = None
    ticket.defer_reason = reason
    ticket.deferred_at = deferred_at
    ticket.cancel_reason = None
    ticket.finished_at = None


def resume_ticket_to_service(
    ticket: Ticket,
    *,
    operator_id: int,
    window_id: int,
    now: datetime | None = None,
) -> None:
    called_at = now or datetime.now()

    ticket.status = "called"
    ticket.completion_reason = None
    ticket.operator_id = operator_id
    ticket.window_id = window_id
    ticket.target_window_id = None
    ticket.called_at = called_at
    ticket.service_started_at = None
    ticket.last_recalled_at = None
    ticket.finished_at = None
    ticket.defer_reason = None
    ticket.deferred_at = None
    ticket.cancel_reason = None


def resume_deferred_ticket(
    ticket: Ticket,
    *,
    operator_id: int,
    window_id: int,
    now: datetime | None = None,
) -> None:
    service_started_at = now or datetime.now()
    ticket.status = "serving"
    ticket.completion_reason = None
    ticket.operator_id = operator_id
    ticket.window_id = window_id
    ticket.target_window_id = None
    ticket.service_started_at = service_started_at
    ticket.last_recalled_at = None
    ticket.finished_at = None
    ticket.defer_reason = None
    ticket.deferred_at = None
    ticket.cancel_reason = None


def resume_cancelled_ticket(
    ticket: Ticket,
    *,
    operator_id: int,
    window_id: int,
    now: datetime | None = None,
) -> None:
    resume_ticket_to_service(
        ticket,
        operator_id=operator_id,
        window_id=window_id,
        now=now,
    )


def create_window_redirect_ticket(
    ticket: Ticket,
    *,
    target_window_id: int,
    operator_id: int,
    service_id: int | None = None,
    now: datetime | None = None,
) -> Ticket:
    redirected_at = now or datetime.now()
    root_ticket_id = ticket.root_ticket_id or ticket.id
    redirect_count = (ticket.returned_to_queue_count or 0) + 1

    ticket.root_ticket_id = root_ticket_id
    ticket.status = "finished"
    ticket.completion_reason = "redirected"
    if ticket.operator_id is None:
        ticket.operator_id = operator_id
    ticket.target_window_id = target_window_id
    ticket.finished_at = redirected_at

    return Ticket(
        number=ticket.number,
        service_id=service_id or ticket.service_id,
        status="waiting",
        completion_reason="redirected",
        root_ticket_id=root_ticket_id,
        operator_id=None,
        window_id=None,
        target_window_id=target_window_id,
        created_at=redirected_at,
        queue_entered_at=redirected_at,
        called_at=None,
        finished_at=None,
        returned_to_queue_count=redirect_count,
    )


def redirect_called_ticket(
    ticket: Ticket,
    *,
    service_id: int,
    target_window_id: int | None = None,
    now: datetime | None = None,
) -> None:
    """Move a called ticket without preserving a separate completed stage."""
    redirected_at = now or datetime.now()

    ticket.service_id = service_id
    ticket.status = "waiting"
    ticket.completion_reason = "redirected" if target_window_id else None
    ticket.operator_id = None
    ticket.window_id = None
    ticket.target_window_id = target_window_id
    ticket.queue_entered_at = redirected_at
    ticket.called_at = None
    ticket.service_started_at = None
    ticket.last_recalled_at = None
    ticket.finished_at = None
    ticket.returned_to_queue_count = (ticket.returned_to_queue_count or 0) + 1


def get_called_tickets():
    db = SessionLocal()
    try:
        settings = get_system_settings_dict(db)

        tickets = (
            db.query(Ticket, Window)
            .join(Window, Ticket.window_id == Window.id)
            .filter(Ticket.status.in_(ACTIVE_TICKET_STATUSES))
            .order_by(Ticket.called_at.asc())
            .all()
        )

        result = []
        for ticket, window in tickets:
            result.append({
                "id": ticket.id,
                "number": ticket.number,
                "window_name": window.name,
                "display_text": render_ticket_template(
                    settings["board_ticket_template"],
                    ticket.number,
                    window.name
                ),
                "tts_text": render_ticket_template(
                    settings["call_message_template"],
                    ticket.number,
                    window.name
                ),
                "called_at": ticket.called_at.isoformat() if ticket.called_at else None,
                "last_recalled_at": (
                    ticket.last_recalled_at.isoformat()
                    if ticket.last_recalled_at else None
                ),
            })

        return result
    finally:
        db.close()


def get_waiting_tickets_for_board():
    db = SessionLocal()
    try:
        status_order = case(
            (Ticket.status == "waiting", 0),
            (Ticket.status == "deferred", 1),
            else_=2,
        )
        tickets = (
            db.query(Ticket, Service, Window)
            .join(Service, Ticket.service_id == Service.id)
            .outerjoin(Window, Ticket.window_id == Window.id)
            .filter(Ticket.status.in_(("waiting", "deferred")))
            .order_by(status_order.asc(), queue_order_expr().asc())
            .all()
        )

        result = []
        for ticket, service, window in tickets:
            result.append({
                "id": ticket.id,
                "number": ticket.number,
                "service_id": ticket.service_id,
                "service_name": service.name,
                "window_id": ticket.window_id,
                "window_name": window.name if window else None,
                "target_window_id": ticket.target_window_id,
                "status": ticket.status,
                "created_at": ticket.created_at.isoformat() if ticket.created_at else None
            })

        return result
    finally:
        db.close()


def get_recent_cancelled_tickets_for_board():
    db = SessionLocal()
    try:
        settings = get_system_settings_dict(db)
        display_seconds = settings["cancelled_ticket_board_display_seconds"]
        if display_seconds <= 0:
            return []
        cutoff = datetime.now() - timedelta(seconds=display_seconds)
        rows = (
            db.query(Ticket, Window)
            .outerjoin(Window, Ticket.window_id == Window.id)
            .filter(
                Ticket.status == "cancelled",
                Ticket.finished_at >= cutoff,
            )
            .order_by(Ticket.finished_at.desc())
            .all()
        )
        return [{
            "id": ticket.id,
            "number": ticket.number,
            "expires_at": (
                ticket.finished_at + timedelta(seconds=display_seconds)
            ).isoformat(),
            "message": render_ticket_template(
                settings["cancelled_ticket_board_message_template"],
                ticket.number,
                window.name if window else "—",
            ),
        } for ticket, window in rows]
    finally:
        db.close()


def get_board_state():
    return {
        "type": "board_state",
        "called": get_called_tickets(),
        "waiting": get_waiting_tickets_for_board(),
        "cancelled": get_recent_cancelled_tickets_for_board(),
    }


async def broadcast_board():
    board_state = get_board_state()
    for conn in manager.active_connections:
        try:
            await conn.send_json(board_state)
        except:
            pass


def render_ticket_template(template: str, ticket_number: int, window_name: str) -> str:
    template = template or ""
    return (
        template
        .replace("<number>", str(ticket_number))
        .replace("<window>", str(window_name))
    )


def build_ticket_tts_text(ticket_number: int, window_name: str) -> str:
    db = SessionLocal()
    try:
        settings = get_system_settings_dict(db)
        return render_ticket_template(
            settings["call_message_template"],
            ticket_number,
            window_name
        )
    finally:
        db.close()


def build_ticket_called_event(
    ticket: Ticket,
    window: Window,
    *,
    service: Service | None,
    settings: dict,
    call_id: str,
) -> dict:
    service_name = service.name if service else None
    tts_text = render_ticket_template(
        settings["call_message_template"],
        ticket.number,
        window.name
    )
    display_text = render_ticket_template(
        settings["board_ticket_template"],
        ticket.number,
        window.name
    )

    ticket_payload = {
        "id": ticket.id,
        "number": ticket.number,
        "service_id": ticket.service_id,
        "service_name": service_name,
        "window_id": window.id,
        "window_name": window.name,
        "operator_id": ticket.operator_id,
        "display_text": display_text,
        "tts_text": tts_text
    }

    return {
        "type": "ticket_called",
        "call_id": call_id,
        "ticket_id": ticket.id,
        "number": ticket.number,
        "service_id": ticket.service_id,
        "service_name": service_name,
        "window_id": window.id,
        "window_name": window.name,
        "operator_id": ticket.operator_id,
        "ticket": ticket_payload,
        "tts_text": tts_text,
        "display_text": display_text,
    }


async def broadcast_ticket_called(ticket: Ticket, window: Window):
    db = SessionLocal()
    try:
        settings = get_system_settings_dict(db)
        service = db.query(Service).filter(Service.id == ticket.service_id).first()
    finally:
        db.close()

    called_at_value = ticket.called_at
    if called_at_value:
        call_id = f"{ticket.id}:{called_at_value}"
    else:
        call_id = f"{ticket.id}:{datetime.now().timestamp()}"

    await manager.broadcast(build_ticket_called_event(
        ticket,
        window,
        service=service,
        settings=settings,
        call_id=call_id,
    ))
