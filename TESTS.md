# Тестирование SUO (Queue)

Документация по автотестам в репозитории: что есть сейчас, как запускать и что можно добавить позже.

## Что сделано

Добавлена **минимальная тестовая инфраструктура** — только **unit-тесты** без базы данных, Docker и браузера.

| Компонент | Назначение |
|-----------|------------|
| [`requirements-dev.txt`](requirements-dev.txt) | Dev-зависимости: pytest, pytest-asyncio, pytest-cov |
| [`pytest.ini`](pytest.ini) | Конфигурация pytest (`testpaths = tests/unit`) |
| [`tests/conftest.py`](tests/conftest.py) | Общие настройки (`TESTING=true` для тестового окружения) |
| [`tests/unit/`](tests/unit/) | 52 unit-теста чистой логики |

Небольшое изменение в приложении: в [`app/application.py`](app/application.py) при `TESTING=true` не запускаются фоновые задачи (обработчик медиа и очистка сессий). На production это не влияет.

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

Вынести чистые функции из `queue/js/board.js`, `queue/js/tts.js` в ES-модули и покрыть Vitest/Jest — без браузера.

---

## Структура каталогов (текущая)

```text
requirements-dev.txt
pytest.ini
TESTS.md                 ← этот файл
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

The account must be able to create schemas. Each test creates a unique schema
and removes it after completion. Tests do not run application startup migrations.
Use a test server, not a production database. Without this variable, these tests
are skipped. The default `pytest` command still runs the unit suite only.

The tests cover independent operators claiming one or two tickets while the first
transaction remains open, simultaneous requests for one window, repeated calls,
and retry after rollback. SQL statements have an eight-second timeout so a lock
regression fails instead of waiting without a limit.
