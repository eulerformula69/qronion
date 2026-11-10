"""Manage the schema before application startup."""
import argparse
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text

from app.config import QUEUE_TIME_ZONE


ROOT = Path(__file__).resolve().parent.parent


def migration_config():
    return Config(str(ROOT / "alembic.ini"))


def upgrade_schema(engine):
    config = migration_config()
    with engine.connect() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        connection.execute(text("""
            UPDATE ticket_counter_state
            SET timezone = :zone, current_day = (
                COALESCE((SELECT max(created_at) FROM tickets), CURRENT_TIMESTAMP) AT TIME ZONE :zone
            )::date
            WHERE timezone <> :zone
        """), {"zone": QUEUE_TIME_ZONE.key})
        connection.commit()


def check_schema(engine):
    from app.models import Base

    expected = set(ScriptDirectory.from_config(migration_config()).get_heads())
    with engine.connect() as connection:
        actual = set(MigrationContext.configure(connection).get_current_heads())
        if actual != expected:
            raise RuntimeError(
                "Версия базы не соответствует приложению. "
                "Перед запуском выполните: python -m app.schema upgrade"
            )
        inspector = inspect(connection)
        existing = set(inspector.get_table_names())
        for table in Base.metadata.sorted_tables:
            if table.name not in existing:
                raise RuntimeError(f"В базе отсутствует таблица {table.name}. Восстановите структуру базы.")
            columns = {column["name"] for column in inspector.get_columns(table.name)}
            if not set(table.columns.keys()).issubset(columns):
                raise RuntimeError(f"Структура таблицы {table.name} повреждена. Восстановите структуру базы.")
        numbering = connection.execute(text("""
            SELECT to_regclass('ticket_number_seq') IS NOT NULL AND EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgrelid = 'tickets'::regclass
                  AND tgname = 'ticket_number_before_insert' AND tgenabled <> 'D'
            )
        """)).scalar_one()
        if "ticket_counter_state" not in existing or not numbering:
            raise RuntimeError("Нумерация талонов не настроена. Восстановите структуру базы.")

        zone = connection.execute(text("SELECT timezone FROM ticket_counter_state WHERE id = 1")).scalar_one()
        if zone != QUEUE_TIME_ZONE.key:
            raise RuntimeError("Изменён часовой пояс очереди. Выполните python -m app.schema upgrade.")


def main():
    parser = argparse.ArgumentParser(description="Проверка и обновление структуры БД Qronion")
    parser.add_argument("action", choices=("upgrade", "check"))
    args = parser.parse_args()
    from app.database import engine

    try:
        if args.action == "upgrade":
            upgrade_schema(engine)
        check_schema(engine)
    finally:
        engine.dispose()
    print("Структура базы готова к запуску.")


if __name__ == "__main__":
    main()
