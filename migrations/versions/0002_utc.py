"""Convert the existing Irkutsk wall times to PostgreSQL instants."""
from alembic import op


revision = "0002_utc"
down_revision = "0001_initial"
branch_labels = None
depends_on = None

# A star marks columns whose original default used a local wall time.
COLUMNS = {
    "tickets": "created_at* queue_entered_at* deferred_at called_at service_started_at last_recalled_at finished_at",
    "sessions": "created_at last_seen",
    "admin_sessions": "created_at last_seen",
    "operators": "next_auto_call_at",
    "operator_status_periods": "started_at* ended_at",
    "ticket_admin_changes": "changed_at*",
}


def upgrade():
    for table, fields in COLUMNS.items():
        changes = []
        for field in fields.split():
            column = field.rstrip("*")
            changes.append(
                f"ALTER COLUMN {column} TYPE timestamptz "
                f"USING {column} AT TIME ZONE 'Asia/Irkutsk'"
            )
            if field.endswith("*"):
                changes.append(f"ALTER COLUMN {column} SET DEFAULT CURRENT_TIMESTAMP")
        op.execute(f"ALTER TABLE {table} " + ", ".join(changes))

    op.execute("ALTER TABLE ticket_counter_state ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Irkutsk'")
    op.execute("""
        CREATE OR REPLACE FUNCTION ticket_number_trigger() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE
            previous_day date;
            issue_day date;
        BEGIN
            SELECT current_day, (COALESCE(NEW.created_at, CURRENT_TIMESTAMP) AT TIME ZONE timezone)::date
            INTO previous_day, issue_day FROM ticket_counter_state WHERE id = 1 FOR UPDATE;
            IF previous_day < issue_day THEN
                ALTER SEQUENCE ticket_number_seq RESTART WITH 1;
                UPDATE ticket_counter_state SET current_day = issue_day WHERE id = 1;
            END IF;
            IF NEW.number IS NULL THEN
                NEW.number := nextval('ticket_number_seq');
            END IF;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("""
        UPDATE ticket_counter_state SET current_day = (
            COALESCE((SELECT max(created_at) FROM tickets), CURRENT_TIMESTAMP) AT TIME ZONE timezone
        )::date
    """)


def downgrade():
    raise RuntimeError("Р”Р»СЏ РІРѕР·РІСЂР°С‚Р° Рє РїСЂРµР¶РЅРµРјСѓ С„РѕСЂРјР°С‚Сѓ РІСЂРµРјРµРЅРё РІРѕСЃСЃС‚Р°РЅРѕРІРёС‚Рµ СЂРµР·РµСЂРІРЅСѓСЋ РєРѕРїРёСЋ.")
