from fastapi import HTTPException
from app.models import Operator, Service, Window, WindowService, record_operator_status
from app.services.operators import update_services_status_for_window


def apply_window_update(db, window_id, data):
    window = db.query(Window).filter(Window.id == window_id).with_for_update().first()
    if not window:
        raise HTTPException(status_code=404, detail="Рабочее место не найдено")
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Введите название рабочего места")
    old_ids = {row[0] for row in db.query(WindowService.service_id).filter(WindowService.window_id == window_id).all()}
    new_ids = old_ids
    if data.services is not None:
        new_ids = {item.service_id for item in data.services}
        if len(new_ids) != len(data.services) or any(not 1 <= item.priority <= 100 for item in data.services):
            raise HTTPException(status_code=400, detail="Проверьте услуги и приоритеты от 1 до 100")
        count = db.query(Service).filter(Service.id.in_(new_ids), Service.is_archived == 0).count()
        if count != len(new_ids):
            raise HTTPException(status_code=400, detail="Одна или несколько услуг не найдены")
    previous_status = window.status
    window.name = name
    if data.status is not None:
        window.status = data.status
    if data.services is not None:
        db.query(WindowService).filter(WindowService.window_id == window_id).delete()
        for item in data.services:
            db.add(WindowService(window_id=window_id, service_id=item.service_id, priority=item.priority))
    if window.status != previous_status:
        operator = db.query(Operator).filter(Operator.window_id == window_id).first()
        if operator:
            record_operator_status(db, operator.id, window.id, window.status)
    if data.services is not None or window.status != previous_status:
        db.flush()
        update_services_status_for_window(db, window_id, commit=False, service_ids=list(old_ids | new_ids))
    return window
