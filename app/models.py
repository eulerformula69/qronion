from datetime import datetime

from sqlalchemy import (
    BigInteger, CheckConstraint, Column, ForeignKey, Index, Integer, String,
    TIMESTAMP, UniqueConstraint, func, text,
)
from sqlalchemy.orm import Session, relationship

from app.database import Base


AVAILABLE_WINDOW_STATUSES = frozenset({"online", "break"})


class Service(Base):
    __tablename__ = "services"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    display_order = Column(Integer, nullable=False, default=0, server_default=text("0"))
    service_group_id = Column(Integer, ForeignKey("service_groups.id", ondelete="SET NULL"), nullable=True)
    status = Column(String, default="inactive")
    is_archived = Column(Integer, nullable=False, default=0, server_default=text("0"))
    last_window_id = Column(Integer, ForeignKey("windows.id"), nullable=True)
    operator_choice_enabled = Column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    operator_choice_allow_break = Column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    operator_choice_allow_offline = Column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    visible_on_terminal = Column(
    Integer, nullable=False, default=1, server_default=text("1")
    )


class ServiceGroup(Base):
    __tablename__ = "service_groups"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    display_order = Column(Integer, nullable=False, default=0, server_default=text("0"))


class Ticket(Base):
    __tablename__ = "tickets"
    __table_args__ = (
        CheckConstraint(
            "completion_reason IS NULL OR completion_reason IN "
            "('completed', 'redirected', 'cancelled')",
            name="ck_tickets_completion_reason",
        ),
        Index("ix_tickets_root_ticket_id", "root_ticket_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    number = Column(Integer, nullable=False)
    service_id = Column(Integer, ForeignKey("services.id"))
    status = Column(String, default="waiting")
    completion_reason = Column(String(16), nullable=True)
    root_ticket_id = Column(
        Integer,
        ForeignKey("tickets.id", name="fk_tickets_root_ticket_id"),
        nullable=True,
    )
    operator_id = Column(Integer, ForeignKey("operators.id"), nullable=True)
    window_id = Column(Integer, nullable=True)
    target_window_id = Column(Integer, ForeignKey("windows.id"), nullable=True)
    created_at = Column(
        TIMESTAMP,
        server_default=text("(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk')"),
    )
    queue_entered_at = Column(
        TIMESTAMP,
        server_default=text("(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk')"),
    )
    returned_to_queue_count = Column(Integer, nullable=False, default=0, server_default=text("0"))
    defer_reason = Column(String(255), nullable=True)
    deferred_at = Column(TIMESTAMP, nullable=True)
    cancel_reason = Column(String(255), nullable=True)
    called_at = Column(TIMESTAMP, nullable=True)
    service_started_at = Column(TIMESTAMP, nullable=True)
    last_recalled_at = Column(TIMESTAMP, nullable=True)
    finished_at = Column(TIMESTAMP, nullable=True)

    service = relationship("Service")


class Operator(Base):
    __tablename__ = "operators"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    login = Column(String, unique=True, nullable=False)
    password = Column(String, nullable=False)
    window_id = Column(Integer, ForeignKey("windows.id"), unique=True)
    auto_call_mode = Column(String, default="default")
    next_auto_call_at = Column(TIMESTAMP, nullable=True)


class OperatorServiceNotification(Base):
    __tablename__ = "operator_service_notifications"
    __table_args__ = (
        UniqueConstraint("operator_id", "service_id", name="uq_operator_service_notifications"),
    )

    id = Column(Integer, primary_key=True, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id", ondelete="CASCADE"), nullable=False)
    service_id = Column(Integer, ForeignKey("services.id", ondelete="CASCADE"), nullable=False)
    enabled = Column(Integer, nullable=False, default=1, server_default=text("1"))


class Window(Base):
    __tablename__ = "windows"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    status = Column(String, default="offline")


class UserSession(Base):
    __tablename__ = "sessions"
    session_id = Column(String, primary_key=True) 
    operator_id = Column(Integer, ForeignKey("operators.id"))
    created_at = Column(TIMESTAMP, server_default=text("NOW()"), nullable=False)
    last_seen = Column(TIMESTAMP, server_default=text("NOW()"), nullable=False)
    is_expirable = Column(Integer, default=1)


class OperatorStatusPeriod(Base):
    __tablename__ = "operator_status_periods"
    __table_args__ = (
        CheckConstraint(
            "status IN ('online', 'break', 'offline')",
            name="ck_operator_status_periods_status",
        ),
        CheckConstraint(
            "ended_at IS NULL OR ended_at >= started_at",
            name="ck_operator_status_periods_dates",
        ),
        Index("ix_operator_status_period", "operator_id", "started_at"),
        Index(
            "uq_operator_current_status",
            "operator_id",
            unique=True,
            postgresql_where=text("ended_at IS NULL"),
        ),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    operator_id = Column(Integer, ForeignKey("operators.id", ondelete="CASCADE"), nullable=False)
    window_id = Column(Integer, ForeignKey("windows.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(16), nullable=False)
    started_at = Column(
        TIMESTAMP(timezone=False),
        nullable=False,
        server_default=text("(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk')"),
    )
    ended_at = Column(TIMESTAMP(timezone=False), nullable=True)


def record_operator_status(
    db: Session,
    operator_id: int,
    window_id: int | None,
    new_status: str,
):
    """Close the current status period and open a new one when state changes."""
    normalized_status = new_status.lower()
    if normalized_status not in {"online", "break", "offline"}:
        raise ValueError(f"Unsupported operator status: {new_status}")

    # Serialize transitions for one operator, including the first inserted row.
    db.execute(
        text("SELECT pg_advisory_xact_lock(:operator_id)"),
        {"operator_id": operator_id},
    )
    current_period = (
        db.query(OperatorStatusPeriod)
        .filter(
            OperatorStatusPeriod.operator_id == operator_id,
            OperatorStatusPeriod.ended_at.is_(None),
        )
        .with_for_update()
        .first()
    )

    if (
        current_period
        and current_period.status == normalized_status
        and current_period.window_id == window_id
    ):
        return current_period

    if current_period:
        current_period.ended_at = func.timezone("Asia/Irkutsk", func.current_timestamp())

    new_period = OperatorStatusPeriod(
        operator_id=operator_id,
        window_id=window_id,
        status=normalized_status,
        started_at=func.timezone("Asia/Irkutsk", func.current_timestamp()),
    )
    db.add(new_period)
    db.flush()
    return new_period


class Admin(Base):
    __tablename__ = "admins"
    id = Column(Integer, primary_key=True, index=True)
    login = Column(String, unique=True, index=True)
    password = Column(String)
    status = Column(String)


class AdminSession(Base):
    __tablename__ = "admin_sessions"
    session_id = Column(String, primary_key=True) 
    admin_id = Column(Integer, ForeignKey("admins.id"), unique=True, index=True) 
    created_at = Column(TIMESTAMP, default=datetime.now)
    last_seen = Column(TIMESTAMP, default=datetime.now)
    is_expirable = Column(Integer, default=1)


class TicketAdminChange(Base):
    """Audit trail for ticket state changes made from the admin panel."""

    __tablename__ = "ticket_admin_changes"
    __table_args__ = (
        Index("ix_ticket_admin_changes_ticket_changed", "ticket_id", "changed_at"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    ticket_id = Column(Integer, ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False)
    admin_id = Column(Integer, ForeignKey("admins.id", ondelete="SET NULL"), nullable=True)
    admin_login = Column(String, nullable=False)
    previous_status = Column(String, nullable=False)
    new_status = Column(String, nullable=False)
    reason = Column(String(255), nullable=True)
    changed_at = Column(
        TIMESTAMP(timezone=False),
        nullable=False,
        server_default=text("(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk')"),
    )


class WindowService(Base):
    __tablename__ = "window_services"
    window_id = Column(Integer, ForeignKey("windows.id"), primary_key=True)
    service_id = Column(Integer, ForeignKey("services.id"), primary_key=True)
    priority = Column(Integer, default=1)


class SystemSettings(Base):
    __tablename__ = "system_settings"
    id = Column(Integer, primary_key=True, default=1)
    print_ticket = Column(String, default="true")
    show_print_badge = Column(String, default="false")
    ticket_print_scale_percent = Column(Integer, default=94)
    ticket_notice_duration_printed_seconds = Column(Integer, default=7)
    ticket_notice_duration_unprinted_seconds = Column(Integer, default=45)
    ticket_notice_printed_text = Column(String, default="Ваш номер: <number>")
    ticket_notice_unprinted_text = Column(String, default="Пожалуйста, запомните свой номер:\n<number>")
    default_operator_status = Column(String, default="online")
    active_ticket_on_operator_logout = Column(String, default="return_to_queue")
    hide_services_without_online_operators = Column(String, default="true")
    redirect_allow_break = Column(String, default="true")
    redirect_allow_offline = Column(String, default="false")
    max_ticket_redirects = Column(Integer, default=3)
    operator_changelog_confirm_button_text = Column(String(200), default="Понятно")

    call_message_template = Column(
        String,
        default="Талон <number> подойдите к окну <window>"
    )
    board_ticket_template = Column(
        String,
        default="Билет <number> -> Окно <window>"
    )
    board_ticker_text = Column(String(500), default="")
    board_ticker_messages = Column(String(4000), default="")
    cancel_reason_options = Column(String(4000), default="")
    defer_reason_options = Column(String(4000), default="")
    auto_call_enabled = Column(String, default="false")
    auto_call_delay_seconds = Column(Integer, default=60)
    called_ticket_min_wait_seconds = Column(Integer, default=180)
    short_service_warning_minutes = Column(Integer, default=5)
    max_deferred_tickets_per_operator = Column(Integer, default=3)
    auto_call_balance_enabled = Column(String, default="true")
    auto_call_balance_queue_threshold = Column(Integer, default=3)
    auto_call_balance_min_free_operators = Column(Integer, default=2)
    cancelled_ticket_board_display_seconds = Column(Integer, default=60)
    cancelled_ticket_board_message_template = Column(
        String(500),
        default="⚠ Талон <number>: вызов отменён оператором окна <window>. Вернулись? Сообщите номер оператору.",
    )


class CloseDaySchedule(Base):
    __tablename__ = "close_day_schedule"

    id = Column(Integer, primary_key=True, default=1)
    enabled = Column(Integer, nullable=False, default=0, server_default=text("0"))
    weekdays = Column(String(20), nullable=False, default="0,1,2,3,4", server_default="0,1,2,3,4")
    run_time = Column(String(5), nullable=False, default="18:00", server_default="18:00")
    operator_action = Column(String(16), nullable=False, default="offline", server_default="offline")
    ticket_action = Column(String(16), nullable=False, default="cancel", server_default="cancel")
    last_run_date = Column(String(10), nullable=True)


class TicketCreationRequest(Base):
    __tablename__ = "ticket_creation_requests"

    request_id = Column(String(36), primary_key=True)
    payload = Column(String, nullable=False)
    response = Column(String, nullable=False)
