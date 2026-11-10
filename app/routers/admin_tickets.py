from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func
from sqlalchemy.orm import aliased

from app.queue_time import local_midnight
from app.database import SessionLocal
from app.dependencies import verify_admin_session
from app.models import Admin, Operator, Service, Ticket, TicketAdminChange, Window
from app.schemas import AdminTicketStatusUpdate
from app.services.ticket_status import (
    TicketStatusError,
    cancel_ticket,
    publish_ticket_updated,
)


router = APIRouter(prefix="/admin/tickets", tags=["Admin tickets"])
TargetWindow = aliased(Window)
RootTicket = aliased(Ticket)
ALLOWED_SORTS = {
    "number": Ticket.number,
    "status": Ticket.status,
    "service": Service.name,
    "operator": Operator.name,
    "window": Window.name,
    "target_window": TargetWindow.name,
    "created_at": Ticket.created_at,
    "called_at": Ticket.called_at,
    "service_started_at": Ticket.service_started_at,
    "finished_at": Ticket.finished_at,
}


def serialize_ticket(
    ticket,
    service_name=None,
    operator_name=None,
    window_name=None,
    target_window_name=None,
    root_ticket_number=None,
):
    def iso(value):
        return value.isoformat() if value else None

    return {
        "id": ticket.id,
        "number": ticket.number,
        "status": ticket.status,
        "completion_reason": ticket.completion_reason,
        "service_id": ticket.service_id,
        "service_name": service_name,
        "operator_id": ticket.operator_id,
        "operator_name": operator_name,
        "window_id": ticket.window_id,
        "window_name": window_name,
        "target_window_id": ticket.target_window_id,
        "target_window_name": target_window_name,
        "root_ticket_id": ticket.root_ticket_id,
        "root_ticket_number": root_ticket_number,
        "created_at": iso(ticket.created_at),
        "queue_entered_at": iso(ticket.queue_entered_at),
        "called_at": iso(ticket.called_at),
        "service_started_at": iso(ticket.service_started_at),
        "last_recalled_at": iso(ticket.last_recalled_at),
        "deferred_at": iso(ticket.deferred_at),
        "finished_at": iso(ticket.finished_at),
        "returned_to_queue_count": ticket.returned_to_queue_count,
        "defer_reason": ticket.defer_reason,
        "cancel_reason": ticket.cancel_reason,
    }


def ticket_query(db):
    return (
        db.query(
            Ticket,
            Service.name,
            Operator.name,
            Window.name,
            TargetWindow.name,
            RootTicket.number,
        )
        .outerjoin(Service, Service.id == Ticket.service_id)
        .outerjoin(Operator, Operator.id == Ticket.operator_id)
        .outerjoin(Window, Window.id == Ticket.window_id)
        .outerjoin(TargetWindow, TargetWindow.id == Ticket.target_window_id)
        .outerjoin(RootTicket, RootTicket.id == Ticket.root_ticket_id)
    )


@router.get("")
def list_admin_tickets(
    status: str | None = None,
    service_id: int | None = None,
    operator_id: int | None = None,
    window_id: int | None = None,
    created_from: date | None = None,
    created_to: date | None = None,
    sort: str = Query("current"),
    direction: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        query = ticket_query(db)
        if status:
            statuses = [item.strip() for item in status.split(",") if item.strip()]
            query = query.filter(Ticket.status.in_(statuses))
        if service_id is not None:
            query = query.filter(Ticket.service_id == service_id)
        if operator_id is not None:
            query = query.filter(Ticket.operator_id == operator_id)
        if window_id is not None:
            query = query.filter(Ticket.window_id == window_id)
        if created_from is not None:
            query = query.filter(Ticket.created_at >= local_midnight(created_from))
        if created_to is not None:
            query = query.filter(Ticket.created_at < local_midnight(created_to + timedelta(days=1)))

        total = query.order_by(None).with_entities(func.count(Ticket.id)).scalar()
        if sort == "current":
            status_order = case(
                (Ticket.status == "called", 0),
                (Ticket.status == "serving", 1),
                (Ticket.status == "waiting", 2),
                (Ticket.status == "deferred", 3),
                else_=4,
            )
            query = query.order_by(status_order.asc(), Ticket.queue_entered_at.asc(), Ticket.id.desc())
        else:
            column = ALLOWED_SORTS.get(sort)
            if column is None:
                raise HTTPException(status_code=400, detail="Неизвестное поле сортировки")
            query = query.order_by(column.asc() if direction == "asc" else column.desc(), Ticket.id.desc())

        rows = query.offset(offset).limit(limit).all()
        return {
            "items": [serialize_ticket(*row) for row in rows],
            "total": total,
            "filters": {
                "services": [{"id": item.id, "name": item.name} for item in db.query(Service).order_by(Service.name).all()],
                "operators": [{"id": item.id, "name": item.name} for item in db.query(Operator).order_by(Operator.name).all()],
                "windows": [{"id": item.id, "name": item.name} for item in db.query(Window).order_by(Window.name).all()],
            },
        }
    finally:
        db.close()


@router.get("/{ticket_id}")
def get_admin_ticket(ticket_id: int, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    try:
        row = ticket_query(db).filter(Ticket.id == ticket_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Талон не найден")
        ticket = row[0]
        payload = serialize_ticket(*row)
        payload["admin_changes"] = [{
            "id": change.id,
            "admin_id": change.admin_id,
            "admin_login": change.admin_login,
            "previous_status": change.previous_status,
            "new_status": change.new_status,
            "reason": change.reason,
            "changed_at": change.changed_at.isoformat(),
        } for change in db.query(TicketAdminChange).filter(
            TicketAdminChange.ticket_id == ticket_id
        ).order_by(TicketAdminChange.changed_at.desc()).all()]
        return payload
    finally:
        db.close()


@router.patch("/{ticket_id}/status")
async def update_admin_ticket_status(
    ticket_id: int,
    data: AdminTicketStatusUpdate,
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        ticket = db.query(Ticket).filter(Ticket.id == ticket_id).with_for_update().first()
        if not ticket:
            raise HTTPException(status_code=404, detail="Талон не найден")
        try:
            previous_status = cancel_ticket(db, ticket, data.reason, admin=admin)
        except TicketStatusError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        db.commit()
        row = ticket_query(db).filter(Ticket.id == ticket_id).first()
        payload = serialize_ticket(*row)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    await publish_ticket_updated(payload, previous_status)
    return payload
