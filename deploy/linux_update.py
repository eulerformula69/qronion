#!/usr/bin/env python3
"""Update a Linux installation with a durable recovery journal."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from uuid import uuid4

import update_from_git as git

def installation_path(preferred=Path('/home/qronion'), legacy=Path('/home/queue/queue_project')):
    if not (preferred / 'main.env').is_file() and (legacy / 'main.env').is_file():
        return legacy
    return preferred


APP_DIR = installation_path()
REPO = 'https://github.com/eulerformula69/electronicqueue.git'
STATE_ROOT = Path('/var/lib/queue-update')


class Linux:
    def run(self, *args, cwd=None):
        subprocess.run(list(map(str, args)), cwd=cwd, check=True)

    def healthy(self):
        for _ in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8000/queue/login.html', timeout=2) as response:
                    if response.status == 200:
                        return
            except OSError:
                pass
            time.sleep(1)
        raise RuntimeError('Приложение не ответило после запуска.')


def save(path, data):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


@contextmanager
def lock():
    import fcntl
    import grp
    STATE_ROOT.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chown(STATE_ROOT, 0, grp.getgrnam('queue').gr_gid)
    os.chmod(STATE_ROOT, 0o750)
    with (STATE_ROOT / 'lock').open('w') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Другая установка или обновление уже выполняется.') from None
        yield


def application_files(source, project):
    # Keep local media, maps, documents, speech models, and settings in place.
    excludes = git.load_excludes(project) + ['data/docs/', '.agents/', 'tests/', 'docs/', '.github/']
    files = {}
    for path in git.collect_checked_out_files(source, excludes):
        relative = path.relative_to(source)
        if path.is_symlink():
            raise RuntimeError(f'Символическая ссылка в обновлении: {relative}')
        if relative.parts[0] not in {'app', 'queue', 'deploy', 'scripts', 'migrations'} and relative.as_posix() not in {
            'main.py', 'requirements.txt', 'alembic.ini', 'data/statistics.json'
        }:
            continue
        target = project / relative
        if any(parent.is_symlink() for parent in [target, *target.parents] if parent != project.parent):
            raise RuntimeError(f'Символическая ссылка в установке: {relative}')
        files[str(relative)] = path
    return files


def app_run(backend, project, *args):
    backend.run('runuser', '-u', 'queue', '--', project / 'venv/bin/python', *args, cwd=project)


def environment_root(project):
    if project == Path('/home/qronion'):
        return project / '.environments'
    return project.parent / 'queue-environments'


def discard_old_environment(project):
    old = project / '.venv-before-update'
    if old.is_symlink():
        previous = old.resolve()
        old.unlink()
        if previous.parent == (environment_root(project)).resolve() and previous != (project / 'venv').resolve():
            shutil.rmtree(previous)
    elif old.exists():
        shutil.rmtree(old)


def execute(source, project, state_file, backend, check=False):
    if state_file.exists():
        raise RuntimeError('Найдено незавершённое обновление. Выберите восстановление в меню.')
    revision = git.get_repo_revision(source)
    files = application_files(source, project)
    changed = {name: path for name, path in files.items() if not git.files_are_equal(path, project / name)}
    if not changed and git.get_installed_revision(project) == revision:
        print('Уже установлена актуальная версия.')
        return
    print(f'Версия: {git.get_installed_revision(project) or "не записана"} → {revision}')
    print(f'Файлов к замене: {len(changed)}. Локальные данные сохраняются.')
    if check:
        return
    if (project / '.venv-before-update').exists() or (project / '.venv-before-update').is_symlink():
        raise RuntimeError('Осталось предыдущее окружение. Сначала завершите восстановление.')

    transaction = state_file.parent / uuid4().hex
    transaction.mkdir(mode=0o750)
    backend.run('chown', 'root:queue', transaction)
    # A venv must stay at its original path because entry points contain absolute paths.
    environment = environment_root(project) / transaction.name
    print('[1/5] Готовлю зависимости. Очередь продолжает работать.', flush=True)
    try:
        backend.run('install', '-d', '-o', 'queue', '-g', 'queue', environment)
        backend.run('runuser', '-u', 'queue', '--', 'python3', '-m', 'venv', environment)
        backend.run('runuser', '-u', 'queue', '--', environment / 'bin/python', '-m', 'pip',
                    'install', '-r', source / 'requirements.txt')
        backend.run('runuser', '-u', 'queue', '--', environment / 'bin/python', '-m', 'pip', 'check')
    except BaseException:
        shutil.rmtree(environment, ignore_errors=True)
        raise
    existing = []
    for name in [*changed, 'release.json']:
        path = project / name
        if path.exists():
            target = transaction / 'files' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            existing.append(name)
    state = dict(transaction=str(transaction), environment=str(environment), changed=[*changed, 'release.json'],
                 existing=existing, phase='prepared', revision=revision)
    save(state_file, state)
    try:
        print('[2/5] Останавливаю очередь и создаю копию БД.', flush=True)
        backend.run('systemctl', 'stop', 'queue.service')
        # The database copy is made after all application writers stop.
        backend.run('bash', project / 'deploy/backup_db.sh', '--project-dir', project,
                    '--output-dir', transaction / 'db', '--keep-days', '0', '--label', 'before_update')
        state['phase'] = 'files'
        save(state_file, state)
        print('[3/5] Обновляю файлы приложения.', flush=True)
        for name, path in changed.items():
            git.copy_file_with_dirs(path, project / name)
        current = project / 'venv'
        if not (project / '.venv-before-update').exists():
            current.rename(project / '.venv-before-update')
        current.symlink_to(environment, target_is_directory=True)
        backend.run('chown', '-R', 'queue:queue', project)
        state['phase'] = 'migration'
        save(state_file, state)
        print('[4/5] Обновляю и проверяю структуру БД.', flush=True)
        app_run(backend, project, '-m', 'app.schema', 'upgrade')
        print('[5/5] Запускаю очередь и проверяю ответ.', flush=True)
        backend.run('systemctl', 'start', 'queue.service')
        backend.healthy()
        backend.run('bash', project / 'deploy/install_management.sh')
        git.write_installed_revision(project, revision)
        state['phase'] = 'complete'
        save(state_file, state)
        discard_old_environment(project)
        state_file.unlink()
        print(f'Обновление завершено. Копия файлов и БД: {transaction}')
    except BaseException:
        backend.run('systemctl', 'stop', 'queue.service')
        print('Обновление прервано. Очередь остановлена. Выберите восстановление в меню.', file=sys.stderr)
        raise


def recover(project, state_file, backend):
    if not state_file.exists():
        print('Незавершённых обновлений нет.')
        return
    state = json.loads(state_file.read_text(encoding='utf-8'))
    transaction = Path(state['transaction'])
    backend.run('systemctl', 'stop', 'queue.service')
    if state['phase'] != 'complete':
        for name in state['changed']:
            target = project / name
            if name in state['existing']:
                shutil.copy2(transaction / 'files' / name, target)
            else:
                target.unlink(missing_ok=True)
        old = project / '.venv-before-update'
        if old.exists():
            current = project / 'venv'
            if current.is_symlink():
                current.unlink()
            old.rename(current)
        if state['phase'] == 'migration':
            dumps = list((transaction / 'db').glob('*.dump'))
            if len(dumps) != 1:
                raise RuntimeError(f'Не найден единственный дамп БД: {transaction / "db"}')
            backend.run('bash', project / 'deploy/restore_db.sh', dumps[0], '--project-dir', project,
                        '--yes', '--skip-safety-backup')
    try:
        app_run(backend, project, '-m', 'app.schema', 'check')
        backend.run('systemctl', 'start', 'queue.service')
        backend.healthy()
    except BaseException:
        backend.run('systemctl', 'stop', 'queue.service')
        raise
    discard_old_environment(project)
    unused = Path(state['environment']).resolve()
    if unused.parent == (environment_root(project)).resolve() and unused != (project / 'venv').resolve():
        shutil.rmtree(unused, ignore_errors=True)
    state_file.unlink()
    print('Очередь восстановлена и отвечает на запросы.')


def main():
    parser = argparse.ArgumentParser(description='Обновление Qronion с восстановлением после сбоя')
    parser.add_argument('--repo', default=REPO)
    parser.add_argument('--branch', default='main')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--recover', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('Запустите на сервере Linux через sudo.')
    if not (APP_DIR / 'main.env').is_file():
        parser.error('Сначала установите очередь через меню.')
    with lock():
        state_file = STATE_ROOT / 'pending.json'
        if args.recover:
            recover(APP_DIR, state_file, Linux())
            return
        if state_file.exists():
            raise RuntimeError('Сначала выберите восстановление в меню.')
        with tempfile.TemporaryDirectory(prefix='queue-source-') as temporary:
            # The app user must read the requirements file during preparation.
            os.chmod(temporary, 0o755)
            source = Path(temporary) / 'repo'
            git.clone_repo_metadata(args.repo, args.branch, source)
            paths = git.list_repo_files(source)
            git.check_project_markers_in_tree(paths)
            excluded = git.load_excludes(APP_DIR)
            git.configure_sparse_checkout(source, [p for p in paths if not git.is_excluded(p, excluded)])
            git.checkout_allowed_files(source)
            execute(source, APP_DIR, state_file, Linux(), args.check)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f'Ошибка: {error}', file=sys.stderr)
        sys.exit(1)
