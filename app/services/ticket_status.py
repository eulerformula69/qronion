from datetime import datetime

from app.connections import manager
from app.models import Admin, Ticket, TicketAdminChange
from app.services.settings import normalize_ticket_reason
from app.services.tickets import broadcast_board


class TicketStatusError(ValueError):
    pass


ADMIN_CANCELLABLE_STATUSES = frozenset({"waiting", "called", "serving", "deferred"})


def cancel_ticket(
    db,
    ticket: Ticket,
    reason: str,
    *,
    admin: Admin | None = None,
    operator_id: int | None = None,
) -> str:
    """Apply the shared cancellation transition without committing or publishing."""
    previous_status = ticket.status
    if previous_status not in ADMIN_CANCELLABLE_STATUSES:
        raise TicketStatusError("Отменить можно только активный талон")

    normalized_reason = normalize_ticket_reason(reason)
    if not normalized_reason:
        raise TicketStatusError("Укажите причину отмены")

    ticket.status = "cancelled"
    ticket.completion_reason = "cancelled"
    ticket.cancel_reason = normalized_reason
    ticket.finished_at = datetime.now()
    if ticket.operator_id is None and operator_id is not None:
        ticket.operator_id = operator_id

    if admin is not None:
        db.add(TicketAdminChange(
            ticket_id=ticket.id,
            admin_id=admin.id,
            admin_login=admin.login,
            previous_status=previous_status,
            new_status="cancelled",
            reason=normalized_reason,
        ))
    return previous_status


async def publish_ticket_updated(ticket_payload: dict, previous_status: str) -> None:
    event = {
        "type": "ticket.updated",
        "ticketId": ticket_payload["id"],
        "status": ticket_payload["status"],
        "previousStatus": previous_status,
        "ticket": ticket_payload,
        "timestamp": datetime.now().isoformat(),
    }
    await manager.broadcast(event)
    await manager.broadcast({"type": "queue_updated"})
    await broadcast_board()
