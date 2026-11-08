"""Check schema installation and recovery on PostgreSQL."""
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
import subprocess
import sys
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import create_engine, event, inspect, text

from app.schema import check_schema, migration_config, upgrade_schema


ROOT = Path(__file__).resolve().parents[2]


def test_clean_install_repeat_preserves_data_and_numbering(empty_database):
    engine = empty_database
    upgrade_schema(engine)
    check_schema(engine)
    with engine.begin() as db:
        first = db.execute(text("INSERT INTO tickets (status) VALUES ('waiting') RETURNING id, number")).one()
    upgrade_schema(engine)
    with engine.begin() as db:
        assert db.execute(text('SELECT number FROM tickets WHERE id=:id'), {'id': first.id}).scalar_one() == first.number
        second = db.execute(text("INSERT INTO tickets (status) VALUES ('waiting') RETURNING number")).scalar_one()
    assert second == first.number + 1
    check_schema(engine)


def test_failure_rolls_back_schema_and_retry_succeeds(empty_database):
    def fail_numbering(connection, cursor, statement, parameters, context, executemany):
        if 'CREATE TRIGGER ticket_number_before_insert' in statement:
            raise RuntimeError('simulated migration failure')

    event.listen(empty_database, 'before_cursor_execute', fail_numbering)
    try:
        with pytest.raises(RuntimeError, match='simulated migration failure'):
            upgrade_schema(empty_database)
    finally:
        event.remove(empty_database, 'before_cursor_execute', fail_numbering)
    assert inspect(empty_database).get_table_names() == []
    upgrade_schema(empty_database)
    check_schema(empty_database)


def test_unversioned_database_is_rejected_without_data_changes(empty_database):
    with empty_database.begin() as db:
        db.execute(text('CREATE TABLE old_installation (value integer)'))
        db.execute(text('INSERT INTO old_installation VALUES (42)'))
    with pytest.raises(RuntimeError, match='пустая база'):
        upgrade_schema(empty_database)
    assert inspect(empty_database).get_table_names() == ['old_installation']
    with empty_database.connect() as db:
        assert db.execute(text('SELECT value FROM old_installation')).scalar_one() == 42


@pytest.mark.parametrize('revision', [None, 'old_revision', 'future_revision'])
def test_startup_rejects_wrong_revision(empty_database, revision, monkeypatch):
    from app import application
    from fastapi.testclient import TestClient

    if revision:
        upgrade_schema(empty_database)
        with empty_database.begin() as db:
            db.execute(text('UPDATE alembic_version SET version_num=:revision'), {'revision': revision})
    monkeypatch.setattr(application, 'engine', empty_database)
    monkeypatch.setattr(application, 'TESTING', True)
    with pytest.raises(RuntimeError, match='Версия базы'):
        with TestClient(application.app):
            pass


def test_application_starts_with_read_only_database(empty_database, monkeypatch):
    from app import application
    from fastapi.testclient import TestClient

    upgrade_schema(empty_database)
    with empty_database.connect() as db:
        schema = db.execute(text('SELECT current_schema()')).scalar_one()
    readonly = create_engine(empty_database.url, connect_args={
        'options': f'-csearch_path={schema} -cdefault_transaction_read_only=on'
    })
    try:
        monkeypatch.setattr(application, 'engine', readonly)
        monkeypatch.setattr(application, 'TESTING', True)
        with TestClient(application.app) as client:
            assert client.get('/openapi.json').status_code == 200
    finally:
        readonly.dispose()


@pytest.mark.parametrize('damage', [
    'ALTER TABLE admins DROP COLUMN status',
    'ALTER TABLE tickets DISABLE TRIGGER ticket_number_before_insert',
    'DROP TABLE ticket_creation_requests',
    'DROP SEQUENCE ticket_number_seq',
])
def test_startup_detects_missing_structure(empty_database, damage):
    upgrade_schema(empty_database)
    with empty_database.begin() as db:
        db.execute(text(damage))
    with pytest.raises(RuntimeError, match='структур|Структура|отсутствует|Нумерация'):
        check_schema(empty_database)


def test_initial_schema_matches_models(empty_database):
    upgrade_schema(empty_database)
    config = migration_config()
    with empty_database.connect() as db:
        config.attributes['connection'] = db
        command.check(config)


def test_packaged_install_runs_cli_outside_repository(empty_database, tmp_path):
    # Mimic the migration files copied by the VM installer, with its own config.
    (tmp_path / 'app').mkdir()
    for name in ['__init__.py', 'config.py', 'database.py', 'models.py', 'schema.py']:
        shutil.copy2(ROOT / 'app' / name, tmp_path / 'app' / name)
    shutil.copy2(ROOT / 'alembic.ini', tmp_path)
    shutil.copytree(ROOT / 'migrations', tmp_path / 'migrations', ignore=shutil.ignore_patterns('__pycache__'))
    with empty_database.connect() as db:
        schema = db.execute(text('SELECT current_schema()')).scalar_one()
    url = empty_database.url.update_query_dict({'options': f'-csearch_path={schema}'})
    (tmp_path / 'main.env').write_text('DATABASE_URL=' + url.render_as_string(hide_password=False), encoding='utf-8')
    def invoke(action):
        result = subprocess.run(
            [sys.executable, '-m', 'app.schema', action],
            cwd=tmp_path, capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, result.stderr

    # Separate installer processes must serialize a simultaneous first install.
    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(invoke, ['upgrade', 'upgrade']))
    invoke('upgrade')
    invoke('check')
    check_schema(empty_database)
    (tmp_path / 'deploy').mkdir()
    shutil.copy2(ROOT / 'deploy' / 'bootstrap_users.py', tmp_path / 'deploy')
    env = {**os.environ, 'QUEUE_ADMIN_PASSWORD': 'test-admin', 'QUEUE_TERMINAL_PASSWORD': 'test-terminal'}
    for _ in range(2):
        result = subprocess.run(
            [sys.executable, str(tmp_path / 'deploy' / 'bootstrap_users.py')],
            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, result.stderr
    with empty_database.connect() as db:
        assert db.execute(text('SELECT login FROM admins ORDER BY login')).scalars().all() == ['admin', 'terminal']


def test_later_revision_preserves_existing_records(empty_database, tmp_path):
    upgrade_schema(empty_database)
    with empty_database.begin() as db:
        db.execute(text("INSERT INTO tickets (status) VALUES ('waiting')"))
    shutil.copytree(ROOT / 'migrations', tmp_path / 'migrations', ignore=shutil.ignore_patterns('__pycache__'))
    revision = tmp_path / 'migrations' / 'versions' / '0002_test.py'
    revision.write_text(
        "from alembic import op\n"
        "revision = '0002_test'\ndown_revision = '0001_initial'\n"
        "def upgrade():\n    op.execute('ALTER TABLE tickets ADD COLUMN test_note varchar')\n",
        encoding='utf-8',
    )
    config = migration_config()
    config.set_main_option('script_location', str(tmp_path / 'migrations'))
    for _ in range(2):
        with empty_database.connect() as db:
            config.attributes['connection'] = db
            command.upgrade(config, 'head')
    with empty_database.connect() as db:
        assert db.execute(text('SELECT count(*) FROM tickets')).scalar_one() == 1
        assert db.execute(text('SELECT version_num FROM alembic_version')).scalar_one() == '0002_test'
        assert db.execute(text('SELECT test_note FROM tickets')).scalar_one() is None
