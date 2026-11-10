import hashlib
import json

from app.config import BASE_DIR


RELEASE_FILE = BASE_DIR / "release.json"


def _release_file_version() -> str | None:
    try:
        data = json.loads(RELEASE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None

    version = str(data.get("version", "")).strip()
    return version or None


def _files_revision() -> str:
    hasher = hashlib.sha256()
    for directory in (BASE_DIR / "app", BASE_DIR / "web"):
        if not directory.exists():
            continue
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                stat = path.stat()
                hasher.update(str(path.relative_to(BASE_DIR)).encode("utf-8"))
                hasher.update(str(stat.st_mtime_ns).encode("utf-8"))
                hasher.update(str(stat.st_size).encode("utf-8"))
    return hasher.hexdigest()[:12]


def get_release_version() -> str:
    return _release_file_version() or _files_revision()
