# Тестирование SUO (Queue)

Документация по автотестам в репозитории: что есть сейчас, как запускать и что можно добавить позже.

## Что сделано

Добавлена **минимальная тестовая инфраструктура** — только **unit-тесты** без базы данных, Docker и браузера.

| Компонент | Назначение |
|-----------|------------|
| [`requirements-dev.txt`](../requirements-dev.txt) | Dev-зависимости: pytest, pytest-asyncio, pytest-cov |
| [`pytest.ini`](../pytest.ini) | Конфигурация pytest (`testpaths = tests/unit`) |
| [`tests/conftest.py`](../tests/conftest.py) | Общие настройки (`TESTING=true` для тестового окружения) |
| [`tests/unit/`](../tests/unit/) | 52 unit-теста чистой логики |

Небольшое изменение в приложении: в [`app/application.py`](../app/application.py) при `TESTING=true` не запускаются фоновые задачи (обработчик медиа и очистка сессий). На production это не влияет.

### Что покрывают unit-тесты

| Файл | Область |
|------|---------|
| `test_security.py` | Хэширование и проверка паролей (bcrypt) |
| `test_settings.py` | Преобразование bool ↔ string в настройках |
| `test_tickets_templates.py` | Шаблоны талонов (`<number>`, `<window>`) |
| `test_tts.py` | Нормализация текста для озвучки, ресемплинг PCM |
| `test_media.py` | Имена файлов, режимы сжатия видео |
| `test_admin_map.py` | Валидация геометрии карты офиса |
| `test_update_from_git.py` | Исключения при обновлении из Git |

---

## Как запускать

Тесты **не запускаются автоматически** при `git commit` или `git push`. Только вручную (или если позже настроить CI / pre-commit hook).

### Установка (один раз)

```bash
pip install -r requirements-dev.txt
```

На Windows, если `pip` не в PATH:

```powershell
py -m pip install -r requirements-dev.txt
```

### Запуск всех тестов

```bash
pytest
```

или с подробным выводом:

```bash
pytest -v
```

### Запуск одного файла или одного теста

```bash
pytest tests/unit/test_security.py -v
pytest tests/unit/test_tickets_templates.py::test_render_ticket_template_replaces_placeholders -v
```

### Отчёт по покрытию (опционально)

```bash
pytest --cov=app --cov-report=term-missing
```

PostgreSQL, Docker и Node.js **не нужны**.

---

## Что убрали (временно)

Ранее по плану были заготовки более тяжёлых слоёв. По решению **оставлены только unit-тесты**.

| Удалено | Зачем было |
|---------|------------|
| `tests/integration/` | API-сценарии с реальным PostgreSQL (логин, очередь, WebSocket, closeDay) |
| `tests/factories.py` | Seed-данные для integration/E2E |
| `e2e/` | Playwright: terminal → operator → board в браузере |
| `package.json`, `playwright.config.ts` | Зависимости E2E |
| `scripts/seed_e2e_db.py`, `scripts/run_e2e_server.py` | Подготовка БД и сервер для E2E |
| `.github/workflows/tests.yml` | CI на GitHub (unit + integration + E2E) |
| `testcontainers`, `httpx`, `websockets` из `requirements-dev.txt` | Нужны были только integration/E2E |

**Почему убрали:** integration требует PostgreSQL (Docker или отдельная БД), E2E — ещё и Node/Chromium; на Windows без Docker это неудобно. Unit-тесты дают быструю проверку логики без инфраструктуры.

---

## Что можно добавить в будущем

### 1. Integration-тесты (приоритет: высокий)

Проверка API end-to-end через `TestClient` + PostgreSQL:

- `POST /login` → `POST /tickets/` → `POST /tickets/next` → `POST /tickets/finish`
- порядок очереди по приоритету услуг и FIFO
- redirect, сессии, `closeDay`

**Инфраструктура:** `tests/integration/`, `testcontainers[postgres]` или `TEST_DATABASE_URL`, фикстуры seed.

Часть фич PostgreSQL обязательна: advisory locks, trigger нумерации талонов, partial indexes.

### 2. E2E Playwright (приоритет: средний)

Проверка HTML/JS в браузере: `login.html`, `terminal.html`, `operator.html`, `board.html`.

**Инфраструктура:** `e2e/`, `@playwright/test`, скрипт запуска uvicorn с тестовой БД.

Полезно при частых правках фронта; тяжелее в поддержке, чем integration.

### 3. CI на GitHub Actions (приоритет: по желанию)

Автозапуск при push/PR:

```yaml
# пример: только unit (без Docker)
- pip install -r requirements-dev.txt
- pytest -v
```

Отдельные job'ы для integration (service `postgres`) и E2E — когда появятся соответствующие тесты.

### 4. Pre-commit hook (локально)

Запуск `pytest` перед каждым commit на машине разработчика — без GitHub, но дисциплинирует локально.

### 5. Unit-тесты фронтенда (низкий приоритет)

Вынести чистые функции из `web/js/board.js`, `web/js/tts.js` в ES-модули и покрыть Vitest/Jest — без браузера.

---

## Структура каталогов (текущая)

```text
requirements-dev.txt
pytest.ini
docs/TESTS.md            ← этот файл
tests/
  conftest.py
  unit/
    test_security.py
    test_settings.py
    test_tickets_templates.py
    test_tts.py
    test_media.py
    test_admin_map.py
    test_update_from_git.py
```

---

## Краткая шпаргалка

| Вопрос | Ответ |
|--------|--------|
| Запускаются ли тесты при `git push`? | **Нет** (CI отключён) |
| Нужна ли БД? | **Нет** |
| Сколько тестов? | **52** unit |
| Команда | `pytest` или `py -m pytest` |

## PostgreSQL: concurrent ticket claims

Run the integration tests against a separate PostgreSQL test database:

```powershell
$env:QRONION_TEST_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55439/postgres'
python -m pytest tests/integration/test_ticket_claims.py -q
```

The account must be able to create schemas. Each test creates a unique schema, installs it through Alembic,
and removes it after completion. Application startup only checks the schema.
Use a test server, not a production database. Without this variable, these tests
are skipped. The default `pytest` command still runs the unit suite only.

The tests cover independent operators claiming one or two tickets while the first
transaction remains open, simultaneous requests for one window, repeated calls,
and retry after rollback. SQL statements have an eight-second timeout so a lock
regression fails instead of waiting without a limit.


## Durable ticket issuance

The terminal sends a UUID `request_id` with `POST /tickets/`. The server stores
the request payload and receipt in `ticket_creation_requests` in the same
transaction as the ticket. Concurrent retries return the original receipt.
A different payload with the same ID returns HTTP 409. Existing clients without
an ID remain compatible, but do not receive duplicate protection.

The initial Alembic migration creates the request table before startup.
Deploy the backend before the updated terminal. Request records must remain
available for retries and must be included in database backups.

The terminal stores an uncertain request in localStorage and retries it once
with the same ID. Reloading preserves the request. Until the result is known,
the terminal asks the user to retry the same service and selected operator.
Clearing browser storage removes this recovery state. This does not guarantee
exactly one physical printout.

Run the issuance checks:

```powershell
python -m pytest tests/integration/test_ticket_creation.py -q
node --test tests/javascript/terminal-ticket-request.test.cjs
```

The tests install the numbering function in their isolated schemas.
Run them on a dedicated disposable PostgreSQL server.


## Board recovery after missed notifications

Both board engines request a full `board_state` over `/ws/board` on connection
and every 15 seconds. The server answers `{"type":"board_sync"}` requests
with the current state, even when no change notification was delivered.
If no full-state response arrives within 10 seconds, the client closes the
connection and uses the existing reconnect path. Closing a connection clears
its recovery timers. State snapshots replace displayed tickets without replaying
old call audio. This repairs screen state, but does not guarantee delivery of a
missed announcement.

Deploy the backend before the refreshed board scripts. Reopen existing board
pages once after deployment to load recovery support. The PostgreSQL test checks
missed assignment and completion notifications, repeated sync requests, malformed
messages, and reconnect. JavaScript tests check both engines with controlled time.

```powershell
python -m pytest tests/integration/test_board_recovery.py tests/unit/test_websocket_routes.py -q
node --test tests/javascript/board-recovery.test.cjs
```


## Schema installation and recovery

`tests/integration/test_schema_migrations.py` checks a clean Alembic install,
repeated upgrade without data loss or a number reset, rollback after a partial
failure, retry, rejection of unversioned databases, startup with read-only access,
wrong revisions, missing structure, model compatibility, concurrent installers,
and a copied install package with its own `main.env` and initial accounts.

```powershell
python -m pytest tests/integration/test_schema_migrations.py -q
```

The test package runs the migration CLI from another directory. This checks the
files needed for a VM install. It does not replace a full Ubuntu installation
with systemd, Nginx, PostgreSQL packages, and Grafana.
