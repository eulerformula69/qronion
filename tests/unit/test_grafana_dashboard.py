import json
import subprocess
import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from grafana_dashboard import normalize_dashboard_export  # noqa: E402


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DASHBOARD_PATH = PROJECT_ROOT / "data" / "statistics.json"
NORMALIZER_PATH = PROJECT_ROOT / "scripts" / "normalizeGrafanaDashboard.py"


def _dashboard(**extra):
    return {"panels": [], **extra}


def test_normalizes_plain_and_wrapped_exports():
    plain = normalize_dashboard_export(_dashboard(id=12, uid="random"))
    wrapped = normalize_dashboard_export({"dashboard": _dashboard(), "meta": {"folderId": 1}})

    for result in (plain, wrapped):
        assert result["id"] is None
        assert result["uid"] == "queue-statistics"
        assert result["title"] == "Статистика очереди"
        assert result["version"] == 1
        assert "dashboard" not in result
        assert "meta" not in result


@pytest.mark.parametrize(
    "datasource",
    [
        {"type": "postgres", "uid": "never-seen-before"},
        {"type": "grafana-postgresql-datasource", "uid": "random"},
        {"uid": "cffzz1xb8ay9sa"},
        "Queue PostgreSQL",
        "Some PostgreSQL",
    ],
)
def test_normalizes_postgres_datasource_representations(datasource):
    result = normalize_dashboard_export(_dashboard(datasource=datasource))
    assert result["datasource"] == {
        "type": "grafana-postgresql-datasource",
        "uid": "queue-postgres",
    }


def test_normalizes_datasources_at_arbitrary_depth_without_touching_other_uids():
    payload = _dashboard(
        uid="dashboard-random",
        panels=[
            {
                "uid": "panel-object-uid",
                "datasource": {"type": "postgres", "uid": "panel-source"},
                "targets": [{"datasource": {"type": "postgres", "uid": "target-source"}}],
                "panels": [{"datasource": {"type": "postgres", "uid": "row-source"}}],
                "transformations": [{"options": {"datasource": "Queue PostgreSQL"}}],
            }
        ],
        annotations={"list": [{"datasource": {"type": "postgres", "uid": "annotation-source"}}]},
        templating={
            "list": [
                {
                    "type": "query",
                    "datasource": {"type": "postgres", "uid": "variable-source"},
                    "query": "SELECT 1",
                }
            ]
        },
    )
    result = normalize_dashboard_export(payload)

    assert result["panels"][0]["uid"] == "panel-object-uid"
    serialized = json.dumps(result, ensure_ascii=False)
    for old_uid in ("panel-source", "target-source", "row-source", "annotation-source", "variable-source"):
        assert old_uid not in serialized
    assert serialized.count("queue-postgres") == 6


@pytest.mark.parametrize("special", ["-- Grafana --", "grafana", "mixed", "dashboard"])
def test_does_not_replace_special_grafana_datasources(special):
    result = normalize_dashboard_export(_dashboard(datasource=special))
    assert result["datasource"] == special


@pytest.mark.parametrize("query_object", [{"rawSql": "SELECT 1"}, {"query": "SELECT 2"}])
def test_normalizes_object_query_variables(query_object):
    result = normalize_dashboard_export(
        _dashboard(templating={"list": [{"type": "query", "query": query_object}]})
    )
    variable = result["templating"]["list"][0]
    expected = next(iter(query_object.values()))
    assert variable["query"] == expected
    assert variable["definition"] == expected


def test_preserves_string_query_variable_and_is_idempotent():
    payload = _dashboard(templating={"list": [{"type": "query", "query": "SELECT 1"}]})
    once = normalize_dashboard_export(payload)
    assert once["templating"]["list"][0]["query"] == "SELECT 1"
    assert normalize_dashboard_export(once) == once


def test_removes_unstable_fields_only_from_dashboard_root():
    payload = _dashboard(
        iteration=9, meta={}, folderId=1, folderUid="x", overwrite=True,
        panels=[{"options": {"iteration": 3}}],
    )
    result = normalize_dashboard_export(payload)
    assert not {"iteration", "meta", "folderId", "folderUid", "overwrite"} & result.keys()
    assert result["panels"][0]["options"]["iteration"] == 3


def test_cli_creates_output_file(tmp_path):
    source = tmp_path / "export.json"
    output = tmp_path / "nested" / "statistics.json"
    source.write_text(json.dumps({"dashboard": _dashboard()}), encoding="utf-8")

    process = subprocess.run(
        [sys.executable, str(NORMALIZER_PATH), str(source), str(output)],
        capture_output=True,
    )

    assert process.returncode == 0
    assert json.loads(output.read_text(encoding="utf-8"))["uid"] == "queue-statistics"
    assert output.read_bytes().endswith(b"\n")


def test_cli_invalid_json_does_not_damage_existing_output(tmp_path):
    source = tmp_path / "broken.json"
    output = tmp_path / "statistics.json"
    source.write_text("{broken", encoding="utf-8")
    output.write_text("keep me", encoding="utf-8")

    process = subprocess.run(
        [sys.executable, str(NORMALIZER_PATH), str(source), str(output)],
        capture_output=True,
    )

    assert process.returncode != 0
    assert process.stderr
    assert output.read_text(encoding="utf-8") == "keep me"


def _find_panel(panels, title):
    for panel in panels:
        if panel.get("title") == title:
            return panel
        nested_panel = _find_panel(panel.get("panels", []), title)
        if nested_panel:
            return nested_panel
    return None


def test_suspicious_operator_completions_panel():
    dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
    panel = _find_panel(dashboard["panels"], "Подозрительные завершения операторов")

    assert panel is not None
    assert panel["type"] == "table"

    raw_sql = panel["targets"][0]["rawSql"]
    expected_columns = [
        "operator_name",
        "window_id",
        "window_name",
        "suspicious_count",
        "avg_duration_seconds",
        "min_duration_seconds",
        "max_duration_seconds",
    ]
    for column in expected_columns:
        assert f" AS {column}" in raw_sql

    assert "t.status = 'finished'" in raw_sql
    assert "t.completion_reason = 'completed'" in raw_sql
    assert "t.called_at IS NOT NULL" in raw_sql
    assert "t.finished_at IS NOT NULL" in raw_sql
    assert "$__timeFrom()" in raw_sql
    assert "$__timeTo()" in raw_sql
    assert "(t.finished_at - t.called_at) < INTERVAL '1.5 minutes'" in raw_sql
    assert "operator_aliases AS" not in raw_sql
    assert "COALESCE(NULLIF(btrim(o.name), ''), 'Неизвестно')" in raw_sql
    assert "GROUP BY COALESCE(NULLIF(btrim(o.name), ''), 'Неизвестно')" in raw_sql
    assert "ORDER BY suspicious_count DESC, avg_duration_seconds ASC" in raw_sql


def test_redirected_stages_are_not_problematic_unfinished():
    dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
    panel = _find_panel(dashboard["panels"], "Проблемные незавершения")

    assert panel is not None
    assert panel["type"] == "stat"

    raw_sql = panel["targets"][0]["rawSql"]
    assert "t.completion_reason IS DISTINCT FROM 'redirected'" in raw_sql
    assert "t.completion_reason = 'redirected'" not in raw_sql


def test_redirected_stages_are_reported_as_operator_outcome():
    dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
    panel = _find_panel(dashboard["panels"], "Итог вызовов к операторам")

    assert panel is not None
    assert panel["type"] == "table"

    raw_sql = panel["targets"][0]["rawSql"]
    assert "t.completion_reason = 'redirected'" in raw_sql
    assert "Этап перенаправлен" in raw_sql
    assert 'count(*) AS "Этапов"' in raw_sql


def test_operator_efficiency_is_stage_based():
    dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
    panel = _find_panel(dashboard["panels"], "Закрытие этапов, %")

    assert panel is not None
    assert panel["type"] == "stat"

    raw_sql = panel["targets"][0]["rawSql"]
    assert "closed_stage_percent" in raw_sql
    assert "t.completion_reason IN ('completed', 'redirected')" in raw_sql
    assert "NULLIF(count(*), 0)" in raw_sql


def test_operator_day_status_timeline_panel():
    dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
    panel = _find_panel(dashboard["panels"], "Статусы сотрудников за рабочий день")

    assert panel is not None
    assert panel["type"] == "state-timeline"
    assert panel["targets"][0]["format"] == "table"

    raw_sql = panel["targets"][0]["rawSql"]
    assert "operator_status_periods osp" in raw_sql
    assert "workdays AS" in raw_sql
    assert "day::date + time '08:00'" in raw_sql
    assert "day::date + time '17:00'" in raw_sql
    assert "GREATEST(osp.started_at, workdays.day_start)" in raw_sql
    assert "LEAST(COALESCE(osp.ended_at, workdays.day_end), workdays.day_end)" in raw_sql
    assert "osp.started_at < workdays.day_end" in raw_sql
    assert "COALESCE(osp.ended_at, workdays.day_end) > workdays.day_start" in raw_sql
    assert "osp.operator_id::text IN (${operator_id:sqlstring})" in raw_sql
    assert 'period_end AS "timeEnd"' in raw_sql
    assert 'period_start AS "time"' in raw_sql
    assert "WHEN 'offline' THEN 0" in raw_sql
    assert "WHEN 'online' THEN 1" in raw_sql
    assert "WHEN 'break' THEN 2" in raw_sql


def test_dashboard_percentile_and_operator_filter_are_variable_based():
    dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
    variables = {item["name"]: item for item in dashboard["templating"]["list"]}

    assert "percentile" in variables
    assert variables["operator_id"]["query"].startswith(
        "SELECT COALESCE(NULLIF(btrim(name), ''), 'Неизвестно') AS __text"
    )

    raw_sql_values = []

    def collect_raw_sql(panels):
        for panel in panels:
            raw_sql_values.extend(
                target["rawSql"]
                for target in panel.get("targets", [])
                if "rawSql" in target
            )
            collect_raw_sql(panel.get("panels", []))

    collect_raw_sql(dashboard["panels"])
    raw_sql = "\n".join(raw_sql_values)

    assert "percentile_cont(0.9)" not in raw_sql
    assert "percentile_cont((${percentile:raw}::numeric / 100.0))" in raw_sql
    assert "${operator_name:sqlstring}" not in raw_sql
    assert "o.name IN" not in raw_sql
    assert "o.id::text IN (${operator_id:sqlstring})" in raw_sql
    assert "operator_aliases AS" not in raw_sql
    assert "'Сотрудник ' || row_number()" not in raw_sql
