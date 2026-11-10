#!/usr/bin/env python3
import json
import shutil
import subprocess
import sys
from pathlib import Path

from grafana_dashboard import normalize_dashboard_export, write_dashboard_json


PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))
from app.config import QUEUE_TIME_ZONE

DASHBOARD_SOURCE = PROJECT_DIR / "data" / "statistics.json"
DASHBOARD_DESTINATION = Path("/var/lib/grafana/dashboards/queue-statistics.json")
def run_optional(command):
    executable = shutil.which(command[0])
    if not executable:
        return

    subprocess.run([executable, *command[1:]], check=False)


def main():
    if not DASHBOARD_SOURCE.exists():
        print(f"Dashboard source not found: {DASHBOARD_SOURCE}", file=sys.stderr)
        return 1

    with DASHBOARD_SOURCE.open(encoding="utf-8") as file:
        payload = json.load(file)

    dashboard = normalize_dashboard_export(payload)
    dashboard["timezone"] = QUEUE_TIME_ZONE.key
    write_dashboard_json(DASHBOARD_DESTINATION, dashboard)

    run_optional(["chown", "grafana:grafana", str(DASHBOARD_DESTINATION)])
    run_optional(["systemctl", "restart", "grafana-server"])

    print(f"Grafana dashboard synced: {DASHBOARD_DESTINATION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
