import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
from datetime import timedelta
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

from app.queue_time import utc_now
from app.config import (
    ALLOWED_MEDIA_EXTENSIONS, BASE_DIR, DEFAULT_PAGE_LIMIT, MAX_FILE_SIZE,
    MAX_PAGE_LIMIT, OPERATOR_SESSION_AUTO_CLEANUP_ENABLED, PIPER_MODEL,
    PIPER_PATH, SESSION_TIMEOUT_SECONDS, TTS_CACHE_DIR, TTS_LENGTH_SCALE,
    TTS_NOISE_SCALE, TTS_NOISE_W_SCALE,
)
from app.connections import manager
from app.database import SessionLocal
from app.dependencies import (
    get_current_terminal, get_operator_by_session, verify_admin_session,
    verify_session,
)
from app.models import (
    Admin, AdminSession, Operator, Ticket, UserSession, Window,
    record_operator_status,
)
from app.schemas import LoginRequest, PingRequest
from app.security import get_password_hash, verify_password
from app.services.operators import update_services_status_for_window
from app.services.settings import get_system_settings_dict
from app.services.ticket_lifecycle import ACTIVE_TICKET_STATUSES
from app.services.tickets import (
    broadcast_board, return_ticket_to_queue,
)

router = APIRouter()


@router.post("/login", tags=["Auth"])
async def login(data: LoginRequest):
    db = SessionLocal()
    try:
        settings = get_system_settings_dict(db)
        now = utc_now()
        timeout_datetime = now - timedelta(seconds=SESSION_TIMEOUT_SECONDS)

        # 1. Админы / терминалы
        admin = db.query(Admin).filter(Admin.login == data.login).first()

        if admin and verify_password(data.password, admin.password):
            user_role = admin.status
            is_expirable = 0 if user_role == "terminal" else 1

            existing_session = (
                db.query(AdminSession)
                .filter(AdminSession.admin_id == admin.id)
                .order_by(AdminSession.last_seen.desc())
                .first()
            )

            if existing_session and existing_session.last_seen and existing_session.last_seen >= timeout_datetime:
                existing_session.last_seen = now
                existing_session.is_expirable = is_expirable

                db.query(AdminSession).filter(
                    AdminSession.admin_id == admin.id,
                    AdminSession.session_id != existing_session.session_id
                ).delete()

                db.commit()

                return {
                    "session_id": existing_session.session_id,
                    "status": admin.status,
                    "role": user_role
                }

            db.query(AdminSession).filter(AdminSession.admin_id == admin.id).delete()
            db.flush()

            token = secrets.token_hex(32)

            new_session = AdminSession(
                session_id=token,
                admin_id=admin.id,
                last_seen=now,
                is_expirable=is_expirable
            )

            db.add(new_session)
            db.commit()

            return {
                "session_id": token,
                "status": admin.status,
                "role": user_role
            }

        # 2. Операторы
        operator = db.query(Operator).filter(Operator.login == data.login).first()

        if operator and verify_password(data.password, operator.password):
            is_expirable = 1

            existing_session = (
                db.query(UserSession)
                .filter(UserSession.operator_id == operator.id)
                .order_by(UserSession.last_seen.desc())
                .first()
            )

            if (
                existing_session
                and existing_session.last_seen
                and (
                    existing_session.last_seen >= timeout_datetime
                    or not OPERATOR_SESSION_AUTO_CLEANUP_ENABLED
                )
            ):
                token = existing_session.session_id

                existing_session.last_seen = now
                existing_session.is_expirable = is_expirable

                db.query(UserSession).filter(
                    UserSession.operator_id == operator.id,
                    UserSession.session_id != token
                ).delete()

            else:
                db.query(UserSession).filter(UserSession.operator_id == operator.id).delete()
                db.flush()

                token = secrets.token_hex(32)

                new_session = UserSession(
                    session_id=token,
                    operator_id=operator.id,
                    last_seen=now,
                    is_expirable=is_expirable
                )

                db.add(new_session)

            if operator.window_id:
                window = db.query(Window).filter(Window.id == operator.window_id).first()

                if window:
                    window.status = settings["default_operator_status"]
                    record_operator_status(
                        db, operator.id, window.id, window.status
                    )
                    db.flush()

                    update_services_status_for_window(db, window.id)

            db.commit()

            if operator.window_id:
                await manager.broadcast({
                    "type": "services_updated",
                    "target": "operator",
                    "window_id": operator.window_id
                })
                await manager.broadcast({
                    "type": "queue_updated"
                })

            return {
                "session_id": token,
                "name": operator.name,
                "window_id": operator.window_id,
                "role": "operator"
            }

        raise HTTPException(status_code=401, detail="Неверный логин или пароль")

    except Exception as e:
        db.rollback()
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/logout", tags=["Auth"])
async def logout(session_id: str = Header(...)):
    db: Session = SessionLocal()
    try:
        settings = get_system_settings_dict(db)
        # --- ЛОГИКА ДЛЯ ОПЕРАТОРОВ ---
        current_session = db.query(UserSession).filter(UserSession.session_id == session_id).first()
        
        if current_session:
            operator_id = current_session.operator_id
            operator = db.query(Operator).filter(Operator.id == operator_id).first()
            
            if operator and operator.window_id:
                window = db.query(Window).filter(Window.id == operator.window_id).first()

                if window:
                    window.status = "offline"
                    record_operator_status(db, operator.id, window.id, window.status)
                    db.flush()

                if settings["active_ticket_on_operator_logout"] == "return_to_queue":
                    active_ticket = db.query(Ticket).filter(
                        Ticket.window_id == operator.window_id,
                        Ticket.status.in_(ACTIVE_TICKET_STATUSES)
                    ).first()

                    if active_ticket:
                        return_ticket_to_queue(active_ticket)

                db.query(UserSession).filter(UserSession.operator_id == operator_id).delete()

                db.commit()

                if operator.window_id:
                    update_services_status_for_window(db, operator.window_id)

                asyncio.create_task(broadcast_board())
                await manager.broadcast({"type": "queue_updated"})
                await manager.broadcast({"type": "services_updated", "target": "operator"})

           
            return {"status": "success", "role": "operator"}

        # --- ЛОГИКА ДЛЯ АДМИНИСТРАТОРОВ ---
        admin_session = db.query(AdminSession).filter(AdminSession.session_id == session_id).first()
        
        if admin_session:
            # Предположим, в таблице AdminSession есть поле admin_id
            current_admin_id = admin_session.admin_id 
            db.query(AdminSession).filter(AdminSession.admin_id == current_admin_id).delete()
            db.commit()
            return {"status": "success", "role": "admin"}
            
        return {"status": "session_not_found"}

    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/auth/me", tags=["Auth"])
def get_me(operator: Operator = Depends(verify_session)):
    return {
        "operator_id": operator.id,
        "name": operator.name,
        "window_id": operator.window_id
    }


@router.get("/auth/admin", tags=["Auth"])
def admin_get_operators(admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    operators = db.query(Operator).order_by(Operator.id).all()
    db.close()
    return operators


@router.post("/ping", tags=["Auth"])
async def ping(data: PingRequest):
    db = SessionLocal()
    try:
        # Пытаемся найти сессию оператора
        session = db.query(UserSession).filter(UserSession.session_id == data.session_id).first()
        
        # Если не нашли в операторах, ищем в админах (для универсальности пинга)
        if not session:
            session = db.query(AdminSession).filter(AdminSession.session_id == data.session_id).first()

        if session:
            session.last_seen = utc_now()
            db.commit()
            return {"status": "ok"}
        else:
            # Если сессии нет в базе — она была удалена клинером
            raise HTTPException(status_code=401, detail="Session expired")
    finally:
        db.close()
