"""Create Qronion in an empty PostgreSQL database."""
from pathlib import Path

from alembic import context, op
from sqlalchemy import inspect

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    if not context.is_offline_mode():
        existing = set(inspect(op.get_bind()).get_table_names()) - {"alembic_version"}
        if existing:
            raise RuntimeError(
                "База уже содержит таблицы без версии Alembic. "
                "Для этой установки нужна пустая база. Автоматический перенос старой базы не поддерживается."
            )
    sql_dir = Path(__file__).resolve().parents[1] / "sql"
    for filename in ("0001_schema.sql", "0001_numbering.sql"):
        op.execute(sql_dir.joinpath(filename).read_text(encoding="utf-8"))


def downgrade():
    raise RuntimeError(
        "Начальная схема содержит данные очереди. Автоматическое удаление отключено. "
        "Для переустановки создайте отдельную пустую базу."
    )
