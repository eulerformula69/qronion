import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
from datetime import datetime, timedelta
from pathlib import Path as FilePath
from typing import List

import bcrypt
from fastapi import (
    APIRouter, Body, Depends, File, Header, HTTPException, Query, UploadFile,
    WebSocket, WebSocketDisconnect, status,
)
from fastapi.encoders import jsonable_encoder
from fastapi.params import Path
from fastapi.responses import FileResponse
from sqlalchemy import and_, asc, func, literal
from sqlalchemy.orm import Session

from app.config import (
    ALLOWED_MEDIA_EXTENSIONS, BASE_DIR, DEFAULT_PAGE_LIMIT, MAX_FILE_SIZE,
    MAX_PAGE_LIMIT, PIPER_MODEL, PIPER_PATH, SESSION_TIMEOUT_SECONDS,
    TTS_CACHE_DIR, TTS_LENGTH_SCALE,
    TTS_NOISE_SCALE, TTS_NOISE_W_SCALE,
)
from app.connections import manager
from app.database import SessionLocal
from app.dependencies import (
    get_current_terminal, get_operator_by_session, verify_admin_session,
    verify_session,
)
from app.models import (
    AVAILABLE_WINDOW_STATUSES, Operator, Service, Ticket, Window, WindowService,
)
from app.schemas import (
    CallNextRequest, CallSpecificRequest, CancelTicketRequest, DeferTicketRequest,
    RedirectRequest,
    RedirectToWindowRequest, TicketCreate, TicketReprintResponse,
)
from app.security import get_password_hash, verify_password
from app.services.settings import get_system_settings_dict, normalize_ticket_reason
from app.services.ticket_lifecycle import (
    ACTIVE_TICKET_STATUSES,
    InvalidTicketTransition,
    start_ticket_service,
)
from app.services.ticket_status import TicketStatusError, cancel_ticket, publish_ticket_updated
from app.services.tickets import (
    called_ticket_wait_remaining_seconds,
    broadcast_board, claim_next_ticket,
    broadcast_ticket_called, create_window_redirect_ticket, queue_order_expr,
    defer_ticket, render_ticket_template, resume_cancelled_ticket, resume_deferred_ticket,
    recall_cooldown_remaining_seconds, redirect_called_ticket,
    return_ticket_to_queue,
)
from app.services.operators import resolve_operator_auto_call_enabled

from app.routers.ticket_creation import router as creation_router

router = APIRouter()
router.include_router(creation_router)

REDIRECT_LIMIT_DETAIL = "Этот талон больше нельзя перенаправлять"


def ensure_ticket_redirect_allowed(ticket: Ticket, max_redirects: int) -> None:
    if (ticket.returned_to_queue_count or 0) >= max_redirects:
        raise HTTPException(status_code=409, detail=REDIRECT_LIMIT_DETAIL)

CLIENT_OPERATIONS_ON_BREAK_DETAIL = "Нельзя выполнять операции с клиентом, пока оператор на перерыве"


def is_ticket_redirected_to_operator_window(ticket, operator_window_id: int | None) -> bool:
    return (
        ticket.target_window_id == operator_window_id
        and ticket.completion_reason == "redirected"
    )


def operator_window_is_on_break(db: Session, operator: Operator) -> bool:
    if not operator.window_id:
        return False

    window = db.query(Window).filter(Window.id == operator.window_id).first()
    return bool(window and window.status == "break")


def ensure_client_operations_allowed(db: Session, operator: Operator) -> None:
    if not operator_window_is_on_break(db, operator):
        return

    active_ticket = db.query(Ticket.id).filter(
        Ticket.window_id == operator.window_id,
        Ticket.status.in_(ACTIVE_TICKET_STATUSES),
    ).first()
    if active_ticket:
        return

    raise HTTPException(status_code=409, detail=CLIENT_OPERATIONS_ON_BREAK_DETAIL)


def ensure_operator_has_no_deferred_tickets(db: Session, operator: Operator) -> None:
    settings = get_system_settings_dict(db)
    deferred_limit = settings["max_deferred_tickets_per_operator"]
    deferred_count = db.query(func.count(Ticket.id)).filter(
        Ticket.operator_id == operator.id,
        Ticket.window_id == operator.window_id,
        Ticket.status == "deferred",
    ).scalar() or 0
    if deferred_count >= deferred_limit:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Достигнут лимит отложенных талонов ({deferred_limit}). "
                "Сначала верните один из них в обслуживание."
            ),
        )


def build_operator_queue_ticket_payload(ticket, operator_window_id: int | None) -> dict:
    return {
        "id": ticket.id,
        "number": ticket.number,
        "service_id": ticket.service_id,
        "service_name": ticket.service_name or "Неизвестно",
        "created_at": ticket.created_at.strftime("%H:%M") if ticket.created_at else "—",
        "priority": getattr(ticket, "priority", None),
        "target_window_id": ticket.target_window_id,
        "is_redirected_to_window": is_ticket_redirected_to_operator_window(
            ticket,
            operator_window_id,
        ),
    }


def _format_ticket_time(value) -> str:
    return value.strftime("%H:%M") if value else "—"


def build_operator_ticket_detail_payload(ticket: Ticket) -> dict:
    service_name = ticket.service.name if ticket.service else "Услуга не указана"
    reason = ticket.defer_reason or ticket.cancel_reason or ticket.completion_reason
    return {
        "id": ticket.id,
        "number": ticket.number,
        "service_id": ticket.service_id,
        "service_name": service_name,
        "created_at": _format_ticket_time(ticket.created_at),
        "called_at": _format_ticket_time(ticket.called_at),
        "finished_at": _format_ticket_time(ticket.finished_at),
        "deferred_at": _format_ticket_time(ticket.deferred_at),
        "status": ticket.status,
        "completion_reason": ticket.completion_reason,
        "defer_reason": ticket.defer_reason,
        "cancel_reason": ticket.cancel_reason,
        "reason": reason,
    }


def get_served_operator_tickets(
    db: Session,
    *,
    window_id: int,
    today_start: datetime,
    tomorrow_start: datetime,
):
    return (
        db.query(Ticket)
        .filter(
            Ticket.window_id == window_id,
            Ticket.status == "finished",
            Ticket.completion_reason.in_(("completed", "redirected")),
            Ticket.finished_at >= today_start,
            Ticket.finished_at < tomorrow_start,
        )
        .order_by(Ticket.finished_at.desc())
        .all()
    )


def _today_bounds(now: datetime | None = None):
    current = now or datetime.now()
    today_start = current.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_start = today_start + timedelta(days=1)
    return today_start, tomorrow_start


def build_reprint_ticket_payload(
    db: Session,
    number: int,
    now: datetime | None = None,
) -> dict:
    today_start, tomorrow_start = _today_bounds(now)

    ticket = (
        db.query(Ticket)
        .filter(
            Ticket.number == number,
            Ticket.created_at >= today_start,
            Ticket.created_at < tomorrow_start,
        )
        .order_by(Ticket.created_at.desc())
        .first()
    )

    if not ticket:
        raise HTTPException(status_code=404, detail="Талон за сегодня не найден")

    waiting_before = (
        db.query(Ticket)
        .filter(
            Ticket.status == "waiting",
            Ticket.id < ticket.id,
        )
        .count()
    )

    return {
        "id": ticket.id,
        "number": ticket.number,
        "service_name": ticket.service.name if ticket.service else "Услуга не найдена",
        "waiting_before": waiting_before,
        "date": ticket.created_at.strftime("%d.%m.%Y %H:%M") if ticket.created_at else "",
    }


@router.get("/tickets/reprint/{number}", response_model=TicketReprintResponse, tags=["Tickets"])
def reprint_ticket(
    number: int = Path(..., gt=0),
    _auth = Depends(get_current_terminal),
):
    db = SessionLocal()
    try:
        return build_reprint_ticket_payload(db, number)
    finally:
        db.close()


@router.post("/tickets/finish", tags=["Tickets"])
async def finish_ticket(operator: Operator = Depends(verify_session)):
    db = SessionLocal()

    if not operator.window_id:
        db.close()
        raise HTTPException(status_code=404, detail="Operator or window not found")

    try:
        ensure_client_operations_allowed(db, operator)
    except HTTPException:
        db.close()
        raise
    
    ticket = db.query(Ticket).filter(
        Ticket.window_id == operator.window_id,
        Ticket.status == "serving"
    ).first()

    if not ticket:
        db.close()
        return {"detail": "Нет текущего клиента"}

    settings = get_system_settings_dict(db)
    min_wait_seconds = settings["called_ticket_min_wait_seconds"]
    remaining_seconds = called_ticket_wait_remaining_seconds(
        ticket,
        min_wait_seconds,
    )
    if remaining_seconds:
        db.close()
        raise HTTPException(
            status_code=409,
            detail=(
                "Завершение будет доступно через "
                f"{remaining_seconds} сек. после вызова клиента"
            ),
        )

    # Завершаем тикет
    ticket.status = "finished"
    ticket.completion_reason = "completed"
    if ticket.operator_id is None:
        ticket.operator_id = operator.id
    ticket.finished_at = datetime.now() #text("CURRENT_TIMESTAMP")

    db.commit()
    db.refresh(ticket)

    await manager.broadcast({"type": "queue_updated"})
    await broadcast_board()

    db.close()
    return ticket


@router.post("/tickets/start-service", tags=["Tickets"])
async def start_service(operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        if not operator.window_id:
            raise HTTPException(status_code=400, detail="Оператору не назначено окно")

        ensure_client_operations_allowed(db, operator)
        ticket = db.query(Ticket).filter(
            Ticket.window_id == operator.window_id,
            Ticket.status == "called",
        ).with_for_update().first()
        if not ticket:
            raise HTTPException(status_code=404, detail="Нет вызванного клиента")

        try:
            start_ticket_service(
                ticket,
                operator_id=operator.id,
                window_id=operator.window_id,
            )
        except InvalidTicketTransition as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        db.commit()
        db.refresh(ticket)
        await manager.broadcast({"type": "queue_updated"})

        return {
            "id": ticket.id,
            "number": ticket.number,
            "status": ticket.status,
            "service_started_at": ticket.service_started_at,
            "finish_remaining_seconds": get_system_settings_dict(db)[
                "called_ticket_min_wait_seconds"
            ],
        }
    finally:
        db.close()


@router.post("/tickets/next", tags=["Tickets"])
async def call_next_ticket(
    data: CallNextRequest | None = Body(default=None),
    operator: Operator = Depends(verify_session),
):
    db = SessionLocal()
    try:
        if not operator.window_id:
            return {"detail": "Оператору не назначено окно"}

        ensure_client_operations_allowed(db, operator)
        ensure_operator_has_no_deferred_tickets(db, operator)

        settings = get_system_settings_dict(db)
        is_auto_call = bool(data and data.auto_call)
        if is_auto_call:
            window = db.query(Window).filter(Window.id == operator.window_id).first()
            if not window or window.status != "online":
                return {"detail": "Автовызов доступен только в статусе Online"}
            if not resolve_operator_auto_call_enabled(
                operator,
                settings["auto_call_enabled"],
            ):
                return {"detail": "Автовызов отключён"}

        ticket, claimed = claim_next_ticket(
            db,
            operator=operator,
            require_online=is_auto_call,
            balance_settings=settings if is_auto_call else None,
        )

        if ticket and not claimed:
            return {"detail": f"Сначала завершите клиента: {ticket.number}"}

        if not ticket:
            return {"detail": "Нет ожидающих билетов"}

        db.commit()
        db.refresh(ticket)

        window = db.query(Window).filter(Window.id == ticket.window_id).first()

        await manager.broadcast({"type": "queue_updated"})
        await broadcast_board()

        if window:
            await broadcast_ticket_called(ticket, window)

        return {
            "id": ticket.id,
            "number": ticket.number,
            "status": ticket.status,
            "called_at": ticket.called_at,
            "last_recalled_at": ticket.last_recalled_at,
            "service_name": ticket.service.name if ticket.service else "Услуга не найдена"
        }
    finally:
        db.close()


@router.post("/tickets/call-specific", tags=["Tickets"])
async def call_specific_ticket(data: CallSpecificRequest, operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        if not operator.window_id:
            return {"detail": "Оператору не назначено окно"}

        ensure_client_operations_allowed(db, operator)
        ensure_operator_has_no_deferred_tickets(db, operator)

        # Проверяем, не обслуживается ли уже клиент
        current = db.query(Ticket).filter(
            Ticket.window_id == operator.window_id,
            Ticket.status.in_(ACTIVE_TICKET_STATUSES)
        ).first()

        if current:
            return {"detail": f"Сначала завершите клиента: {current.number}"}

        # Ищем билет по номеру только за сегодняшний день
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        tomorrow_start = today_start + timedelta(days=1)

        ticket = db.query(Ticket).filter(
            Ticket.number == data.number,
            Ticket.status == "waiting",
            Ticket.created_at >= today_start,
            Ticket.created_at < tomorrow_start
        ).order_by(Ticket.created_at.desc()).with_for_update(skip_locked=True).first()

        if not ticket:
            return {"detail": "Ожидающий талон с таким номером за сегодня не найден"}

        # Если билет был перенаправлен на конкретное окно, вызвать его может только это окно.
        if (
            ticket.target_window_id is not None
            and ticket.target_window_id != operator.window_id
        ):
            return {"detail": "Этот талон перенаправлен на другое рабочее место"}

        # Обычные билеты по-прежнему можно вызвать только на окне, которое обслуживает их услугу.
        if ticket.target_window_id is None:
            window_service = db.query(WindowService).filter(
                WindowService.window_id == operator.window_id,
                WindowService.service_id == ticket.service_id
            ).first()

            if not window_service:
                return {"detail": "Ваше окно не обслуживает услугу этого талона"}

        # Обновляем статус билета и привязываем к текущему окну
        ticket.status = "called"
        ticket.completion_reason = None
        ticket.operator_id = operator.id
        ticket.window_id = operator.window_id
        ticket.target_window_id = None
        ticket.called_at = datetime.now()
        ticket.service_started_at = None
        ticket.last_recalled_at = None
        ticket.finished_at = None
        ticket.defer_reason = None
        ticket.deferred_at = None
        ticket.cancel_reason = None

        db.commit()
        db.refresh(ticket)

        window = db.query(Window).filter(Window.id == ticket.window_id).first()

        # Обновляем табло только после сохранения в БД
        await broadcast_board()

        if window:
            await broadcast_ticket_called(ticket, window)

        return {
            "id": ticket.id,
            "number": ticket.number,
            "status": ticket.status,
            "called_at": ticket.called_at,
            "service_name": ticket.service.name if ticket.service else "Услуга не найдена"
        }
    finally:
        db.close()


@router.post("/tickets/cancel", tags=["Tickets"])
async def cancel_current_ticket(
    data: CancelTicketRequest | None = Body(default=None),
    operator: Operator = Depends(verify_session),
):
    db = SessionLocal()

    if not operator.window_id:
        db.close()
        return {"detail": "Оператору не назначено окно"}

    try:
        ensure_client_operations_allowed(db, operator)
    except HTTPException:
        db.close()
        raise

    # Ищем текущий вызванный билет в этом окне
    ticket = db.query(Ticket).filter(
        Ticket.window_id == operator.window_id,
        Ticket.status == "called"
    ).first()

    if not ticket:
        db.close()
        return {"detail": "Нет активного билета для отмены (клиент не вызван)"}

    cancel_reason = normalize_ticket_reason(data.reason if data else "Клиент не явился")
    try:
        previous_status = cancel_ticket(
            db, ticket, cancel_reason, operator_id=operator.id
        )
    except TicketStatusError as exc:
        db.close()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    db.commit()
    db.refresh(ticket)

    await publish_ticket_updated({
        "id": ticket.id,
        "number": ticket.number,
        "status": ticket.status,
        "service_id": ticket.service_id,
        "operator_id": ticket.operator_id,
        "window_id": ticket.window_id,
        "cancel_reason": ticket.cancel_reason,
        "finished_at": ticket.finished_at.isoformat() if ticket.finished_at else None,
    }, previous_status)

    db.close()

    return {
        "status": "cancelled",
        "ticket_number": ticket.number,
        "cancel_reason": ticket.cancel_reason,
    }


@router.post("/tickets/return-to-queue", tags=["Tickets"])
async def return_current_ticket_to_queue(operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        if not operator.window_id:
            raise HTTPException(status_code=400, detail="Оператору не назначено окно")

        ensure_client_operations_allowed(db, operator)

        ticket = db.query(Ticket).filter(
            Ticket.window_id == operator.window_id,
            Ticket.status.in_(ACTIVE_TICKET_STATUSES)
        ).first()

        if not ticket:
            raise HTTPException(status_code=404, detail="Нет активного билета для возврата в очередь")

        return_ticket_to_queue(ticket)

        db.commit()
        db.refresh(ticket)

        await manager.broadcast({"type": "queue_updated"})
        await broadcast_board()

        return {
            "status": "waiting",
            "ticket_number": ticket.number,
        }
    finally:
        db.close()


@router.post("/tickets/defer", tags=["Tickets"])
async def defer_current_ticket(
    data: DeferTicketRequest,
    operator: Operator = Depends(verify_session),
):
    db = SessionLocal()
    try:
        if not operator.window_id:
            raise HTTPException(status_code=400, detail="Оператору не назначено окно")

        ensure_client_operations_allowed(db, operator)

        ticket = db.query(Ticket).filter(
            Ticket.window_id == operator.window_id,
            Ticket.status.in_(ACTIVE_TICKET_STATUSES),
        ).first()

        if not ticket:
            raise HTTPException(status_code=404, detail="Нет активного билета для отложения")

        settings = get_system_settings_dict(db)
        deferred_count = db.query(func.count(Ticket.id)).filter(
            Ticket.operator_id == operator.id,
            Ticket.status == "deferred",
        ).scalar() or 0
        deferred_limit = settings["max_deferred_tickets_per_operator"]
        if deferred_count >= deferred_limit:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Количество отложенных талонов: {deferred_count}. "
                    f"Сначала верните один из них в обслуживание (лимит: {deferred_limit})."
                ),
            )

        defer_ticket(
            ticket,
            operator_id=operator.id,
            window_id=operator.window_id,
            reason=normalize_ticket_reason(data.reason),
        )

        db.commit()
        db.refresh(ticket)

        await manager.broadcast({"type": "queue_updated"})
        await broadcast_board()

        return {
            "status": "deferred",
            "ticket_number": ticket.number,
            "defer_reason": ticket.defer_reason,
        }
    finally:
        db.close()


async def _resume_operator_ticket(
    db,
    *,
    ticket_id: int,
    operator: Operator,
    source_status: str,
    not_found_detail: str,
    resume_ticket,
):
    if not operator.window_id:
        raise HTTPException(status_code=400, detail="Оператору не назначено окно")

    ensure_client_operations_allowed(db, operator)
    if source_status != "deferred":
        ensure_operator_has_no_deferred_tickets(db, operator)

    current = db.query(Ticket).filter(
        Ticket.window_id == operator.window_id,
        Ticket.status.in_(ACTIVE_TICKET_STATUSES),
    ).first()

    if current:
        raise HTTPException(status_code=409, detail=f"Сначала завершите клиента: {current.number}")

    filters = [
        Ticket.id == ticket_id,
        Ticket.status == source_status,
        Ticket.window_id == operator.window_id,
    ]
    if source_status == "deferred":
        filters.append(Ticket.operator_id == operator.id)

    ticket = db.query(Ticket).filter(*filters).first()
    if not ticket:
        raise HTTPException(status_code=404, detail=not_found_detail)

    resume_ticket(ticket, operator_id=operator.id, window_id=operator.window_id)

    db.commit()
    db.refresh(ticket)

    window = db.query(Window).filter(Window.id == ticket.window_id).first()

    await manager.broadcast({"type": "queue_updated"})
    await broadcast_board()

    if window and source_status != "deferred":
        await broadcast_ticket_called(ticket, window)

    return {
        "id": ticket.id,
        "number": ticket.number,
        "status": ticket.status,
        "called_at": ticket.called_at,
        "service_started_at": ticket.service_started_at,
        "service_name": ticket.service.name if ticket.service else "Услуга не найдена",
    }


@router.post("/tickets/deferred/{ticket_id}/resume", tags=["Tickets"])
async def resume_operator_deferred_ticket(
    ticket_id: int,
    operator: Operator = Depends(verify_session),
):
    db = SessionLocal()
    try:
        return await _resume_operator_ticket(
            db,
            ticket_id=ticket_id,
            operator=operator,
            source_status="deferred",
            not_found_detail="Отложенный билет не найден",
            resume_ticket=resume_deferred_ticket,
        )
    finally:
        db.close()


@router.post("/tickets/deferred/{ticket_id}/cancel", tags=["Tickets"])
async def cancel_operator_deferred_ticket(
    ticket_id: int,
    data: CancelTicketRequest | None = Body(default=None),
    operator: Operator = Depends(verify_session),
):
    db = SessionLocal()
    try:
        if not operator.window_id:
            raise HTTPException(status_code=400, detail="Оператору не назначено окно")

        ensure_client_operations_allowed(db, operator)
        ticket = db.query(Ticket).filter(
            Ticket.id == ticket_id,
            Ticket.status == "deferred",
            Ticket.operator_id == operator.id,
            Ticket.window_id == operator.window_id,
        ).first()
        if not ticket:
            raise HTTPException(status_code=404, detail="Отложенный талон не найден")

        ticket.status = "cancelled"
        ticket.completion_reason = "cancelled"
        ticket.cancel_reason = normalize_ticket_reason(
            data.reason if data else "Отменён из отложенных"
        )
        ticket.defer_reason = None
        ticket.deferred_at = None
        ticket.finished_at = datetime.now()

        db.commit()
        db.refresh(ticket)
        await manager.broadcast({"type": "queue_updated"})
        await broadcast_board()

        return {
            "status": ticket.status,
            "ticket_number": ticket.number,
            "cancel_reason": ticket.cancel_reason,
        }
    finally:
        db.close()


@router.post("/tickets/cancelled/{ticket_id}/resume", tags=["Tickets"])
async def resume_operator_cancelled_ticket(
    ticket_id: int,
    operator: Operator = Depends(verify_session),
):
    db = SessionLocal()
    try:
        return await _resume_operator_ticket(
            db,
            ticket_id=ticket_id,
            operator=operator,
            source_status="cancelled",
            not_found_detail="Отменённый билет не найден",
            resume_ticket=resume_cancelled_ticket,
        )
    finally:
        db.close()


@router.get("/tickets/my-queue", tags=["Tickets"])
def get_my_queue(
    skip: int = Query(0, ge=0),
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    operator: Operator = Depends(verify_session)
    ):
    db = SessionLocal()
    try:
        if not operator.window_id:
            return []

        # 1) Перенаправленные именно на это окно билеты всегда сверху.
        redirected_query = (
            db.query(
                Ticket.id,
                Ticket.number,
                Ticket.service_id,
                Ticket.created_at,
                Ticket.completion_reason,
                Ticket.target_window_id,
                Service.name.label("service_name"),
                literal(0).label("priority")
            )
            .join(Service, Service.id == Ticket.service_id)
            .filter(
                Ticket.status == "waiting",
                Ticket.target_window_id == operator.window_id,
            )
            .order_by(queue_order_expr().asc())
        )

        # 2) Обычные билеты ниже — по приоритету услуг и FIFO.
        ordinary_query = (
            db.query(
                Ticket.id,
                Ticket.number,
                Ticket.service_id,
                Ticket.created_at,
                Ticket.completion_reason,
                Ticket.target_window_id,
                Service.name.label("service_name"),
                WindowService.priority.label("priority")
            )
            .join(WindowService, Ticket.service_id == WindowService.service_id)
            .join(Service, Service.id == Ticket.service_id)
            .filter(
                WindowService.window_id == operator.window_id,
                Ticket.status == "waiting",
                Ticket.target_window_id.is_(None),
            )
            .order_by(
                WindowService.priority.asc(),
                queue_order_expr().asc()
            )
        )

        tickets = (redirected_query.all() + ordinary_query.all())[skip:skip + limit]

        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        tomorrow_start = today_start + timedelta(days=1)
        tickets_served_today = db.query(Ticket).filter(
            Ticket.window_id == operator.window_id,
            Ticket.status == "finished",
            Ticket.finished_at >= today_start
        ).count()

        result = []
        for t in tickets:
            result.append(build_operator_queue_ticket_payload(t, operator.window_id))

        waiting_details = []
        if result:
            waiting_ids = [ticket["id"] for ticket in result]
            waiting_detail_tickets = (
                db.query(Ticket)
                .filter(Ticket.id.in_(waiting_ids))
                .all()
            )
            waiting_details_by_id = {
                ticket.id: build_operator_ticket_detail_payload(ticket)
                for ticket in waiting_detail_tickets
            }
            waiting_details = [
                waiting_details_by_id[ticket_id]
                for ticket_id in waiting_ids
                if ticket_id in waiting_details_by_id
            ]

        deferred_tickets = (
            db.query(Ticket)
            .filter(
                Ticket.status == "deferred",
                Ticket.operator_id == operator.id,
                Ticket.window_id == operator.window_id,
                Ticket.created_at >= today_start,
                Ticket.created_at < tomorrow_start,
            )
            .order_by(Ticket.deferred_at.desc(), Ticket.created_at.desc())
            .all()
        )

        cancelled_tickets = (
            db.query(Ticket)
            .filter(
                Ticket.window_id == operator.window_id,
                Ticket.created_at >= today_start,
                Ticket.created_at < tomorrow_start,
                (
                    (Ticket.status == "cancelled")
                    | (
                        (Ticket.status == "finished")
                        & (Ticket.completion_reason == "cancelled")
                    )
                ),
            )
            .order_by(Ticket.finished_at.desc(), Ticket.created_at.desc())
            .all()
        )

        served_tickets = get_served_operator_tickets(
            db,
            window_id=operator.window_id,
            today_start=today_start,
            tomorrow_start=tomorrow_start,
        )

        sections = {
            "waiting": waiting_details,
            "deferred": [
                build_operator_ticket_detail_payload(ticket)
                for ticket in deferred_tickets
            ],
            "cancelled": [
                build_operator_ticket_detail_payload(ticket)
                for ticket in cancelled_tickets
            ],
            "served": [
                build_operator_ticket_detail_payload(ticket)
                for ticket in served_tickets
            ],
        }

        return {
            "tickets": result,
            "tickets_served_today": tickets_served_today,
            "deferred_since": min(
                (ticket.deferred_at for ticket in deferred_tickets if ticket.deferred_at),
                default=None,
            ),
            "sections": sections,
            "section_counts": {
                key: len(value)
                for key, value in sections.items()
            },
        }
    finally:
        db.close()


@router.post("/tickets/redirect-to-window", tags=["Tickets"])
async def redirect_ticket_to_window(data: RedirectToWindowRequest, operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        if not operator.window_id:
            raise HTTPException(status_code=400, detail="Оператору не назначено окно")

        ensure_client_operations_allowed(db, operator)

        ticket = db.query(Ticket).filter(
            Ticket.id == data.ticket_id,
            Ticket.status.in_(("called", "serving"))
        ).first()
        if not ticket:
            raise HTTPException(status_code=404, detail="Вызванный билет не найден")

        if ticket.window_id != operator.window_id:
            raise HTTPException(status_code=403, detail="Этот билет не является текущим билетом вашего окна")

        settings = get_system_settings_dict(db)
        ensure_ticket_redirect_allowed(ticket, settings["max_ticket_redirects"])

        target_window = db.query(Window).filter(Window.id == data.window_id).first()
        if not target_window:
            raise HTTPException(status_code=404, detail="Рабочее место для перенаправления не найдено")
        allowed_statuses = ["online"]
        if settings["redirect_allow_break"]:
            allowed_statuses.append("break")
        if settings["redirect_allow_offline"]:
            allowed_statuses.append("offline")
        if target_window.status not in allowed_statuses:
            raise HTTPException(
                status_code=400,
                detail="Выбранное рабочее место сейчас недоступно для перенаправления",
            )

        service = (
            db.query(Service)
            .filter(Service.id == data.new_service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Услуга для перенаправления не найдена")
        if service.status != "active":
            raise HTTPException(status_code=400, detail="Выбранная услуга сейчас недоступна")

        window_service = (
            db.query(WindowService)
            .filter(
                WindowService.window_id == target_window.id,
                WindowService.service_id == service.id,
            )
            .first()
        )
        if not window_service:
            raise HTTPException(status_code=400, detail="Выбранное окно не оказывает эту услугу")

        if ticket.status == "called":
            redirect_called_ticket(
                ticket,
                service_id=service.id,
                target_window_id=target_window.id,
            )
            redirected_ticket = ticket
        else:
            redirected_ticket = create_window_redirect_ticket(
                ticket,
                target_window_id=target_window.id,
                operator_id=operator.id,
                service_id=service.id,
            )
            db.add(redirected_ticket)

        db.commit()
        db.refresh(redirected_ticket)

        await manager.broadcast({"type": "queue_updated"})
        await broadcast_board()

        message = f"Билет перенаправлен на рабочее место: {target_window.name}"
        return {"message": message, "ticket": redirected_ticket}
    finally:
        db.close()


@router.post("/tickets/redirect", tags=["Tickets"])
async def redirect_ticket(data: RedirectRequest, operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        if not operator.window_id:
            raise HTTPException(status_code=400, detail="Оператору не назначено окно")

        ensure_client_operations_allowed(db, operator)

        settings = get_system_settings_dict(db)

        ticket = db.query(Ticket).filter(
            Ticket.id == data.ticket_id,
            Ticket.status.in_(("called", "serving"))
        ).first()
        if not ticket:
            return {"detail": "Сначала завершите текущего клиента или тикет не найден"}

        if ticket.window_id != operator.window_id:
            raise HTTPException(
                status_code=403,
                detail="Этот билет не является текущим билетом вашего рабочего места",
            )

        ensure_ticket_redirect_allowed(ticket, settings["max_ticket_redirects"])

        service = (
            db.query(Service)
            .filter(Service.id == data.new_service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            return {"detail": "Новая услуга не найдена"}
        if service.status != "active":
            return {"detail": "Выбранная услуга сейчас недоступна"}

        windows = (
            db.query(Window)
            .join(WindowService, Window.id == WindowService.window_id)
            .filter(
                WindowService.service_id == service.id,
                Window.status == "online"
            )
            .distinct()
            .order_by(Window.id)
            .all()
        )

        if not windows:
            return {"detail": "Нет доступных окон для этой услуги, Пожалуйста сообщите клиенту"}

        if ticket.status == "called":
            redirect_called_ticket(ticket, service_id=service.id)
            redirected_ticket = ticket
        else:
            redirected_at = datetime.now()
            root_ticket_id = ticket.root_ticket_id or ticket.id

            ticket.status = "finished"
            ticket.completion_reason = "redirected"
            if ticket.operator_id is None:
                ticket.operator_id = operator.id
            ticket.finished_at = redirected_at

            redirected_ticket = Ticket(
                number=ticket.number,
                service_id=service.id,
                status="waiting",
                completion_reason=None,
                root_ticket_id=root_ticket_id,
                operator_id=None,
                window_id=None,
                target_window_id=None,
                created_at=redirected_at,
                returned_to_queue_count=(ticket.returned_to_queue_count or 0) + 1,
                queue_entered_at=redirected_at,
                called_at=None,
                finished_at=None,
            )
            db.add(redirected_ticket)
            db.flush()

        db.commit()
        db.refresh(redirected_ticket)

        await manager.broadcast({
            "type": "queue_updated",
            "service_id": service.id
        })

        asyncio.create_task(broadcast_board())

        return {"message": "Билет перенаправлен", "ticket": redirected_ticket}

    finally:
        db.close()


@router.post("/tickets/recall", tags=["Tickets"])
async def recall_ticket(operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        if not operator.window_id:
            raise HTTPException(status_code=400, detail="Оператору не назначено окно")

        ensure_client_operations_allowed(db, operator)

        ticket = db.query(Ticket).filter(
            Ticket.window_id == operator.window_id,
            Ticket.status == "called"
        ).first()

        if not ticket:
            raise HTTPException(status_code=404, detail="Нет активного клиента для повторного вызова")

        now = datetime.now()
        remaining_seconds = recall_cooldown_remaining_seconds(ticket, now=now)
        if remaining_seconds:
            raise HTTPException(
                status_code=409,
                detail=f"Повторный вызов будет доступен через {remaining_seconds} сек.",
            )

        window = db.query(Window).filter(Window.id == operator.window_id).first()
        if not window:
            raise HTTPException(status_code=404, detail="Окно не найдено")

        settings = get_system_settings_dict(db)

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

        ticket.last_recalled_at = now
        db.commit()

        await manager.broadcast({
            "type": "recall_ticket",
            "ticket_id": ticket.id,
            "ticket_number": ticket.number,
            "window_name": window.name,
            "display_text": display_text,
            "tts_text": tts_text
        })

        return {
            "status": "success",
            "message": f"Повторный вызов клиента {ticket.number}",
            "last_recalled_at": ticket.last_recalled_at,
            "recall_remaining_seconds": recall_cooldown_remaining_seconds(
                ticket,
                now=now,
            ),
        }
    finally:
        db.close()


@router.get("/tickets/current", tags=["Tickets"])
def get_current_ticket(operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        if not operator.window_id:
            return {"ticket": None}

        ticket = (
            db.query(Ticket)
            .filter(
                Ticket.status.in_(ACTIVE_TICKET_STATUSES),
                Ticket.window_id == operator.window_id
            )
            .order_by(Ticket.called_at.asc())
            .first()
        )

        if not ticket:
            return {"ticket": None}

        now = datetime.now()
        settings = get_system_settings_dict(db)
        ticket_payload = jsonable_encoder(ticket)
        ticket_payload["finish_remaining_seconds"] = (
            called_ticket_wait_remaining_seconds(
                ticket,
                settings["called_ticket_min_wait_seconds"],
                now=now,
            )
        )
        ticket_payload["recall_remaining_seconds"] = (
            recall_cooldown_remaining_seconds(ticket, now=now)
        )
        return {"ticket": ticket_payload}
    finally:
        db.close()
