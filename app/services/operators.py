import asyncio
from datetime import datetime, timedelta

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.config import OPERATOR_SESSION_AUTO_CLEANUP_ENABLED, SESSION_TIMEOUT_SECONDS
from app.connections import manager
from app.database import SessionLocal
from app.models import (
    AdminSession, Operator,
    OperatorServiceNotification, OperatorStatusPeriod, Service, Ticket,
    UserSession, Window, WindowService, record_operator_status,
)
from app.services.settings import get_system_settings_dict
from app.services.ticket_lifecycle import ACTIVE_TICKET_STATUSES
from app.services.tickets import (
    broadcast_board, queue_order_expr, return_ticket_to_queue,
)


def resolve_operator_auto_call_enabled(
    operator: Operator,
    global_enabled: bool,
) -> bool:
    mode = getattr(operator, "auto_call_mode", None) or "default"
    if mode == "enabled":
        return True
    if mode == "disabled":
        return False
    return bool(global_enabled)


def update_services_status_for_window(db: Session, window_id: int, *, commit=True, service_ids=None):
    if service_ids is None:
        service_ids = [
            row[0]
            for row in db.query(WindowService.service_id)
            .filter(WindowService.window_id == window_id)
            .all()
        ]
    if not service_ids:
        if commit:
            db.commit()
        return

    # Находим услуги, у которых есть хотя бы одно доступное окно, одним запросом.
    available_service_ids = {
        row[0]
        for row in db.query(WindowService.service_id)
        .join(Window, WindowService.window_id == Window.id)
        .join(Service, WindowService.service_id == Service.id)
        .filter(
            WindowService.service_id.in_(service_ids),
            or_(
                Window.status == "online",
                and_(
                    Window.status == "break",
                    or_(
                        Service.operator_choice_enabled == 0,
                        Service.operator_choice_allow_break == 1,
                    ),
                ),
                and_(
                    Window.status == "offline",
                    Service.operator_choice_enabled == 1,
                    Service.operator_choice_allow_offline == 1,
                ),
            ),
        )
        .distinct()
        .all()
    }

    services = (
        db.query(Service)
        .filter(Service.id.in_(service_ids), Service.is_archived == 0)
        .all()
    )
    for service in services:
        new_status = "active" if service.id in available_service_ids else "inactive"
        if service.status != new_status:
            service.status = new_status

    if commit:
        db.commit()


def get_operator_state(operator_id: int):
    db = SessionLocal()
    try:
        operator = db.query(Operator).filter(Operator.id == operator_id).first()
        if not operator or not operator.window_id:
            return {"error": "Оператор не найден или нет окна"}

        window = db.query(Window).filter(Window.id == operator.window_id).first()

        # Очередь (уже с учетом приоритета, как мы делали ранее)
        tickets = (
            db.query(Ticket)
            .join(WindowService, Ticket.service_id == WindowService.service_id)
            .filter(
                WindowService.window_id == operator.window_id,
                Ticket.status == "waiting",
            )
            .order_by(WindowService.priority.desc(), queue_order_expr().asc())
            .all()
        )

        current_ticket = db.query(Ticket)\
            .filter(Ticket.window_id == operator.window_id, Ticket.status.in_(ACTIVE_TICKET_STATUSES))\
            .first()

        # Услуги с приоритетами
        services_data = (
            db.query(Service.id, Service.name, WindowService.priority)
            .join(WindowService, Service.id == WindowService.service_id)
            .filter(
                WindowService.window_id == operator.window_id,
                Service.is_archived == 0,
            )
            .order_by(WindowService.priority.desc())
            .all()
        )
        service_ids = [service.id for service in services_data]
        notification_settings = {}
        if service_ids:
            notification_settings = {
                setting.service_id: bool(setting.enabled)
                for setting in db.query(OperatorServiceNotification)
                .filter(
                    OperatorServiceNotification.operator_id == operator.id,
                    OperatorServiceNotification.service_id.in_(service_ids),
                )
                .all()
            }

        return {
            "operator": {"id": operator.id, "name": operator.name},
            "window": {"id": window.id, "name": window.name, "status": window.status if window else "offline"},
            "services": [
                {
                    "id": service.id,
                    "name": service.name,
                    "priority": service.priority,
                    "notifications_enabled": notification_settings.get(service.id, True),
                }
                for service in services_data
            ],
            "queue": [{"id": t.id, "number": t.number} for t in tickets],
            "current_ticket": {"id": current_ticket.id, "number": current_ticket.number} if current_ticket else None
        }
    finally:
        db.close()


async def cleanup_sessions():
    print("[System] Фоновая задача очистки сессий запущена")
    while True:
        await asyncio.sleep(SESSION_TIMEOUT_SECONDS)
        db: Session = SessionLocal()
        try:
            settings = get_system_settings_dict(db)
            timeout_datetime = datetime.now() - timedelta(seconds=SESSION_TIMEOUT_SECONDS)
            mapped_session_ids = list(manager.session_id_to_ws.keys())
            ws_alive_operator_ids = set()
            ws_alive_admin_ids = set()
            
            if mapped_session_ids:
                ws_user_rows = (
                    db.query(UserSession.operator_id)
                    .filter(UserSession.session_id.in_(mapped_session_ids))
                    .all()
                )
                ws_admin_rows = (
                    db.query(AdminSession.admin_id)
                    .filter(AdminSession.session_id.in_(mapped_session_ids))
                    .all()
                )
                ws_alive_operator_ids = {row[0] for row in ws_user_rows if row and row[0] is not None}
                ws_alive_admin_ids = {row[0] for row in ws_admin_rows if row and row[0] is not None}

            # --- ЧАСТЬ 1: ОПЕРАТОРЫ ---
            # Автоочистку можно выключить флагом, оставив ручной logout и closeDay.
            dead_sessions = []
            if OPERATOR_SESSION_AUTO_CLEANUP_ENABLED:
                dead_sessions = db.query(UserSession).filter(
                    UserSession.last_seen < timeout_datetime,
                    UserSession.is_expirable == 1  # <--- Игнорируем вечные сессии
                ).all()
            
            if dead_sessions:
                print(f"\n[Cleanup] Найдено мертвых сессий операторов: {len(dead_sessions)}")
                need_board_update = False

                for session in dead_sessions:
                    if session.operator_id in ws_alive_operator_ids:
                        session.last_seen = datetime.now()
                        continue

                    other_alive = db.query(UserSession).filter(
                        UserSession.operator_id == session.operator_id,
                        UserSession.last_seen >= timeout_datetime,
                        UserSession.session_id != session.session_id
                    ).first()

                    if other_alive:
                        db.delete(session)
                        continue

                    operator = db.query(Operator).filter(Operator.id == session.operator_id).first()

                    if operator and operator.window_id:
                        window = db.query(Window).filter(Window.id == operator.window_id).first()

                        if window:
                            window.status = "offline"
                            record_operator_status(
                                db, operator.id, window.id, window.status
                            )
                            db.flush()

                            if settings["active_ticket_on_operator_logout"] == "return_to_queue":
                                active_ticket = db.query(Ticket).filter(
                                    Ticket.window_id == operator.window_id,
                                    Ticket.status.in_(ACTIVE_TICKET_STATUSES)
                                ).first()

                                if active_ticket:
                                    return_ticket_to_queue(active_ticket)

                                    need_board_update = True

                            update_services_status_for_window(db, window.id)

                    db.delete(session)

            # --- ЧАСТЬ 2: АДМИНИСТРАТОРЫ / ТЕРМИНАЛЫ ---
            # Аналогично добавляем фильтр AdminSession.is_expirable == 1
            dead_admin_sessions = db.query(AdminSession).filter(
                AdminSession.last_seen < timeout_datetime,
                AdminSession.is_expirable == 1  # <--- Игнорируем терминалы
            ).all()
            
            if dead_admin_sessions:
                print(f"[Cleanup] Найдено мертвых сессий админов: {len(dead_admin_sessions)}")
                for a_session in dead_admin_sessions:
                    if a_session.admin_id in ws_alive_admin_ids:
                        a_session.last_seen = datetime.now()
                        continue

                    db.delete(a_session)

            db.commit()

            if dead_sessions:
                await manager.broadcast({"type": "services_updated", "target": "operator"})
                if need_board_update:
                    await broadcast_board()
                    await manager.broadcast({"type": "queue_updated"})

        except Exception as e:
            print(f"[Cleanup] ОШИБКА: {e}")
            db.rollback()
        finally:
            db.close()
