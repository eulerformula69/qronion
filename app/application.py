import asyncio
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import BASE_DIR, CORS_ORIGINS
from app.database import engine
from app.schema import check_schema
from app.routers import admin, admin_tickets, auth, documentation, operators, scheduler, services, system, tickets, tts, websocket, windows
from app.services.media import start_media_processor
from app.services.auto_dispatch import auto_dispatch_worker
from app.services.operators import cleanup_sessions
from app.services.close_day_scheduler import close_day_scheduler_worker
from app.release_middleware import release_cache_middleware

TESTING = os.getenv("TESTING", "").lower() in {"1", "true", "yes", "on"}

app = FastAPI()
app.middleware("http")(release_cache_middleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
for router in (
    websocket.router, services.router, tickets.router, operators.router,
    windows.router, auth.router, admin.router, admin_tickets.router, scheduler.router, documentation.router, tts.router, system.router,
):
    app.include_router(router)


@app.get("/", include_in_schema=False)
async def site_home():
    return RedirectResponse("/login.html")


# Installed playlists and speech settings use these directories.
for directory in ("media", "tts"):
    app.mount(f"/queue/{directory}", StaticFiles(
        directory=BASE_DIR / "queue" / directory, check_dir=False
    ), name=directory)


@app.get("/queue/{page}.html", include_in_schema=False)
async def legacy_web_link(page: str, request: Request):
    if page not in {"login", "operator", "admin", "terminal", "board"}:
        raise HTTPException(status_code=404)
    target = f"/{page}.html"
    if request.url.query:
        target += "?" + request.url.query
    return RedirectResponse(target, status_code=308)


web_files = StaticFiles(directory=BASE_DIR / "web")
app.mount("/queue", web_files, name="legacy_web")
app.mount("/", web_files, name="web")


@app.on_event("startup")
async def startup():
    check_schema(engine)
    if not TESTING:
        await start_media_processor()
        asyncio.create_task(cleanup_sessions())
        asyncio.create_task(auto_dispatch_worker())
        asyncio.create_task(close_day_scheduler_worker())
