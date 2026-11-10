#!/usr/bin/env python3
"""CLI for converting a Grafana export into the repository format."""

import argparse
import json
import sys
from pathlib import Path

from grafana_dashboard import normalize_dashboard_export, write_dashboard_json


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Нормализовать экспорт дашборда Grafana")
    parser.add_argument("input", type=Path, help="входной JSON-файл")
    parser.add_argument("output", type=Path, nargs="?", help="выходной файл (по умолчанию входной)")
    parser.add_argument("--installation", action="store_true", help="Применить часовой пояс из main.env")
    args = parser.parse_args(argv)
    output = args.output or args.input

    if not args.input.is_file():
        print(f"Ошибка: входной файл не найден: {args.input}", file=sys.stderr)
        return 1
    try:
        with args.input.open(encoding="utf-8") as file:
            payload = json.load(file)
        if not isinstance(payload, dict):
            raise ValueError("корневое значение JSON должно быть объектом")
        dashboard = normalize_dashboard_export(payload)
        if args.installation:
            sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
            from app.config import QUEUE_TIME_ZONE
            dashboard["timezone"] = QUEUE_TIME_ZONE.key
        write_dashboard_json(output, dashboard)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
        print(f"Ошибка нормализации: {error}", file=sys.stderr)
        return 1

    print(f"Дашборд нормализован: {output.resolve()}")
    print("UID дашборда: queue-statistics; datasource: queue-postgres")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
