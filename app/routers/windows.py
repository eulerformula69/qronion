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
from app.models import Admin, Operator, Service, Window, WindowService, record_operator_status
from app.schemas import (
    PriorityUpdate, WindowCreate, WindowServiceCreate, WindowServiceRead,
    WindowServicesUpdate, WindowStatusUpdate, WindowStatusUpdateOp,
)
from app.security import get_password_hash, verify_password
from app.services.operators import update_services_status_for_window

router = APIRouter()


@router.post("/windows/", tags=["Windows"])
def create_window(window: WindowCreate, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    # Проверяем, нет ли уже окна с таким именем
    existing = db.query(Window).filter(Window.name == window.name).first()
    if existing:
        raise HTTPException(status_code=400, detail="Window already exists")
    
    db_window = Window(name=window.name, status="offline")
    db.add(db_window)
    db.commit()
    db.refresh(db_window)
    return db_window


@router.get("/windows/", tags=["Windows"])
async def list_windows(
    skip: int = Query(0, ge=0),
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    admin: Admin = Depends(verify_admin_session)
    ):
    db = SessionLocal()
    windows = db.query(Window).order_by(Window.id).offset(skip).limit(limit).all()
    db.close()
    return windows


@router.patch("/windows/{window_id}/status", tags=["Windows"])
async def update_window_status(
    window_id: int,
    data: WindowStatusUpdate = Body(...),
    admin: Admin = Depends(verify_admin_session)
    ):
    db = SessionLocal()
    try:
        window = db.query(Window).filter(Window.id == window_id).first()
        if not window:
            raise HTTPException(status_code=404, detail="Window not found")

        # Проверка допустимых статусов
        if data.status not in ["online", "offline", "break"]:
            raise HTTPException(status_code=400, detail="Invalid status")

        window.status = data.status
        assigned_operator = (
            db.query(Operator).filter(Operator.window_id == window_id).first()
        )
        if assigned_operator:
            record_operator_status(
                db, assigned_operator.id, window.id, window.status
            )
        db.commit()

        # Пересчитать статусы связанных услуг
        update_services_status_for_window(db, window_id)

        # Бродкаст через WebSocket
        await manager.broadcast({
            "type": "services_updated",
            "target": "operator",
            "window_id": window_id,
        })

        db.refresh(window)
        return {"id": window.id, "status": window.status}
    finally:
        db.close()


@router.post("/window-services/", tags=["Windows"])
async def create_window_service(data: WindowServiceCreate, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()

    service = (
        db.query(Service)
        .filter(Service.id == data.service_id, Service.is_archived == 0)
        .first()
    )
    if not service:
        db.close()
        raise HTTPException(status_code=404, detail="Услуга не найдена")

    existing = db.query(WindowService).filter_by(
        window_id=data.window_id,
        service_id=data.service_id
    ).first()

    if existing:
        db.close()
        return existing

    ws = WindowService(
        window_id=data.window_id,
        service_id=data.service_id
    )
    
    await manager.broadcast({"type": "services_updated", "target": "operator"})
    db.add(ws)
    db.commit()
    db.refresh(ws)
    db.close()

    return ws


@router.get("/window-services/", response_model=List[WindowServiceRead], tags=["Windows"])
def list_window_services(
    skip: int = Query(0, ge=0),
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    admin: Admin = Depends(verify_admin_session)
    ):
    db = SessionLocal()
    result = (
        db.query(WindowService)
        .join(Service, Service.id == WindowService.service_id)
        .filter(Service.is_archived == 0)
        .order_by(WindowService.window_id, WindowService.service_id)
        .offset(skip)
        .limit(limit)
        .all()
    )
    db.close()
    return result


@router.get("/window-services/{window_id}", tags=["Windows"])
def get_window_services(window_id: int, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()

    services = (
        db.query(WindowService)
        .join(Service, Service.id == WindowService.service_id)
        .filter(WindowService.window_id == window_id)
        .filter(Service.is_archived == 0)
        .all()
    )

    db.close()
    return services


@router.put("/window-services/{window_id}", tags=["Windows"])
async def update_window_services(
    window_id: int, 
    data: WindowServicesUpdate, # Он ждет {"services": [...]}
    admin: Admin = Depends(verify_admin_session)
    ):
    db = SessionLocal()
    try:
        service_ids = [item.service_id for item in data.services]
        if service_ids:
            active_service_count = (
                db.query(Service)
                .filter(Service.id.in_(service_ids), Service.is_archived == 0)
                .count()
            )
            if active_service_count != len(set(service_ids)):
                raise HTTPException(status_code=404, detail="Одна или несколько услуг не найдены")

        # Удаляем старое
        db.query(WindowService).filter(WindowService.window_id == window_id).delete()
        
        # Добавляем новое
        for item in data.services:
            new_ws = WindowService(
                window_id=window_id,
                service_id=item.service_id,
                priority=item.priority
            )
            db.add(new_ws)
        
        db.commit()
        await manager.broadcast({"type": "services_updated", "target": "operator"})
        return {"status": "ok"}
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/window-services/{window_id}/{service_id}", tags=["Windows"])
async def delete_window_service(window_id: int, service_id: int, admin: Admin = Depends(verify_admin_session)):

    db = SessionLocal()

    ws = (
        db.query(WindowService)
        .filter(
            WindowService.window_id == window_id,
            WindowService.service_id == service_id
        )
        .first()
    )

    if ws:
        db.delete(ws)
        db.commit()
                
    await manager.broadcast({"type": "services_updated", "target": "operator"})
    db.close()

    return {"status":"ok"}


@router.post("/windows/update-status", tags=["Windows"])
async def update_window_status(
    data: WindowStatusUpdateOp,
    operator: Operator = Depends(get_operator_by_session)
    ):
    # проверяем, что оператор меняет своё окно
    if operator.window_id != data.window_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Вы не можете менять статус чужого окна"
        )

    db = SessionLocal()
    try:
        window = db.query(Window).filter(Window.id == data.window_id).first()
        if not window:
            raise HTTPException(status_code=404, detail="Window not found")

        new_status = data.status.lower()
        if new_status not in {"online", "offline", "break"}:
            raise HTTPException(status_code=400, detail="Invalid status")

        window.status = new_status
        record_operator_status(db, operator.id, window.id, window.status)
        db.flush()

        db.commit()

        # пересчитываем статусы связанных услуг
        update_services_status_for_window(db, window.id)

        # уведомление фронта
        await manager.broadcast({"type": "services_updated", "target": "operator"})

        db.refresh(window)
        return window
    finally:
        db.close()


@router.delete("/windows/{window_id}", tags=["Windows"])
def delete_window(window_id: int, admin: Admin = Depends(verify_admin_session)): # Защищаем эндпоинт
    db = SessionLocal()

    window = db.query(Window).filter(Window.id == window_id).first()
    if not window:
        db.close()
        raise HTTPException(status_code=404, detail="Window not found")

    db.delete(window)
    db.commit()
    db.close()

    return {"message": "Window deleted"}


@router.patch("/windows/{window_id}", tags=["Windows"])
async def rename_window(window_id: int, data: WindowCreate, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    window = db.query(Window).filter(Window.id == window_id).first()
    if not window:
        db.close()
        raise HTTPException(status_code=404, detail="Window not found")
    window.name = data.name
    db.commit()
    db.refresh(window)
    await manager.broadcast({"type": "services_updated", "target": "operator"})
    db.close()
    return window


@router.patch("/window-services/priority", tags=["Windows"])
async def update_priority(data: PriorityUpdate, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    ws = db.query(WindowService).filter(
        WindowService.window_id == data.window_id, 
        WindowService.service_id == data.service_id
    ).first()
    if ws:
        ws.priority = data.priority
        db.commit()
    await manager.broadcast({"type": "services_updated", "target": "operator"})
    db.close()
    return {"status": "updated"}
