from fastapi import Header, HTTPException

from app.queue_time import utc_now
from app.database import SessionLocal
from app.models import Admin, AdminSession, Operator, UserSession


def verify_session(session_id: str = Header(...)):
    db = SessionLocal()
    try:
        session = db.query(UserSession).filter(UserSession.session_id == session_id).first()
        if not session:
            raise HTTPException(status_code=401, detail="Invalid session")
        # Refresh "online" activity on any authenticated request.
        # This makes cleanup tolerant to cases where WS heartbeats are temporarily missing.
        session.last_seen = utc_now()
        db.commit()
        operator = db.query(Operator).filter(Operator.id == session.operator_id).first()
        if not operator:
            raise HTTPException(status_code=401, detail="Operator not found")
        return operator
    finally:
        db.close()


def verify_admin_session(session_id: str = Header(None)):
    if not session_id:
        raise HTTPException(status_code=401, detail="Отсутствует session-id")
    
    db = SessionLocal()
    # Проверяем сессию в таблице админских сессий
    session = db.query(AdminSession).filter(AdminSession.session_id == session_id).first()
    if not session:
        db.close()
        raise HTTPException(status_code=401, detail="Неверная сессия администратора")
    
    # Обновляем активность
    session.last_seen = utc_now()
    db.commit()

    # Получаем данные администратора
    admin = db.query(Admin).filter(Admin.id == session.admin_id).first()
    db.close()
    
    if not admin:
        raise HTTPException(status_code=403, detail="Администратор не найден")

    # ДОБАВЛЕННАЯ ПРОВЕРКА:
    # Если статус пользователя "terminal", запрещаем доступ к админским функциям
    if admin.status == "terminal":
        raise HTTPException(
            status_code=403, 
            detail="Доступ запрещен: терминалы не могут использовать этот эндпоинт"
        )
        
    return admin


def get_current_terminal(session_id: str = Header(None)):
    if not session_id:
        raise HTTPException(status_code=401, detail="Session ID missing")
    
    db = SessionLocal()
    try:
        # 1. Ищем сессию в таблице пользовательских сессий (для операторов/терминалов)
        session = db.query(UserSession).filter(UserSession.session_id == session_id).first()
        
        # 2. Если не нашли, проверяем таблицу админских сессий
        if not session:
            session = db.query(AdminSession).filter(AdminSession.session_id == session_id).first()

        if not session:
            raise HTTPException(status_code=401, detail="Invalid session")
        
        return session
    finally:
        db.close()


def get_operator_by_session(session_id: str = Header(..., alias="session-id")):
    if not session_id:
        raise HTTPException(status_code=401, detail="Нет session_id")
    
    db = SessionLocal()
    try:
        # ищем сессию
        session_obj = db.query(UserSession).filter(UserSession.session_id == session_id).first()
        if not session_obj:
            raise HTTPException(status_code=401, detail="Неверный токен")

        # достаем оператора
        operator = db.query(Operator).filter(Operator.id == session_obj.operator_id).first()
        if not operator:
            raise HTTPException(status_code=404, detail="Operator not found")

        return operator
    finally:
        db.close()
