#!/usr/bin/env python3
# update_from_git.py
#
# Безопасное обновление проекта из Git:
# - НЕ скачивает исключённые файлы
# - использует partial clone + sparse-checkout
# - сначала получает только список файлов
# - скачивает только разрешённые файлы
# - по умолчанию НЕ изменяет проект
# - реально обновляет только с флагом --apply
# - перед заменой делает backup

import argparse
import fnmatch
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
SCRIPT_NAME = "deploy/update_from_git.py"
EXCLUDE_FILE = "deploy/exclude_from_update.txt"


DEFAULT_EXCLUDES = [
    ".git/",
    "__pycache__/",
    "*.pyc",
    "*.pyo",

    ".env",
    "*.env",
    "main.env",

    "*.db",
    "*.sqlite",
    "*.sqlite3",

    ".backup_update_*/",
    "release.json",

    SCRIPT_NAME,
    EXCLUDE_FILE,
]


PROJECT_MARKERS = [
    "main.py",
    "requirements.txt",
    "queue",
]


def normalize_path(path: Path | str) -> str:
    normalized = str(path).replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.lstrip("/")


def load_excludes(project_dir: Path) -> list[str]:
    patterns = list(DEFAULT_EXCLUDES)

    exclude_path = project_dir / EXCLUDE_FILE
    if exclude_path.exists():
        for line in exclude_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            patterns.append(line)

    return patterns


def is_excluded(relative_path: str, patterns: list[str]) -> bool:
    relative_path = normalize_path(relative_path)

    for pattern in patterns:
        pattern = normalize_path(pattern)

        # Папка: queue/tts/
        if pattern.endswith("/"):
            folder_pattern = pattern.rstrip("/")
            parts = relative_path.split("/")
            folder_prefixes = ["/".join(parts[:index]) for index in range(1, len(parts))]
            if any(fnmatch.fnmatch(prefix, folder_pattern) for prefix in folder_prefixes):
                return True

        # Обычный glob: *.db, web/js/config.js, queue/tts/*
        if fnmatch.fnmatch(relative_path, pattern):
            return True

        # Папка без слеша: queue/tts
        if relative_path.startswith(pattern.rstrip("/") + "/"):
            return True

    return False


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def files_are_equal(a: Path, b: Path) -> bool:
    if not b.exists():
        return False

    if a.stat().st_size != b.stat().st_size:
        return False

    return file_hash(a) == file_hash(b)


def check_git_available() -> None:
    try:
        result = subprocess.run(
            ["git", "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        print("Git не найден. Установи Git и добавь его в PATH.")
        sys.exit(1)

    if result.returncode != 0:
        print("Git не найден или не запускается.")
        print(result.stderr)
        sys.exit(1)

    print("Найден:", result.stdout.strip())


def run_command_live(cmd: list[str], cwd: Path | None = None, title: str | None = None) -> None:
    if title:
        print(f"\n{title}")

    print("Команда:", " ".join(cmd))
    print()

    process = None

    try:
        process = subprocess.Popen(
            cmd,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

        while True:
            char = process.stdout.read(1)

            if char == "" and process.poll() is not None:
                break

            if char:
                print(char, end="", flush=True)

        return_code = process.wait()

        if return_code != 0:
            print("\n\nКоманда завершилась с ошибкой.")
            print("Код ошибки:", return_code)
            sys.exit(1)

    except KeyboardInterrupt:
        print("\n\nОперация прервана пользователем.")

        if process:
            try:
                process.kill()
            except Exception:
                pass

        sys.exit(1)


def run_command_capture(cmd: list[str], cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        print("Команда не найдена:", cmd[0])
        sys.exit(1)

    if result.returncode != 0:
        print("Ошибка выполнения команды:")
        print(" ".join(cmd))
        print(result.stderr)
        sys.exit(1)

    return result.stdout


def clone_repo_metadata(repo_url: str, branch: str | None, target_dir: Path) -> None:
    cmd = [
        "git",
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--no-checkout",
        "--progress",
    ]

    if branch:
        cmd.extend(["--branch", branch])

    cmd.extend([repo_url, str(target_dir)])

    run_command_live(
        cmd,
        title="Получаю структуру репозитория без скачивания файлов...",
    )


def list_repo_files(repo_dir: Path) -> list[str]:
    output = run_command_capture(
        ["git", "-C", str(repo_dir), "ls-tree", "-r", "--name-only", "HEAD"]
    )

    files = []

    for line in output.splitlines():
        line = line.strip().replace("\\", "/")
        if line:
            files.append(line)

    return files


def check_project_markers_in_tree(repo_files: list[str]) -> None:
    missing = []

    file_set = set(repo_files)

    for marker in PROJECT_MARKERS:
        marker = marker.replace("\\", "/").rstrip("/")

        exists_as_file = marker in file_set
        exists_as_folder = any(path.startswith(marker + "/") for path in repo_files)

        if not exists_as_file and not exists_as_folder:
            missing.append(marker)

    if missing:
        print("\nПохоже, это не тот репозиторий.")
        print("Не найдены обязательные элементы:")
        for item in missing:
            print(f"  - {item}")
        sys.exit(1)


def configure_sparse_checkout(repo_dir: Path, allowed_files: list[str]) -> None:
    if not allowed_files:
        print("\nНет разрешённых файлов для скачивания.")
        sys.exit(1)

    run_command_capture(
        ["git", "-C", str(repo_dir), "sparse-checkout", "init", "--no-cone"]
    )

    sparse_file = repo_dir / ".git" / "info" / "sparse-checkout"

    # Пишем точный список файлов, которые разрешено скачать.
    # Формат /path/to/file означает путь от корня репозитория.
    content = "\n".join(f"/{path}" for path in allowed_files)
    sparse_file.write_text(content + "\n", encoding="utf-8")


def checkout_allowed_files(repo_dir: Path) -> None:
    run_command_live(
        ["git", "-C", str(repo_dir), "checkout", "--progress", "HEAD"],
        title="Скачиваю только разрешённые файлы...",
    )


def get_repo_revision(repo_dir: Path) -> str:
    return run_command_capture(
        ["git", "-C", str(repo_dir), "rev-parse", "--short=12", "HEAD"]
    ).strip()


def get_installed_revision(project_dir: Path) -> str | None:
    try:
        data = json.loads((project_dir / "release.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    revision = str(data.get("version", "")).strip()
    return revision or None


def write_installed_revision(project_dir: Path, revision: str) -> None:
    release_file = project_dir / "release.json"
    temporary_file = project_dir / "release.json.tmp"
    temporary_file.write_text(
        json.dumps({"version": revision}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    temporary_file.replace(release_file)


def collect_checked_out_files(repo_dir: Path, excludes: list[str]) -> list[Path]:
    result = []

    for path in repo_dir.rglob("*"):
        if not path.is_file():
            continue

        relative = normalize_path(path.relative_to(repo_dir))

        if is_excluded(relative, excludes):
            continue

        result.append(path)

    return result

def collect_local_project_files(project_dir: Path, excludes: list[str]) -> list[Path]:
    result = []

    for path in project_dir.rglob("*"):
        if not path.is_file():
            continue

        relative = normalize_path(path.relative_to(project_dir))

        if is_excluded(relative, excludes):
            continue

        result.append(path)

    return result

def copy_file_with_dirs(src: Path, dst: Path) -> None:
    destination_exists = dst.exists()
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    if not destination_exists:
        shutil.copymode(src, dst)

def remove_empty_dirs_upwards(start_dir: Path, stop_dir: Path) -> None:
    current = start_dir

    while current != stop_dir and current.exists():
        try:
            current.rmdir()
        except OSError:
            break

        current = current.parent

def make_backup(
    project_dir: Path,
    files_to_update: list[tuple[Path, Path]],
    files_to_delete: list[Path],
) -> Path | None:
    files_for_backup: list[Path] = []

    for _src, dst in files_to_update:
        if dst.exists():
            files_for_backup.append(dst)

    for path in files_to_delete:
        if path.exists():
            files_for_backup.append(path)

    if not files_for_backup:
        return None

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    backup_dir = project_dir / f".backup_update_{timestamp}"
    backup_dir.mkdir(parents=True, exist_ok=True)

    for path in files_for_backup:
        relative = path.relative_to(project_dir)
        backup_path = backup_dir / relative
        copy_file_with_dirs(path, backup_path)

    return backup_dir

def print_file_list(title: str, files: list[str], limit: int = 80) -> None:
    print(f"\n{title}")

    if not files:
        print("  Нет.")
        return

    for item in files[:limit]:
        print(f"  - {item}")

    if len(files) > limit:
        print(f"  ... и ещё {len(files) - limit}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Безопасное обновление проекта из Git с исключениями и sparse-checkout."
    )

    parser.add_argument(
        "--repo",
        required=True,
        help="Ссылка на Git-репозиторий, например https://github.com/user/project.git",
    )

    parser.add_argument(
        "--branch",
        default=None,
        help="Ветка Git. Например: main или master. Если не указать, берётся ветка по умолчанию.",
    )

    parser.add_argument(
        "--apply",
        action="store_true",
        help="Применить изменения. Без этого флага будет только проверка.",
    )

    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Не делать backup перед заменой файлов.",
    )
    
    parser.add_argument(
        "--delete-removed",
        action="store_true",
        help="Удалять локальные файлы, которых больше нет в Git. Исключения не удаляются.",
    )    

    args = parser.parse_args()

    project_dir = PROJECT_DIR

    print(f"Папка проекта: {project_dir}")

    check_git_available()

    excludes = load_excludes(project_dir)

    print("\nИсключения:")
    for item in excludes:
        print(f"  - {item}")

    with tempfile.TemporaryDirectory(prefix="project_update_") as tmp:
        tmp_dir = Path(tmp)
        repo_dir = tmp_dir / "repo"

        clone_repo_metadata(args.repo, args.branch, repo_dir)
        target_revision = get_repo_revision(repo_dir)

        all_repo_files = list_repo_files(repo_dir)
        check_project_markers_in_tree(all_repo_files)

        allowed_files = []
        excluded_files = []

        for relative_path in all_repo_files:
            if is_excluded(relative_path, excludes):
                excluded_files.append(relative_path)
            else:
                allowed_files.append(relative_path)

        print(f"\nВсего файлов в репозитории: {len(all_repo_files)}")
        print(f"Разрешено к скачиванию: {len(allowed_files)}")
        print(f"Исключено до скачивания: {len(excluded_files)}")

        print_file_list("Исключённые файлы, которые НЕ будут скачаны:", excluded_files, limit=60)

        configure_sparse_checkout(repo_dir, allowed_files)
        checkout_allowed_files(repo_dir)

        repo_files = collect_checked_out_files(repo_dir, excludes)

        files_to_update: list[tuple[Path, Path]] = []

        for src in repo_files:
            relative = src.relative_to(repo_dir)
            dst = project_dir / relative

            if not files_are_equal(src, dst):
                files_to_update.append((src, dst))


        allowed_file_set = set(allowed_files)
        local_files = collect_local_project_files(project_dir, excludes)

        files_to_delete: list[Path] = []

        if args.delete_removed:
            for local_file in local_files:
                relative = normalize_path(local_file.relative_to(project_dir))

                if relative not in allowed_file_set:
                    files_to_delete.append(local_file)


        print("\nФайлы к обновлению:")
        if files_to_update:
            for _src, dst in files_to_update:
                print(f"  - {normalize_path(dst.relative_to(project_dir))}")
        else:
            print("  Нет изменений.")

        print("\nФайлы к удалению:")
        if args.delete_removed:
            if files_to_delete:
                for path in files_to_delete:
                    print(f"  - {normalize_path(path.relative_to(project_dir))}")
            else:
                print("  Нет.")
        else:
            print("  Удаление отключено. Чтобы включить, добавь --delete-removed.")

        if not args.apply:
            print("\nПроверка завершена. Файлы НЕ изменены.")
            print("Чтобы реально обновить проект, запусти с флагом --apply.")
            return

        release_needs_update = get_installed_revision(project_dir) != target_revision

        if not files_to_update and not files_to_delete and not release_needs_update:
            print("\nОбновлять нечего.")
            return

        backup_dir = None

        if not args.no_backup:
            backup_dir = make_backup(project_dir, files_to_update, files_to_delete)

            if backup_dir:
                print(f"\nBackup создан: {backup_dir}")
            else:
                print("\nBackup не нужен: заменяемых существующих файлов нет.")

        print("\nПрименяю обновление...")

        for src, dst in files_to_update:
            copy_file_with_dirs(src, dst)
            print(f"  обновлён: {normalize_path(dst.relative_to(project_dir))}")

        if files_to_delete:
            print("\nУдаляю файлы, которых больше нет в Git...")

            for path in files_to_delete:
                if path.exists():
                    relative = normalize_path(path.relative_to(project_dir))
                    path.unlink()
                    remove_empty_dirs_upwards(path.parent, project_dir)
                    print(f"  удалён: {relative}")

        write_installed_revision(project_dir, target_revision)
        print(f"  версия релиза: {target_revision}")

        print("\nФайлы обновлены. Перед запуском очереди обновите зависимости, сделайте копию БД")
        print("и выполните из каталога проекта: venv/bin/python -m app.schema upgrade")
        print("При ошибке миграции не запускайте службу очереди.")

        if backup_dir:
            print(f"Старые версии файлов лежат здесь: {backup_dir}")


if __name__ == "__main__":
    main()
