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
from sqlalchemy import and_, asc, func, literal, or_, text
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
    AVAILABLE_WINDOW_STATUSES, Admin, Operator, Service, ServiceGroup, Ticket,
    Window, WindowService,
)
from app.schemas import (
    ServiceCreate,
    ServiceGroupAssignUpdate,
    ServiceGroupCreate,
    ServiceGroupOrderUpdate,
    ServiceGroupUpdate,
    ServiceOperatorChoiceUpdate,
    ServiceOrderUpdate,
    ServiceRename,
    ServiceStatusUpdate,
    ServiceTerminalVisibilityUpdate,
)
from app.security import get_password_hash, verify_password
from app.services.settings import get_system_settings_dict
from app.services.operators import update_services_status_for_window

router = APIRouter()


def _visible_services_query(db: Session, include_hidden: bool):
    query = db.query(Service).filter(Service.is_archived == 0)

    if not include_hidden:
        settings = get_system_settings_dict(db)
        query = query.filter(Service.visible_on_terminal == 1)
        if settings["hide_services_without_online_operators"]:
            query = query.filter(
                Service.status == "active",
                db.query(WindowService.service_id)
                .join(Window, WindowService.window_id == Window.id)
                .filter(
                    WindowService.service_id == Service.id,
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
                .exists()
            )

    return query


def _service_payload(service: Service):
    return {
        "id": service.id,
        "name": service.name,
        "display_order": service.display_order,
        "service_group_id": service.service_group_id,
        "status": service.status,
        "is_archived": service.is_archived,
        "last_window_id": service.last_window_id,
        "operator_choice_enabled": service.operator_choice_enabled,
        "operator_choice_allow_break": getattr(service, "operator_choice_allow_break", 1),
        "operator_choice_allow_offline": getattr(service, "operator_choice_allow_offline", 0),
        "visible_on_terminal": service.visible_on_terminal,
    }


def build_terminal_service_groups(groups, services):
    grouped_services = {group.id: [] for group in groups}
    ungrouped_services = []

    for service in services:
        if service.service_group_id in grouped_services:
            grouped_services[service.service_group_id].append(_service_payload(service))
        else:
            ungrouped_services.append(_service_payload(service))

    return {
        "groups": [
            {
                "id": group.id,
                "name": group.name,
                "display_order": group.display_order,
                "services": grouped_services[group.id],
            }
            for group in groups
            if grouped_services[group.id]
        ],
        "ungrouped_services": ungrouped_services,
    }


@router.post("/services/", tags=["Services"])
async def create_service(service: ServiceCreate, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    try:
        if service.service_group_id is not None:
            group_exists = db.query(ServiceGroup.id).filter(ServiceGroup.id == service.service_group_id).first()
            if not group_exists:
                raise HTTPException(status_code=400, detail="Service group not found")

        next_order = db.query(func.coalesce(func.max(Service.display_order), -1)).scalar() + 1
        db_service = Service(
            name=service.name.strip(),
            display_order=next_order,
            service_group_id=service.service_group_id,
            operator_choice_enabled=1 if service.operator_choice_enabled else 0,
            operator_choice_allow_break=1 if service.operator_choice_allow_break else 0,
            operator_choice_allow_offline=1 if service.operator_choice_allow_offline else 0,
            visible_on_terminal=1 if service.visible_on_terminal else 0

        )
        db.add(db_service)
        db.commit()
        db.refresh(db_service)

        await manager.broadcast({"type": "services_updated"})
        return db_service
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        print(f"Failed to create service: {exc!r}")
        raise HTTPException(
            status_code=500,
            detail="Не удалось создать услугу из-за ошибки базы данных"
        ) from exc
    finally:
        db.close()


@router.get("/services/", tags=["Services"])
def list_services(
    skip: int = Query(0, ge=0),
    limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    include_hidden: bool = Query(False),
):
    db = SessionLocal()
    try:
        return (
            _visible_services_query(db, include_hidden)
            .order_by(Service.display_order, Service.id)
            .offset(skip)
            .limit(limit)
            .all()
        )
    finally:
        db.close()


@router.get("/services/terminal-groups", tags=["Services"])
def list_terminal_service_groups():
    db = SessionLocal()
    try:
        groups = (
            db.query(ServiceGroup)
            .order_by(ServiceGroup.display_order, ServiceGroup.id)
            .all()
        )
        services = (
            _visible_services_query(db, include_hidden=False)
            .order_by(Service.display_order, Service.id)
            .all()
        )
        return build_terminal_service_groups(groups, services)
    finally:
        db.close()


@router.get("/service-groups/", tags=["Services"])
def list_service_groups(admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    try:
        return (
            db.query(ServiceGroup)
            .order_by(ServiceGroup.display_order, ServiceGroup.id)
            .all()
        )
    finally:
        db.close()


@router.post("/service-groups/", tags=["Services"])
async def create_service_group(
    data: ServiceGroupCreate,
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Service group name is required")

        next_order = db.query(func.coalesce(func.max(ServiceGroup.display_order), -1)).scalar() + 1
        group = ServiceGroup(name=name, display_order=next_order)
        db.add(group)
        db.commit()
        db.refresh(group)
        await manager.broadcast({"type": "services_updated"})
        return group
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@router.put("/service-groups/order", tags=["Services"])
async def update_service_groups_order(
    data: ServiceGroupOrderUpdate,
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        groups = db.query(ServiceGroup).with_for_update().all()
        existing_ids = {group.id for group in groups}

        if len(data.group_ids) != len(set(data.group_ids)):
            raise HTTPException(status_code=400, detail="Service group IDs must be unique")
        if set(data.group_ids) != existing_ids:
            raise HTTPException(status_code=400, detail="The order must include all service groups")

        order_by_id = {
            group_id: position
            for position, group_id in enumerate(data.group_ids)
        }
        for group in groups:
            group.display_order = order_by_id[group.id]

        db.commit()
        await manager.broadcast({"type": "services_updated"})
        return {"group_ids": data.group_ids}
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@router.patch("/service-groups/{group_id}", tags=["Services"])
async def update_service_group(
    group_id: int = Path(..., gt=0),
    data: ServiceGroupUpdate = ...,
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        group = db.query(ServiceGroup).filter(ServiceGroup.id == group_id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Service group not found")

        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Service group name is required")

        group.name = name
        db.commit()
        db.refresh(group)
        await manager.broadcast({"type": "services_updated"})
        return group
    finally:
        db.close()


@router.delete("/service-groups/{group_id}", tags=["Services"])
async def delete_service_group(
    group_id: int = Path(..., gt=0),
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        group = db.query(ServiceGroup).filter(ServiceGroup.id == group_id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Service group not found")

        db.query(Service).filter(Service.service_group_id == group_id).update(
            {Service.service_group_id: None},
            synchronize_session=False,
        )
        db.delete(group)
        db.commit()
        await manager.broadcast({"type": "services_updated"})
        return {"message": "Service group deleted"}
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@router.patch("/services/{service_id}/terminal-visibility", tags=["Services"])
async def update_service_terminal_visibility(
    service_id: int = Path(..., gt=0),
    data: ServiceTerminalVisibilityUpdate = ...,
    admin: Admin = Depends(verify_admin_session)
):
    db = SessionLocal()
    try:
        service = (
            db.query(Service)
            .filter(Service.id == service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Service not found")

        service.visible_on_terminal = 1 if data.visible_on_terminal else 0
        db.commit()
        db.refresh(service)

        await manager.broadcast({"type": "services_updated"})

        return {
            "id": service.id,
            "visible_on_terminal": service.visible_on_terminal
        }
    finally:
        db.close()


@router.patch("/services/{service_id}/group", tags=["Services"])
async def update_service_group_assignment(
    service_id: int = Path(..., gt=0),
    data: ServiceGroupAssignUpdate = ...,
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        service = (
            db.query(Service)
            .filter(Service.id == service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Service not found")

        if data.service_group_id is not None:
            group_exists = db.query(ServiceGroup.id).filter(ServiceGroup.id == data.service_group_id).first()
            if not group_exists:
                raise HTTPException(status_code=400, detail="Service group not found")

        service.service_group_id = data.service_group_id
        db.commit()
        db.refresh(service)
        await manager.broadcast({"type": "services_updated"})
        return _service_payload(service)
    finally:
        db.close()


@router.put("/services/order", tags=["Services"])
async def update_services_order(
    data: ServiceOrderUpdate,
    admin: Admin = Depends(verify_admin_session),
):
    db = SessionLocal()
    try:
        services = (
            db.query(Service)
            .filter(Service.is_archived == 0)
            .with_for_update()
            .all()
        )
        existing_ids = {service.id for service in services}

        if len(data.service_ids) != len(set(data.service_ids)):
            raise HTTPException(status_code=400, detail="Service IDs must be unique")
        if set(data.service_ids) != existing_ids:
            raise HTTPException(status_code=400, detail="The order must include all services")

        order_by_id = {
            service_id: position
            for position, service_id in enumerate(data.service_ids)
        }
        for service in services:
            service.display_order = order_by_id[service.id]

        db.commit()
        await manager.broadcast({"type": "services_updated"})
        return {"service_ids": data.service_ids}
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@router.patch("/services/{service_id}", tags=["Services"])
async def rename_service(service_id: int, data: ServiceRename, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    try:
        service = db.query(Service).filter(
            Service.id == service_id, Service.is_archived == 0
        ).with_for_update().first()
        if not service:
            raise HTTPException(status_code=404, detail="Услуга не найдена")
        changes = data.model_dump(exclude_unset=True)
        changes["name"] = data.name.strip()
        if not changes["name"]:
            raise HTTPException(status_code=400, detail="Введите название услуги")
        group_id = changes.get("service_group_id")
        if group_id is not None and not db.query(ServiceGroup.id).filter(ServiceGroup.id == group_id).first():
            raise HTTPException(status_code=400, detail="Группа не найдена")
        for key, value in changes.items():
            if value is None and key != "service_group_id":
                raise HTTPException(status_code=400, detail="Значение настройки не задано")
            setattr(service, key, int(value) if isinstance(value, bool) else value)
        db.commit()
        db.refresh(service)
        result = _service_payload(service)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    await manager.broadcast({"type": "services_updated"})
    return result


@router.patch("/services/{service_id}/status", tags=["Services"])
async def update_service_status(
    service_id: int = Path(..., gt=0),
    data: ServiceStatusUpdate = ...,
    admin: Admin = Depends(verify_admin_session)
    ):
    db = SessionLocal()
    try:
        service = (
            db.query(Service)
            .filter(Service.id == service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Service not found")

        if data.status not in ["active", "inactive"]:
            raise HTTPException(status_code=400, detail="Invalid status")

        service.status = data.status
        db.commit()
        db.refresh(service)
        await manager.broadcast({"type": "services_updated"})

        return {"id": service.id, "status": service.status}
    finally:
        db.close()


@router.patch("/services/{service_id}/operator-choice", tags=["Services"])
async def update_service_operator_choice(
    service_id: int = Path(..., gt=0),
    data: ServiceOperatorChoiceUpdate = ...,
    admin: Admin = Depends(verify_admin_session)
    ):
    db = SessionLocal()
    try:
        service = (
            db.query(Service)
            .filter(Service.id == service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Service not found")

        service.operator_choice_enabled = 1 if data.operator_choice_enabled else 0
        service.operator_choice_allow_break = 1 if data.operator_choice_allow_break else 0
        service.operator_choice_allow_offline = 1 if data.operator_choice_allow_offline else 0
        window_ids = [
            row[0]
            for row in db.query(WindowService.window_id)
            .filter(WindowService.service_id == service.id)
            .all()
        ]
        for window_id in window_ids:
            update_services_status_for_window(db, window_id)
        db.commit()
        db.refresh(service)
        await manager.broadcast({"type": "services_updated"})

        return {
            "id": service.id,
            "operator_choice_enabled": service.operator_choice_enabled,
            "operator_choice_allow_break": service.operator_choice_allow_break,
            "operator_choice_allow_offline": service.operator_choice_allow_offline,
        }
    finally:
        db.close()


@router.get("/services/{service_id}/operators", tags=["Services"])
def list_service_operators(
    service_id: int = Path(..., gt=0),
    _auth = Depends(get_current_terminal)
    ):
    db = SessionLocal()
    try:
        service = (
            db.query(Service)
            .filter(Service.id == service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Услуга не найдена")

        allowed_statuses = ["online"]
        if service.operator_choice_allow_break:
            allowed_statuses.append("break")
        if service.operator_choice_allow_offline:
            allowed_statuses.append("offline")

        rows = (
            db.query(Operator, Window)
            .join(Window, Operator.window_id == Window.id)
            .join(WindowService, Window.id == WindowService.window_id)
            .filter(
                WindowService.service_id == service_id,
                Window.status.in_(allowed_statuses)
            )
            .order_by(Operator.name.asc())
            .all()
        )

        return [
            {
                "operator_id": operator.id,
                "operator_name": operator.name,
                "window_id": window.id,
                "window_name": window.name,
                "status": window.status,
            }
            for operator, window in rows
        ]
    finally:
        db.close()


@router.delete("/services/{service_id}", tags=["Services"])
async def delete_service(service_id: int, admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    try:
        service = (
            db.query(Service)
            .filter(Service.id == service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Услуга не найдена")

        ticket_count = db.query(Ticket).filter(Ticket.service_id == service_id).count()
        db.query(WindowService).filter(WindowService.service_id == service_id).delete(
            synchronize_session=False
        )

        if ticket_count:
            service.status = "inactive"
            service.is_archived = 1
            service.operator_choice_enabled = 0
            message = "Услуга архивирована, потому что по ней уже есть билеты"
            action = "archived"
        else:
            db.delete(service)
            message = "Услуга удалена"
            action = "deleted"

        db.commit()
        await manager.broadcast({"type": "services_updated"})
        return {"message": message, "action": action}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        print(f"Failed to delete service {service_id}: {exc!r}")
        raise HTTPException(
            status_code=500,
            detail="Не удалось удалить услугу из-за ошибки базы данных"
        ) from exc
    finally:
        db.close()
