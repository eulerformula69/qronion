from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base, CloseDaySchedule
from app.services.close_day_scheduler import claim_due_schedule, get_or_create_schedule


ROOT = Path(__file__).resolve().parents[2]


def make_db():
    engine = create_engine("sqlite:///:memory:")
    CloseDaySchedule.__table__.create(engine)
    return sessionmaker(bind=engine)()


def test_due_weekly_schedule_runs_only_once_per_day():
    db = make_db()
    schedule = get_or_create_schedule(db)
    schedule.enabled = 1
    schedule.weekdays = "0,2,4"
    schedule.run_time = "18:00"
    db.commit()
    now = datetime(2026, 8, 19, 18, 5, tzinfo=ZoneInfo("Asia/Irkutsk"))

    assert claim_due_schedule(db, now)["ticket_action"] == "cancel"
    assert claim_due_schedule(db, now) is None


def test_schedule_is_not_due_before_time_or_on_another_weekday():
    db = make_db()
    schedule = get_or_create_schedule(db)
    schedule.enabled = 1
    schedule.weekdays = "2"
    schedule.run_time = "18:00"
    db.commit()

    tuesday = datetime(2026, 8, 18, 19, 0, tzinfo=ZoneInfo("Asia/Irkutsk"))
    wednesday_early = datetime(2026, 8, 19, 17, 59, tzinfo=ZoneInfo("Asia/Irkutsk"))
    assert claim_due_schedule(db, tuesday) is None
    assert claim_due_schedule(db, wednesday_early) is None


def test_close_day_includes_serving_tickets_and_admin_has_scheduler_view():
    close_day_source = (ROOT / "app/services/close_day.py").read_text(encoding="utf-8")
    app_source = (ROOT / "web/js/admin/app.js").read_text(encoding="utf-8")
    view_source = (ROOT / "web/js/admin/views/scheduler.view.js").read_text(encoding="utf-8")

    assert '("waiting", "called", "serving")' in close_day_source
    assert 'label: "Планировщик"' in app_source
    assert 'name="weekday"' in view_source
    assert 'renderChoiceGroup("Что сделать с операторами", "operator_action"' in view_source
    assert 'renderChoiceGroup("Что сделать с талонами", "ticket_action"' in view_source
    assert '24-часовой формат · ЧЧ:ММ' in view_source
