from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

from app.config import DATABASE_URL


engine = create_engine(DATABASE_URL)


@event.listens_for(engine, "do_connect")
def use_utc(dialect, connection_record, args, params):
    if dialect.name == "postgresql":
        params["options"] = (params.get("options", "") + " -ctimezone=UTC").strip()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()
