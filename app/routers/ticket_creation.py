import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text

from app.config import QUEUE_TIME_ZONE
from app.queue_time import utc_now
from app.connections import manager
from app.database import SessionLocal
from app.dependencies import get_current_terminal
from app.models import AVAILABLE_WINDOW_STATUSES, Service, Ticket, TicketCreationRequest, Window, WindowService
from app.schemas import TicketCreate
from app.services.settings import get_system_settings_dict
from app.services.tickets import broadcast_board

router = APIRouter()


@router.post("/tickets/", tags=["Tickets"])
async def create_ticket(
    ticket: TicketCreate,
    _auth = Depends(get_current_terminal) 
    ):
    db = SessionLocal()
    try:
        request_key = str(ticket.request_id) if ticket.request_id else None
        request_payload = json.dumps([ticket.service_id, ticket.window_id])
        if request_key:
            # Serialize retries before checking the durable result.
            db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": request_key})
            previous = db.get(TicketCreationRequest, request_key)
            if previous:
                if previous.payload != request_payload:
                    raise HTTPException(status_code=409, detail="Этот запрос уже использован для другого талона")
                return json.loads(previous.response)
        settings = get_system_settings_dict(db)
        
        # 1. Проверяем существование услуги
        service = (
            db.query(Service)
            .filter(Service.id == ticket.service_id, Service.is_archived == 0)
            .first()
        )
        if not service:
            raise HTTPException(status_code=404, detail="Услуга не найдена")

        if not service.visible_on_terminal or service.status != "active":
            raise HTTPException(
                status_code=400,
                detail="Услуга сейчас недоступна на терминале"
            )

        # 2. Валидация доступности окон
        if settings.get("hide_services_without_online_operators"):
            available_statuses = set(AVAILABLE_WINDOW_STATUSES)
            if service.operator_choice_enabled:
                available_statuses = {"online"}
                if service.operator_choice_allow_break:
                    available_statuses.add("break")
                if service.operator_choice_allow_offline:
                    available_statuses.add("offline")
            active_windows = (
                db.query(Window)
                .join(WindowService, Window.id == WindowService.window_id)
                .filter(
                    WindowService.service_id == service.id,
                    Window.status.in_(available_statuses)
                ).first()
            )
            if not active_windows:
                raise HTTPException(
                    status_code=400, 
                    detail="В данный момент услуга не оказывается (нет активных окон)"
                )

        target_window_id = None

        if service.operator_choice_enabled:
            if not ticket.window_id:
                raise HTTPException(status_code=400, detail="Выберите оператора")

            allowed_statuses = ["online"]
            if service.operator_choice_allow_break:
                allowed_statuses.append("break")
            if service.operator_choice_allow_offline:
                allowed_statuses.append("offline")

            selected_window = (
                db.query(Window)
                .join(WindowService, Window.id == WindowService.window_id)
                .filter(
                    Window.id == ticket.window_id,
                    WindowService.service_id == service.id,
                    Window.status.in_(allowed_statuses)
                )
                .first()
            )

            if not selected_window:
                raise HTTPException(status_code=400, detail="Выбранный оператор сейчас недоступен")

            target_window_id = ticket.window_id

        # 3. Создаем тикет
        created_at = utc_now()
        db_ticket = Ticket(
            service_id=service.id,
            status="waiting",
            target_window_id=target_window_id,
            created_at=created_at,
            queue_entered_at=created_at,
        )

        db.add(db_ticket)
        db.flush()
        db_ticket.root_ticket_id = db_ticket.id
        db.flush()
        db.refresh(db_ticket)


        # 4. Считаем людей перед талоном
        waiting_before = db.query(Ticket).filter(
            Ticket.status == "waiting",
            Ticket.id < db_ticket.id
        ).count()

        result = {
            "id": db_ticket.id,
            "number": db_ticket.number,
            "service_name": service.name,
            "waiting_before": waiting_before,
            "date": created_at.astimezone(QUEUE_TIME_ZONE).strftime("%d.%m.%Y %H:%M")
        }
        if request_key:
            db.add(TicketCreationRequest(
                request_id=request_key, payload=request_payload,
                response=json.dumps(result, ensure_ascii=False),
            ))
        db.commit()
        await manager.broadcast({"type": "queue_updated", "service_id": service.id})
        await broadcast_board()
        return result

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


