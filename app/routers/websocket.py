import json
from datetime import datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketState

from app.connections import manager
from app.database import SessionLocal
from app.models import AdminSession, UserSession
from app.services.tickets import broadcast_board, get_board_state


router = APIRouter()


async def receive_text_or_none(websocket: WebSocket) -> str | None:
    """Return None when the peer has already disconnected."""
    try:
        return await websocket.receive_text()
    except WebSocketDisconnect:
        return None
    except RuntimeError:
        if websocket.application_state == WebSocketState.DISCONNECTED:
            return None
        raise


@router.websocket("/ws/terminal")
async def websocket_endpoint(websocket: WebSocket):
    """
    Общий WebSocket‑канал для терминалов, операторов и админки.
    Cюда же приходят небольшие heartbeat‑сообщения:
    {"type": "ping", "session_id": "..."} — мы обновляем last_seen в БД.
    """
    db: Session = SessionLocal()
    await manager.connect(websocket)
    try:
        while True:
            raw = await receive_text_or_none(websocket)
            if raw is None:
                break
            try:
                message = json.loads(raw)
            except Exception:
                # Игнорируем некорректный JSON, чтобы не ронять соединение
                continue

            msg_type = message.get("type")

            # WebSocket heartbeat: обновляем last_seen по session_id
            if msg_type == "ping":
                session_id = message.get("session_id")
                if not session_id:
                    continue

                try:
                    # Пытаемся найти сначала операторскую, затем админскую сессию
                    session = db.query(UserSession).filter(
                        UserSession.session_id == session_id
                    ).first()
                    if not session:
                        session = db.query(AdminSession).filter(
                            AdminSession.session_id == session_id
                        ).first()

                    if session:
                        session.last_seen = datetime.now()
                        db.commit()
                        # Сохраняем mapping сокет -> session_id
                        ws_id = id(websocket)
                        manager.ws_id_to_session_id[ws_id] = session_id
                        manager.session_id_to_ws[session_id] = websocket
                    else:
                        # Если сессии нет в БД — уведомляем клиента и закрываем WS
                        await websocket.send_json({
                            "type": "session_expired",
                            "message": "Ваша сессия истекла. Войдите в систему снова.",
                        })
                        await websocket.close()
                        break
                except Exception:
                    db.rollback()
                continue

            # Обрабатываем старые типы служебных сообщений
            if msg_type == "queue_updated":
                await manager.broadcast({"type": "queue_updated"})
            elif msg_type == "services_updated":
                await manager.broadcast({"type": "services_updated"})
            elif msg_type == "close_day_updated":
                await manager.broadcast({"type": "services_updated"})
                await manager.broadcast({"type": "queue_updated"})
                deleted_session_ids = message.get("deleted_session_ids")
                if isinstance(deleted_session_ids, list):
                    await manager.send_to_sessions(
                        [
                            session_id
                            for session_id in deleted_session_ids
                            if isinstance(session_id, str)
                        ],
                        {
                            "type": "session_expired",
                            "silent": True,
                            "message": "\u0420\u0430\u0431\u043e\u0447\u0438\u0439 \u0434\u0435\u043d\u044c \u0437\u0430\u043a\u0440\u044b\u0442. \u0412\u043e\u0439\u0434\u0438\u0442\u0435 \u0432 \u0441\u0438\u0441\u0442\u0435\u043c\u0443 \u0441\u043d\u043e\u0432\u0430.",
                        },
                    )
                await broadcast_board()

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
        db.close()


@router.websocket("/ws/board")
async def websocket_board(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # при подключении сразу отправляем текущее состояние табло
        await websocket.send_json(get_board_state())

        while True:
            if await receive_text_or_none(websocket) is None:
                break

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
