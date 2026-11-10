from datetime import datetime

from app.queue_time import utc_now
from app.models import Ticket


ACTIVE_TICKET_STATUSES = ("called", "serving")


class InvalidTicketTransition(ValueError):
    """Raised when a ticket cannot move to the requested lifecycle state."""


def start_ticket_service(
    ticket: Ticket,
    *,
    operator_id: int,
    window_id: int,
    now: datetime | None = None,
) -> None:
    """Confirm that the called client arrived at the assigned window."""
    if ticket.status != "called":
        raise InvalidTicketTransition("Only a called ticket can start service")
    if ticket.window_id != window_id:
        raise InvalidTicketTransition("Ticket belongs to another window")
    if ticket.operator_id not in (None, operator_id):
        raise InvalidTicketTransition("Ticket belongs to another operator")

    ticket.status = "serving"
    ticket.operator_id = operator_id
    ticket.service_started_at = now or utc_now()
