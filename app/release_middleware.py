import re

from starlette.requests import Request
from starlette.responses import Response

from app.config import QUEUE_TIME_ZONE
from app.release import get_release_version


ASSET_URL_RE = re.compile(
    rb'(?P<prefix>(?:src|href)=["\'])(?P<url>/(?:js|css)/[^"\'?]+\.(?:js|css))(?P<suffix>["\'])'
)


def _version_html(content: bytes, version: str) -> bytes:
    encoded_version = version.encode("ascii", errors="ignore")

    def add_version(match: re.Match[bytes]) -> bytes:
        return (
            match.group("prefix")
            + match.group("url")
            + b"?v="
            + encoded_version
            + match.group("suffix")
        )

    content = ASSET_URL_RE.sub(add_version, content)
    marker = b'<meta name="app-version" content="' + encoded_version + b'">\n'
    marker += f'<meta name="queue-timezone" content="{QUEUE_TIME_ZONE.key}">\n'.encode("ascii")
    return content.replace(b"</head>", marker + b"</head>", 1)


async def release_cache_middleware(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path

    if path == "/system/version":
        response.headers["Cache-Control"] = "no-store"
        return response

    if not path.endswith(".html") or response.status_code != 200:
        return response

    body = b"".join([chunk async for chunk in response.body_iterator])
    body = _version_html(body, get_release_version())
    headers = dict(response.headers)
    headers.pop("content-length", None)
    headers["Cache-Control"] = "no-store"
    return Response(body, status_code=response.status_code, headers=headers)
