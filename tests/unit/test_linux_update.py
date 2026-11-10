"""Exercise update and recovery with real files and a simulated Linux host."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest

DEPLOY = Path(__file__).resolve().parents[2] / 'deploy'
sys.path.insert(0, str(DEPLOY))
spec = importlib.util.spec_from_file_location('linux_update', DEPLOY / 'linux_update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class Host:
    def __init__(self, failure=None):
        self.failure = failure
        self.running = True
        self.backups = 0
        self.restores = 0
        self.preparations = 0

    def run(self, *args, cwd=None):
        args = list(map(str, args))
        step = None
        if args[:2] == ['systemctl', 'stop']:
            self.running = False
            step = 'stop'
        elif args[:2] == ['systemctl', 'start']:
            self.running = True
            step = 'start'
        elif args[0] == 'install':
            Path(args[-1]).mkdir(parents=True, exist_ok=True)
        elif args[0] == 'bash' and args[1].endswith('backup_db.sh'):
            assert not self.running
            step = 'backup'
            directory = Path(args[args.index('--output-dir') + 1])
            directory.mkdir()
            (directory / 'before.dump').write_text('database before migration')
            self.backups += 1
        elif args[0] == 'bash' and args[1].endswith('restore_db.sh'):
            assert not self.running
            assert Path(args[2]).read_text() == 'database before migration'
            self.restores += 1
            step = 'restore'
        elif args[-3:] == ['-m', 'app.schema', 'upgrade']:
            assert not self.running
            step = 'migration'
        elif 'pip' in args and 'install' in args:
            self.preparations += 1
            step = 'dependencies'
        if self.failure == step and step:
            raise subprocess.CalledProcessError(1, args)

    def healthy(self):
        assert self.running
        if self.failure == 'health':
            raise RuntimeError('No response')


@pytest.fixture
def installation(tmp_path, monkeypatch):
    source = tmp_path / 'source'
    project = tmp_path / 'project'
    state = tmp_path / 'state/pending.json'
    state.parent.mkdir()
    for root, content in [(source, 'new'), (project, 'old')]:
        (root / 'app').mkdir(parents=True)
        (root / 'app/code.py').write_text(content)
        (root / 'requirements.txt').write_text('example==1')
    (project / 'venv').mkdir()
    (project / 'venv/old-environment').write_text('original')
    (project / 'main.env').write_text('secret')
    for relative in ['queue/media/movie.mp4', 'queue/tts/voice.onnx', 'data/map.json', 'data/docs/manual.pdf']:
        for root in [source, project]:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('local' if root == project else 'repository')
    # Use the same local data exclusions as installed servers.
    (project / 'deploy').mkdir()
    (project / 'deploy/exclude_from_update.txt').write_text('queue/media/\nqueue/tts/\ndata/map.json\n')
    monkeypatch.setattr(update.git, 'get_repo_revision', lambda _: 'new-release')
    return source, project, state


def assert_local_data(project):
    assert (project / 'main.env').read_text() == 'secret'
    for relative in ['queue/media/movie.mp4', 'queue/tts/voice.onnx', 'data/map.json', 'data/docs/manual.pdf']:
        assert (project / relative).read_text() == 'local'


def test_update_then_repeat_is_noop(installation):
    source, project, state = installation
    host = Host()
    update.execute(source, project, state, host)
    assert (project / 'app/code.py').read_text() == 'new'
    assert update.git.get_installed_revision(project) == 'new-release'
    assert host.running and not state.exists()
    assert project.joinpath('venv').is_symlink()
    assert_local_data(project)
    update.execute(source, project, state, host)
    assert host.backups == host.preparations == 1


def test_check_does_not_change_installation(installation):
    source, project, state = installation
    host = Host()
    update.execute(source, project, state, host, check=True)
    assert (project / 'app/code.py').read_text() == 'old'
    assert not state.exists()
    assert host.backups == host.preparations == 0


@pytest.mark.parametrize('failure', ['backup', 'migration', 'start', 'health'])
def test_failed_update_can_recover_and_retry(installation, failure):
    source, project, state = installation
    host = Host(failure)
    with pytest.raises((RuntimeError, subprocess.CalledProcessError)):
        update.execute(source, project, state, host)
    assert not host.running
    assert state.exists()
    assert update.git.get_installed_revision(project) is None
    with pytest.raises(RuntimeError, match='Найдено незавершённое'):
        update.execute(source, project, state, host)
    host.failure = None
    update.recover(project, state, host)
    assert host.running and not state.exists()
    assert (project / 'app/code.py').read_text() == 'old'
    assert (project / 'venv/old-environment').read_text() == 'original'
    assert host.restores == (0 if failure == 'backup' else 1)
    assert_local_data(project)
    update.recover(project, state, host)
    update.execute(source, project, state, host)
    assert update.git.get_installed_revision(project) == 'new-release'


def test_failed_restore_stays_stopped_and_can_repeat(installation):
    source, project, state = installation
    host = Host('migration')
    with pytest.raises(subprocess.CalledProcessError):
        update.execute(source, project, state, host)
    host.failure = 'restore'
    with pytest.raises(subprocess.CalledProcessError):
        update.recover(project, state, host)
    assert state.exists() and not host.running
    host.failure = None
    update.recover(project, state, host)
    assert host.running and not state.exists()


def test_dependencies_fail_before_service_stops(installation):
    source, project, state = installation
    host = Host('dependencies')
    with pytest.raises(subprocess.CalledProcessError):
        update.execute(source, project, state, host)
    assert host.running and not state.exists()
    assert (project / 'app/code.py').read_text() == 'old'


def test_second_update_uses_new_environment_and_recovers(installation, monkeypatch):
    source, project, state = installation
    host = Host()
    update.execute(source, project, state, host)
    previous_environment = (project / 'venv').resolve()
    (source / 'app/code.py').write_text('third')
    monkeypatch.setattr(update.git, 'get_repo_revision', lambda _: 'third-release')
    host.failure = 'migration'
    with pytest.raises(subprocess.CalledProcessError):
        update.execute(source, project, state, host)
    host.failure = None
    update.recover(project, state, host)
    assert (project / 'venv').resolve() == previous_environment
    assert update.git.get_installed_revision(project) == 'new-release'
    assert (project / 'app/code.py').read_text() == 'new'


def test_partial_file_copy_recovers_new_and_existing_files(installation, monkeypatch):
    source, project, state = installation
    (source / 'app/new.py').write_text('added')
    original = update.git.copy_file_with_dirs
    calls = 0

    def interrupted_copy(src, dst):
        nonlocal calls
        original(src, dst)
        calls += 1
        if calls == 2:
            raise KeyboardInterrupt()

    monkeypatch.setattr(update.git, 'copy_file_with_dirs', interrupted_copy)
    host = Host()
    with pytest.raises(KeyboardInterrupt):
        update.execute(source, project, state, host)
    assert not host.running
    update.recover(project, state, host)
    assert (project / 'app/code.py').read_text() == 'old'
    assert not (project / 'app/new.py').exists()
    assert host.restores == 0
    assert_local_data(project)


def test_interruption_after_commit_keeps_new_version(installation, monkeypatch):
    source, project, state = installation
    original = update.save

    def interrupted_save(path, data):
        original(path, data)
        if data['phase'] == 'complete':
            raise KeyboardInterrupt()

    monkeypatch.setattr(update, 'save', interrupted_save)
    host = Host()
    with pytest.raises(KeyboardInterrupt):
        update.execute(source, project, state, host)
    assert state.exists() and not host.running
    update.recover(project, state, host)
    assert host.running and not state.exists()
    assert (project / 'app/code.py').read_text() == 'new'
    assert update.git.get_installed_revision(project) == 'new-release'
    assert not (project / '.venv-before-update').exists()


def test_recovery_health_failure_keeps_journal_and_stops_service(installation):
    source, project, state = installation
    host = Host('migration')
    with pytest.raises(subprocess.CalledProcessError):
        update.execute(source, project, state, host)
    host.failure = 'health'
    with pytest.raises(RuntimeError):
        update.recover(project, state, host)
    assert state.exists() and not host.running
    host.failure = None
    update.recover(project, state, host)
    assert host.running and not state.exists()
