import asyncio
import hashlib
import json
import math
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
from fastapi.params import Path
from fastapi.responses import FileResponse
from sqlalchemy import and_, asc, func, literal, text
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
    Admin, Operator, OperatorServiceNotification, Service, Window, WindowService,
    record_operator_status,
)
from app.schemas import (
    OperatorCreate, OperatorLoginUpdate, OperatorServiceNotificationRead,
    OperatorServiceNotificationUpdate, WindowOperatorUpdate,
)
from app.security import get_password_hash, verify_password
from app.services.operators import (
    get_operator_state, resolve_operator_auto_call_enabled,
)
from app.services.settings import get_system_settings_dict

router = APIRouter()

AUTO_CALL_MODES = {"default", "enabled", "disabled"}


def normalize_auto_call_mode(value) -> str:
    mode = str(value or "default").strip().lower()
    if mode not in AUTO_CALL_MODES:
        raise HTTPException(status_code=400, detail="Некорректный режим автовызова")
    return mode


def build_service_notification_payload(service_id, service_name, priority, enabled):
    return {
        "service_id": service_id,
        "service_name": service_name,
        "priority": priority,
        "enabled": bool(enabled),
    }


@router.get("/operators/auto-dispatch-state", tags=["Operators"])
def get_auto_dispatch_state(operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        current_operator = (
            db.query(Operator).filter(Operator.id == operator.id).first()
            or operator
        )
        settings = get_system_settings_dict(db)
        window = None
        if current_operator.window_id:
            window = (
                db.query(Window)
                .filter(Window.id == current_operator.window_id)
                .first()
            )

        now = datetime.now()
        deadline = current_operator.next_auto_call_at
        remaining_seconds = None
        if deadline:
            remaining_seconds = max(
                0,
                math.ceil((deadline - now).total_seconds()),
            )

        return {
            "enabled": resolve_operator_auto_call_enabled(
                current_operator,
                settings["auto_call_enabled"],
            ),
            "window_status": window.status if window else "offline",
            "next_auto_call_at": deadline.isoformat() if deadline else None,
            "remaining_seconds": remaining_seconds,
        }
    finally:
        db.close()


def get_operator_service_notifications(db: Session, operator: Operator):
    if not operator.window_id:
        return []

    services = (
        db.query(Service.id, Service.name, WindowService.priority)
        .join(WindowService, Service.id == WindowService.service_id)
        .filter(
            WindowService.window_id == operator.window_id,
            Service.is_archived == 0,
        )
        .order_by(WindowService.priority.asc(), Service.name.asc())
        .all()
    )
    service_ids = [service.id for service in services]
    if not service_ids:
        return []

    settings = (
        db.query(OperatorServiceNotification)
        .filter(
            OperatorServiceNotification.operator_id == operator.id,
            OperatorServiceNotification.service_id.in_(service_ids),
        )
        .all()
    )
    enabled_by_service_id = {
        setting.service_id: bool(setting.enabled)
        for setting in settings
    }

    return [
        build_service_notification_payload(
            service.id,
            service.name,
            service.priority,
            enabled_by_service_id.get(service.id, True),
        )
        for service in services
    ]


@router.get("/operator/windows", tags=["Operators"])
def get_operator_windows(operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        windows = db.query(Window).order_by(Window.id.asc()).all()
        result = []

        for w in windows:
            assigned_operator = (
                db.query(Operator)
                .filter(Operator.window_id == w.id)
                .first()
            )

            services = (
                db.query(Service)
                .join(WindowService, WindowService.service_id == Service.id)
                .filter(WindowService.window_id == w.id, Service.is_archived == 0)
                .order_by(WindowService.priority.asc(), Service.name.asc())
                .all()
            )

            result.append({
                "id": w.id,
                "name": w.name,
                "status": w.status,
                "operator_id": assigned_operator.id if assigned_operator else None,
                "operator_name": assigned_operator.name if assigned_operator else None,
                "operator_login": assigned_operator.login if assigned_operator else None,
                "services": [
                    {"id": service.id, "name": service.name, "status": service.status}
                    for service in services
                ],
                "service_names": [service.name for service in services]
            })

        return result
    finally:
        db.close()


@router.post("/operators/", tags=["Operators"])
def create_operator(
    operator: OperatorCreate, admin: Admin = Depends(verify_admin_session)
    ):
    db = SessionLocal()
    try:
        # 1. Хэшируем пароль перед сохранением в базу
        hashed_password = get_password_hash(operator.password)

        # 2. Создаем объект оператора с хэшированным паролем
        db_operator = Operator(
            name=operator.name,
            login=operator.login,
            password=hashed_password,
            window_id=operator.window_id,
            auto_call_mode=normalize_auto_call_mode(operator.auto_call_mode),
        )

        db.add(db_operator)
        db.commit()
        db.refresh(db_operator)

        # 3. Возвращаем созданного оператора, но вместо хэша отдаем точки
        return {
            "id": db_operator.id,
            "name": db_operator.name,
            "login": db_operator.login,
            "window_id": db_operator.window_id,
            "auto_call_mode": db_operator.auto_call_mode,
            "password": "••••••",  # Админ видит это на экране вместо хэша
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        db.close()


@router.get("/operators/", tags=["Operators"])
async def list_operators(
    skip: int = Query(0, ge=0),
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    admin: Admin = Depends(verify_admin_session)
    ):
    db = SessionLocal()
    try:
        # Получаем всех операторов из базы
        operators = db.query(Operator).order_by(Operator.id).offset(skip).limit(limit).all()
        
        # Создаем новый список, где вместо хэшей паролей будут точки
        safe_operators = []
        for op in operators:
            safe_operators.append({
                "id": op.id,
                "name": op.name,
                "login": op.login,
                "window_id": op.window_id,
                "auto_call_mode": op.auto_call_mode or "default",
                "password": "••••••"  # Прячем хэш от фронтенда
            })
            
        return safe_operators
    finally:
        # Блок finally гарантирует, что база закроется даже при ошибке
        db.close()


@router.put("/windows/{window_id}/operator", tags=["Operators"])
async def assign_window_operator(
    window_id: int,
    data: WindowOperatorUpdate,
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        window = db.query(Window).filter(Window.id == window_id).first()
        if not window:
            raise HTTPException(status_code=404, detail="Рабочее место не найдено")

        selected_operator = None
        if data.operator_id is not None:
            selected_operator = (
                db.query(Operator)
                .filter(Operator.id == data.operator_id)
                .first()
            )
            if not selected_operator:
                raise HTTPException(status_code=404, detail="Оператор не найден")
            if selected_operator.window_id not in (None, window_id):
                raise HTTPException(
                    status_code=400,
                    detail="Оператор уже назначен на другое рабочее место",
                )

        current_operators = (
            db.query(Operator)
            .filter(Operator.window_id == window_id)
            .all()
        )
        for operator in current_operators:
            if not selected_operator or operator.id != selected_operator.id:
                operator.window_id = None
                record_operator_status(db, operator.id, None, "offline")

        # Освобождаем уникальную привязку окна до назначения нового оператора.
        db.flush()

        if selected_operator and selected_operator.window_id != window_id:
            selected_operator.window_id = window_id
            record_operator_status(
                db, selected_operator.id, window_id, window.status
            )

        db.commit()
        await manager.broadcast({
            "type": "services_updated",
            "target": "operator",
            "window_id": window_id,
        })
        return {
            "window_id": window_id,
            "operator_id": selected_operator.id if selected_operator else None,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@router.delete("/operators/{operator_id}", tags=["Operators"])
async def delete_operator(operator_id: int, admin: Admin = Depends(verify_admin_session)): # Добавили Depends
    db = SessionLocal()
    op = db.query(Operator).filter(Operator.id == operator_id).first()
    if not op:
        db.close()
        raise HTTPException(status_code=404, detail="Оператор не найден")
    db.delete(op)
    db.commit()
    db.close()
    return {"status": "ok"}


@router.patch("/operators/{operator_id}", tags=["Operators"])
async def update_operator(operator_id: int, data: dict, admin: Admin = Depends(verify_admin_session)):

    db = SessionLocal()

    op = db.query(Operator).filter(Operator.id == operator_id).first()

    if not op:
        db.close()
        raise HTTPException(status_code=404, detail="Operator not found")

    if "name" in data:
        op.name = data["name"]

    if "auto_call_mode" in data:
        op.auto_call_mode = normalize_auto_call_mode(data["auto_call_mode"])

    if "window_id" in data:

        new_window = data["window_id"]
        old_window_id = op.window_id
        new_window_status = "offline"

        if new_window is not None:

            window = db.query(Window).filter(Window.id == new_window).first()
            if not window:
                db.close()
                raise HTTPException(status_code=404, detail="Window not found")

            new_window_status = window.status

            existing = db.query(Operator).filter(
                Operator.window_id == new_window,
                Operator.id != operator_id
            ).first()

            if existing:
                db.close()
                raise HTTPException(
                    status_code=400,
                    detail="Это окно уже занято другим оператором"
                )

        op.window_id = new_window

        if old_window_id != new_window:
            record_operator_status(
                db, op.id, new_window, new_window_status
            )

    db.commit()
    db.refresh(op)

    await manager.broadcast({"type": "services_updated", "target": "operator"})
    await manager.broadcast({"type": "settings_updated"})

    db.close()

    return op


@router.put("/operators/{operator_id}/login", tags=["Operators"])
def update_operator_login(
    operator_id: int = Path(..., gt=0), 
    data: OperatorLoginUpdate = Body(...), 
    admin: Admin = Depends(verify_admin_session)
 ):
    db: Session = SessionLocal()
    try:
        operator = db.query(Operator).filter(Operator.id == operator_id).first()
        if not operator:
            raise HTTPException(status_code=404, detail="Operator not found")

        # Обновляем логин
        operator.login = data.login
        
        # ХЭШИРУЕМ новый пароль перед сохранением
        operator.password = get_password_hash(data.password)
        
        db.commit()
        db.refresh(operator)
        
        # Возвращаем ответ без самого пароля (даже хэшированного)
        return {
            "message": "Login and password updated", 
            "operator_id": operator.id,
            "login": operator.login
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Ошибка при обновлении: {str(e)}")
    finally:
        db.close()


@router.get("/operator/dashboard", tags=["Operators"])
def get_dashboard_data(operator: Operator = Depends(verify_session)):
    return get_operator_state(operator.id)


@router.get(
    "/operator/service-notifications",
    response_model=List[OperatorServiceNotificationRead],
    tags=["Operators"],
)
def list_my_service_notifications(operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        return get_operator_service_notifications(db, operator)
    finally:
        db.close()


@router.patch("/operator/service-notifications/{service_id}", tags=["Operators"])
@router.put("/operator/service-notifications/{service_id}", tags=["Operators"])
def update_my_service_notification(
    service_id: int,
    data: OperatorServiceNotificationUpdate,
    operator: Operator = Depends(verify_session),
):
    db = SessionLocal()
    try:
        if not operator.window_id:
            raise HTTPException(status_code=404, detail="Operator window not found")

        service = (
            db.query(Service)
            .join(WindowService, Service.id == WindowService.service_id)
            .filter(
                Service.id == service_id,
                Service.is_archived == 0,
                WindowService.window_id == operator.window_id,
            )
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Service not found for operator window")

        setting = (
            db.query(OperatorServiceNotification)
            .filter(
                OperatorServiceNotification.operator_id == operator.id,
                OperatorServiceNotification.service_id == service_id,
            )
            .first()
        )
        if not setting:
            setting = OperatorServiceNotification(
                operator_id=operator.id,
                service_id=service_id,
                enabled=1 if data.enabled else 0,
            )
            db.add(setting)
        else:
            setting.enabled = 1 if data.enabled else 0

        db.commit()

        priority = (
            db.query(WindowService.priority)
            .filter(
                WindowService.window_id == operator.window_id,
                WindowService.service_id == service_id,
            )
            .scalar()
        )
        return build_service_notification_payload(
            service.id,
            service.name,
            priority if priority is not None else 1,
            setting.enabled,
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@router.get("/operators/details", tags=["Operators"])
async def get_my_details(operator: Operator = Depends(verify_session)):
    db = SessionLocal()
    try:
        current_operator = (
            db.query(Operator).filter(Operator.id == operator.id).first()
            or operator
        )
        window = None
        if current_operator.window_id:
            window = (
                db.query(Window)
                .filter(Window.id == current_operator.window_id)
                .first()
            )
        settings = get_system_settings_dict(db)
        auto_call_mode = current_operator.auto_call_mode or "default"
        
        services_with_priority = []
        if current_operator.window_id:
            services_with_priority = [
                {
                    "id": item["service_id"],
                    "name": item["service_name"],
                    "priority": item["priority"],
                    "notifications_enabled": item["enabled"],
                }
                for item in get_operator_service_notifications(db, current_operator)
            ]

        return {
            "operator_name": current_operator.name,
            "window_id": current_operator.window_id,
            "window_name": window.name if window else "Не назначено",
            "window_status": window.status if window else "offline",
            "auto_call_mode": auto_call_mode,
            "auto_call_enabled": resolve_operator_auto_call_enabled(
                current_operator,
                settings["auto_call_enabled"],
            ),
            "auto_call_delay_seconds": settings["auto_call_delay_seconds"],
            "auto_call_server_managed": True,
            "next_auto_call_at": (
                current_operator.next_auto_call_at.isoformat()
                if current_operator.next_auto_call_at else None
            ),
            "services": services_with_priority # Теперь это список объектов
        }
    finally:
        db.close()
