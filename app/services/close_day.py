"""Atomic end-of-day queue operation shared by CLI and scheduler."""

from dataclasses import dataclass

from sqlalchemy import func, or_, text

from app.models import Operator, Service, Ticket, UserSession, Window, record_operator_status
from app.services.settings import get_system_settings_dict


@dataclass(frozen=True)
class CloseDayResult:
    windows_status_changed: int
    tickets_finished: int
    tickets_cancelled: int
    tickets_deferred: int
    sessions_deleted: int
    deleted_session_ids: tuple[str, ...]


def close_day(db, *, ticket_action: str, operator_action: str) -> CloseDayResult:
    if ticket_action not in {"finish", "cancel"}:
        raise ValueError(f"Неизвестное действие с билетами: {ticket_action}")
    if operator_action not in {"offline", "offline_keep_session", "online", "break"}:
        raise ValueError(f"Неизвестное действие с операторами: {operator_action}")

    settings = get_system_settings_dict(db)
    db.execute(text("LOCK TABLE tickets, windows, sessions, operator_status_periods IN SHARE ROW EXCLUSIVE MODE"))
    now = func.current_timestamp()

    db.execute(text("""
        UPDATE tickets t SET operator_id = o.id FROM operators o
        WHERE t.status IN ('called', 'serving') AND t.operator_id IS NULL
          AND t.window_id = o.window_id
    """))

    tickets_finished = 0
    if ticket_action == "finish":
        tickets_finished = db.query(Ticket).filter(Ticket.status.in_(("called", "serving"))).update(
            {Ticket.status: "finished", Ticket.completion_reason: "completed", Ticket.finished_at: now},
            synchronize_session=False,
        )

    cancel_statuses = ("waiting", "called", "serving") if ticket_action == "cancel" else ("waiting",)
    tickets_cancelled = db.query(Ticket).filter(Ticket.status.in_(cancel_statuses)).update(
        {Ticket.status: "cancelled", Ticket.completion_reason: "cancelled", Ticket.finished_at: now},
        synchronize_session=False,
    )
    tickets_deferred = db.query(Ticket).filter(Ticket.status == "deferred").update(
        {Ticket.status: "cancelled", Ticket.completion_reason: "cancelled", Ticket.finished_at: now},
        synchronize_session=False,
    )

    windows_status_changed = 0
    deleted_session_ids: tuple[str, ...] = ()
    sessions_deleted = 0
    target_status = "offline" if operator_action == "offline_keep_session" else operator_action
    if target_status in {"offline", "break"}:
        for operator in db.query(Operator).order_by(Operator.id).all():
            record_operator_status(db, operator.id, operator.window_id, target_status)
        windows_status_changed = db.query(Window).filter(
            or_(Window.status != target_status, Window.status.is_(None))
        ).update({Window.status: target_status}, synchronize_session=False)
        if settings["hide_services_without_online_operators"]:
            db.query(Service).update({Service.status: "inactive"}, synchronize_session=False)

    if operator_action == "offline":
        deleted_session_ids = tuple(row[0] for row in db.query(UserSession.session_id).order_by(UserSession.session_id).all())
        sessions_deleted = db.query(UserSession).delete(synchronize_session=False)

    db.commit()
    return CloseDayResult(windows_status_changed, tickets_finished, tickets_cancelled, tickets_deferred, sessions_deleted, deleted_session_ids)
