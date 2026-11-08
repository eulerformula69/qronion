"""Run explicit PostgreSQL migrations in one transaction."""
from alembic import context
from sqlalchemy import create_engine, pool, text

from app.database import Base
from app import models  # Register the models for autogeneration.

config = context.config


def include_object(obj, name, type_, reflected, compare_to):
    # The numbering state is maintained by SQL rather than ORM models.
    return not (type_ == "table" and name == "ticket_counter_state")


def run(connection):
    if connection.dialect.name != "postgresql":
        raise RuntimeError("Schema migrations require PostgreSQL")
    with connection.begin():
        connection.execute(text("SELECT pg_advisory_xact_lock(71620412)"))
        context.configure(
            connection=connection, target_metadata=Base.metadata,
            include_object=include_object, compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    context.configure(
        dialect_name="postgresql", target_metadata=Base.metadata,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()
else:
    connection = config.attributes.get("connection")
    if connection is not None:
        run(connection)
    else:
        from app.config import DATABASE_URL

        engine = create_engine(DATABASE_URL, poolclass=pool.NullPool)
        try:
            with engine.connect() as connection:
                run(connection)
        finally:
            engine.dispose()
