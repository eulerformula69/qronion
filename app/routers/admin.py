import asyncio
import hashlib
import json
import os
import re
import secrets
from datetime import datetime, timedelta
from pathlib import Path as FilePath
from typing import List

import bcrypt
from fastapi import (
    APIRouter, Body, Depends, File, Form, Header, HTTPException, Query, UploadFile,
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
from app.models import Admin, Window
from app.schemas import (
    OfficeMap, PlaylistUpdate, PublicSettingsResponse, SystemSettingsResponse,
    SystemSettingsUpdate,
)
from app.security import get_password_hash, verify_password
from app.services.media import (
    build_media_file_path, enqueue_media_processing, get_media_job_index,
    list_media_jobs, normalize_compression_mode, parse_custom_ffmpeg_command,
    retry_media_job, sanitize_media_filename,
    save_upload_direct_to_media, save_upload_to_originals,
)
from app.services.operators import update_services_status_for_window
from app.services.settings import (
    _bool_to_str, build_board_ticker_text, get_or_create_system_settings,
    get_system_settings_dict, normalize_board_ticker_messages,
    serialize_board_ticker_messages, serialize_ticket_reason_options,
)
from app.services.tickets import broadcast_board

router = APIRouter()

MAP_FILE = BASE_DIR / "data" / "map.json"


def _default_map() -> dict:
    return {"version": 1, "width": 1200, "height": 700, "objects": []}


def _validate_map_geometry(data: OfficeMap) -> None:
    if data.width < 400 or data.width > 50000 or data.height < 300 or data.height > 50000:
        raise HTTPException(status_code=400, detail="Некорректный размер карты")
    if len(data.objects) > 1000:
        raise HTTPException(status_code=400, detail="На карте слишком много объектов")

    ids = set()
    for item in data.objects:
        if not item.id or len(item.id) > 100 or item.id in ids:
            raise HTTPException(status_code=400, detail="Некорректный ID объекта карты")
        ids.add(item.id)

        minimum_sizes = {
            "room": (180, 120),
            "workplace": (70, 50),
            "wall": (8, 8),
            "door": (40, 12),
            "label": (60, 24),
            "zone": (100, 80),
        }
        min_width, min_height = minimum_sizes[item.type]
        if item.width < min_width or item.height < min_height:
            raise HTTPException(status_code=400, detail="Объект карты слишком мал")
        if item.x < 0 or item.y < 0:
            raise HTTPException(status_code=400, detail="Объект выходит за границы карты")
        if item.x + item.width > data.width or item.y + item.height > data.height:
            raise HTTPException(status_code=400, detail="Объект выходит за границы карты")
        if len(item.label) > 100:
            raise HTTPException(status_code=400, detail="Слишком длинное название объекта")
        if item.type != "workplace" and item.window_id is not None:
            raise HTTPException(status_code=400, detail="Этот объект нельзя привязать к окну")


@router.get("/admin/map", response_model=OfficeMap, tags=["Admin"])
async def get_office_map(admin: Admin = Depends(verify_admin_session)):
    if not MAP_FILE.exists():
        return _default_map()
    try:
        with MAP_FILE.open("r", encoding="utf-8") as file:
            return json.load(file)
    except (OSError, json.JSONDecodeError):
        raise HTTPException(status_code=500, detail="Не удалось прочитать карту")


@router.put("/admin/map", response_model=OfficeMap, tags=["Admin"])
async def update_office_map(
    data: OfficeMap,
    admin: Admin = Depends(verify_admin_session),
):
    _validate_map_geometry(data)
    MAP_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp_file = MAP_FILE.with_name(
        f".{MAP_FILE.name}.{secrets.token_hex(8)}.tmp"
    )
    payload = data.model_dump() if hasattr(data, "model_dump") else data.dict()
    try:
        with temp_file.open("w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_file, MAP_FILE)
    except OSError:
        if temp_file.exists():
            temp_file.unlink()
        raise HTTPException(status_code=500, detail="Не удалось сохранить карту")
    return payload


@router.post("/admin/media/upload", tags=["Admin"])
async def upload_media(
    file: UploadFile = File(...),
    process_video: bool = Form(True),
    compression_mode: str = Form("normal"),
    custom_ffmpeg_command: str = Form(""),
    admin: Admin = Depends(verify_admin_session)
    ):
    safe_filename = sanitize_media_filename(file.filename)

    file.file.seek(0, os.SEEK_END)
    file_size = file.file.tell()
    file.file.seek(0)
    
    if file_size > MAX_FILE_SIZE:
        max_mb = MAX_FILE_SIZE // (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"Файл слишком большой. Максимум {max_mb}MB.",
        )

    if not process_video:
        output_filename = save_upload_direct_to_media(file.file, safe_filename)
        return {
            "status": "ready",
            "filename": output_filename,
            "job_id": None,
        }

    mode = normalize_compression_mode(compression_mode)
    if mode == "custom":
        parse_custom_ffmpeg_command(custom_ffmpeg_command)

    source_path = save_upload_to_originals(file.file, safe_filename)
    job = await enqueue_media_processing(
        source_path,
        safe_filename,
        mode,
        custom_ffmpeg_command,
    )
    return {
        "status": "processing",
        "filename": job["filename"],
        "job_id": job["id"],
    }


@router.delete("/admin/media/file/{filename}", tags=["Admin"])
async def delete_media_file(filename: str, admin: Admin = Depends(verify_admin_session)):
    safe_filename = sanitize_media_filename(filename)
    file_path = build_media_file_path(safe_filename)
    
    # 1. Remove from physical storage
    if os.path.exists(file_path):
        os.remove(file_path)
    
    # 2. Remove from playlist.json if it exists there
    playlist_path = os.path.abspath("queue/media/playlist.json")
    if os.path.exists(playlist_path):
        with open(playlist_path, "r", encoding="utf-8") as f:
            playlist = json.load(f)
        
        web_path = f"/queue/media/{safe_filename}"
        if web_path in playlist:
            playlist.remove(web_path)
            with open(playlist_path, "w", encoding="utf-8") as f:
                json.dump(playlist, f, ensure_ascii=False, indent=4)
    
    await manager.broadcast({"type": "playlist_updated"})
    return {"status": "deleted"}


@router.post("/admin/media/job/{job_id}/retry", tags=["Admin"])
async def retry_media_processing_job(
    job_id: str,
    admin: Admin = Depends(verify_admin_session),
):
    job = await retry_media_job(job_id)
    return {
        "status": job["status"],
        "filename": job["filename"],
        "job_id": job["id"],
    }


@router.post("/admin/media/playlist", tags=["Admin"])
async def update_playlist(data: PlaylistUpdate, admin: Admin = Depends(verify_admin_session)):
    playlist_path = os.path.abspath("queue/media/playlist.json")
    os.makedirs(os.path.dirname(playlist_path), exist_ok=True)
    
    # Load current playlist
    playlist = []
    if os.path.exists(playlist_path):
        with open(playlist_path, "r", encoding="utf-8") as f:
            try:
                playlist = json.load(f)
                if not isinstance(playlist, list): # Safety check
                    playlist = []
            except:
                playlist = []

    if data.action == "add":
        if not data.path or not data.path.startswith("/queue/media/"):
            raise HTTPException(status_code=400, detail="Некорректный путь в плейлисте")
        playlist_filename = sanitize_media_filename(data.path.rsplit("/", 1)[-1])
        if not os.path.exists(build_media_file_path(playlist_filename)):
            raise HTTPException(status_code=400, detail="Файл еще не готов")
        if data.path not in playlist:
            playlist.append(data.path)
    elif data.action == "delete":
        playlist = [item for item in playlist if item != data.path]

    with open(playlist_path, "w", encoding="utf-8") as f:
        json.dump(playlist, f, ensure_ascii=False, indent=4)
            
    # BROADCAST UPDATE
    await manager.broadcast({"type": "playlist_updated"})
    
    return {"status": "success"}


@router.get("/admin/media/files", tags=["Admin"])
async def list_media_files(admin: Admin = Depends(verify_admin_session)):
    media_dir = os.path.abspath("queue/media")
    if not os.path.exists(media_dir):
        os.makedirs(media_dir)
    
    # List physical files on disk
    physical_files = [
        f for f in os.listdir(media_dir)
        if FilePath(f).suffix.lower() in ALLOWED_MEDIA_EXTENSIONS
    ]
    
    # Get current playlist
    playlist_path = os.path.join(media_dir, "playlist.json")
    playlist = []
    if os.path.exists(playlist_path):
        try:
            with open(playlist_path, "r", encoding="utf-8") as f:
                playlist = json.load(f)
        except:
            playlist = []
            
    jobs_by_filename = await get_media_job_index()
    items = []
    for filename in physical_files:
        job = jobs_by_filename.get(filename, {})
        items.append({
            "job_id": job.get("id"),
            "filename": filename,
            "status": job.get("status", "ready"),
            "compression_mode": job.get("compression_mode"),
            "compression_label": job.get("compression_label"),
            "error": (
                job.get("error")
                or (
                    "Подробность не сохранилась. Нажмите «Повторить», чтобы получить точную причину."
                    if job.get("status") == "error" else ""
                )
            ),
            "size_bytes": os.path.getsize(os.path.join(media_dir, filename)),
        })

    existing_names = set(physical_files)
    for job in await list_media_jobs():
        filename = job.get("filename")
        if not filename or filename in existing_names:
            continue
        if job.get("status") not in {"pending", "processing", "error"}:
            continue
        items.append({
            "job_id": job.get("id"),
            "filename": filename,
            "original_filename": job.get("original_filename"),
            "status": job.get("status", "pending"),
            "compression_mode": job.get("compression_mode"),
            "compression_label": job.get("compression_label"),
            "error": job.get("error") or "Подробность не сохранилась. Нажмите «Повторить», чтобы получить точную причину.",
            "size_bytes": job.get("size_bytes"),
        })

    return {
        "files": physical_files,
        "items": items,
        "playlist": playlist
    }


@router.get("/admin/settings", response_model=SystemSettingsResponse, tags=["Admin"])
async def get_admin_settings(admin: Admin = Depends(verify_admin_session)):
    db = SessionLocal()
    try:
        return get_system_settings_dict(db)
    finally:
        db.close()


@router.put("/admin/settings", response_model=SystemSettingsResponse, tags=["Admin"])
async def update_admin_settings(
    data: SystemSettingsUpdate,
    admin: Admin = Depends(verify_admin_session)
    ):
    if data.default_operator_status not in {"online", "break", "offline"}:
        raise HTTPException(status_code=400, detail="Некорректный default_operator_status")

    if data.active_ticket_on_operator_logout not in {"return_to_queue", "keep_with_operator"}:
        raise HTTPException(status_code=400, detail="Некорректный active_ticket_on_operator_logout")

    if "<number>" not in data.ticket_notice_printed_text or "<number>" not in data.ticket_notice_unprinted_text:
        raise HTTPException(
            status_code=400,
            detail="Текст уведомления должен содержать <number>"
        )
        
    if "<number>" not in data.call_message_template or "<window>" not in data.call_message_template:
        raise HTTPException(
            status_code=400,
            detail="Шаблон сообщения должен содержать <number> и <window>"
        )

    if "<number>" not in data.board_ticket_template or "<window>" not in data.board_ticket_template:
        raise HTTPException(
            status_code=400,
            detail="Шаблон табло должен содержать <number> и <window>"
        )        

    db = SessionLocal()
    try:
        settings = get_or_create_system_settings(db)
        settings.print_ticket = _bool_to_str(data.print_ticket)
        settings.show_print_badge = _bool_to_str(data.show_print_badge)
        settings.ticket_print_scale_percent = data.ticket_print_scale_percent
        settings.ticket_notice_duration_printed_seconds = data.ticket_notice_duration_printed_seconds
        settings.ticket_notice_duration_unprinted_seconds = data.ticket_notice_duration_unprinted_seconds
        settings.ticket_notice_printed_text = data.ticket_notice_printed_text.strip()
        settings.ticket_notice_unprinted_text = data.ticket_notice_unprinted_text.strip()
        settings.default_operator_status = data.default_operator_status
        settings.active_ticket_on_operator_logout = data.active_ticket_on_operator_logout
        settings.hide_services_without_online_operators = _bool_to_str(
            data.hide_services_without_online_operators
        )
        settings.redirect_allow_break = _bool_to_str(data.redirect_allow_break)
        settings.redirect_allow_offline = _bool_to_str(data.redirect_allow_offline)
        settings.max_ticket_redirects = data.max_ticket_redirects
        settings.operator_changelog_confirm_button_text = (
            data.operator_changelog_confirm_button_text.strip()
        )
        settings.call_message_template = data.call_message_template
        settings.board_ticket_template = data.board_ticket_template
        board_ticker_messages = normalize_board_ticker_messages(
            [
                item.model_dump() if hasattr(item, "model_dump") else item.dict()
                for item in data.board_ticker_messages
            ],
            data.board_ticker_text,
        )
        settings.board_ticker_messages = serialize_board_ticker_messages(board_ticker_messages)
        settings.board_ticker_text = build_board_ticker_text(board_ticker_messages)
        settings.cancel_reason_options = serialize_ticket_reason_options(
            [
                item.model_dump() if hasattr(item, "model_dump") else item.dict()
                for item in data.cancel_reason_options
            ]
        )
        settings.defer_reason_options = serialize_ticket_reason_options(
            [
                item.model_dump() if hasattr(item, "model_dump") else item.dict()
                for item in data.defer_reason_options
            ]
        )
        settings.auto_call_enabled = _bool_to_str(data.auto_call_enabled)
        settings.auto_call_delay_seconds = data.auto_call_delay_seconds
        settings.called_ticket_min_wait_seconds = data.called_ticket_min_wait_seconds
        settings.short_service_warning_minutes = data.short_service_warning_minutes
        settings.max_deferred_tickets_per_operator = data.max_deferred_tickets_per_operator
        settings.auto_call_balance_enabled = _bool_to_str(data.auto_call_balance_enabled)
        settings.auto_call_balance_queue_threshold = data.auto_call_balance_queue_threshold
        settings.auto_call_balance_min_free_operators = data.auto_call_balance_min_free_operators
        settings.cancelled_ticket_board_display_seconds = data.cancelled_ticket_board_display_seconds
        settings.cancelled_ticket_board_message_template = data.cancelled_ticket_board_message_template
        db.commit()

        all_window_ids = [row[0] for row in db.query(Window.id).all()]
        for window_id in all_window_ids:
            update_services_status_for_window(db, window_id)

        await manager.broadcast({"type": "services_updated"})
        await manager.broadcast({"type": "settings_updated"})
        await broadcast_board()
        return get_system_settings_dict(db)
    finally:
        db.close()


@router.get("/settings/public", response_model=PublicSettingsResponse, tags=["Settings"])
async def get_public_settings():
    db = SessionLocal()
    try:
        settings = get_system_settings_dict(db)
        return {
            "print_ticket": settings["print_ticket"],
            "show_print_badge": settings["show_print_badge"],
            "ticket_print_scale_percent": settings["ticket_print_scale_percent"],
            "ticket_notice_duration_printed_seconds": settings["ticket_notice_duration_printed_seconds"],
            "ticket_notice_duration_unprinted_seconds": settings["ticket_notice_duration_unprinted_seconds"],
            "ticket_notice_printed_text": settings["ticket_notice_printed_text"],
            "ticket_notice_unprinted_text": settings["ticket_notice_unprinted_text"],
            "redirect_allow_break": settings["redirect_allow_break"],
            "redirect_allow_offline": settings["redirect_allow_offline"],
            "max_ticket_redirects": settings["max_ticket_redirects"],
            "operator_changelog_confirm_button_text": settings[
                "operator_changelog_confirm_button_text"
            ],
            "board_ticket_template": settings["board_ticket_template"],
            "board_ticker_text": settings["board_ticker_text"],
            "auto_call_enabled": settings["auto_call_enabled"],
            "auto_call_delay_seconds": settings["auto_call_delay_seconds"],
            "called_ticket_min_wait_seconds": settings["called_ticket_min_wait_seconds"],
            "short_service_warning_minutes": settings["short_service_warning_minutes"],
            "max_deferred_tickets_per_operator": settings["max_deferred_tickets_per_operator"],
            "auto_call_balance_enabled": settings["auto_call_balance_enabled"],
            "auto_call_balance_queue_threshold": settings["auto_call_balance_queue_threshold"],
            "auto_call_balance_min_free_operators": settings["auto_call_balance_min_free_operators"],
            "cancelled_ticket_board_display_seconds": settings["cancelled_ticket_board_display_seconds"],
            "cancelled_ticket_board_message_template": settings["cancelled_ticket_board_message_template"],
            "cancel_reason_options": [
                item for item in settings["cancel_reason_options"]
                if item["enabled"]
            ],
            "defer_reason_options": [
                item for item in settings["defer_reason_options"]
                if item["enabled"]
            ],
        }
    finally:
        db.close()
