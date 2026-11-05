"""Daily correlation export invariants and checked-in source snapshot sanity."""

import json
from datetime import date
from pathlib import Path

import pytest

from dashboard_builder.common import BuildError
from dashboard_builder.correlation import SERIES, daily_rows, match_columns, verify_currencies


def headers():
    return [["Dates", *[identity[row] for identity in SERIES.values()]] for row in range(3)]


def row(stamp, values):
    return [stamp, *values]


def test_exact_header_match_rejects_proxy_missing_and_duplicate_series():
    assert match_columns(headers()) == {key: index + 1 for index, key in enumerate(SERIES)}
    for position, replacement in [(0, "ACWI_PR"), (1, "ACWI_PROXY INDEX"), (2, "PX_LAST")]:
        wrong = headers()
        wrong[position][1] = replacement
        with pytest.raises(BuildError, match="exactly one ACWI_TR"):
            match_columns(wrong)
    with pytest.raises(BuildError, match="found 2"):
        match_columns([values + [values[1]] for values in headers()])
    with pytest.raises(BuildError, match="header rows"):
        match_columns(headers()[:2])


def test_currency_requires_bdh_override_and_normalizes_case():
    formulas = [None, *[f'=_xll.BDH(A1,A2,"CURR={identity[3].lower()}")' for identity in SERIES.values()]]
    columns = match_columns(headers())
    verify_currencies(formulas, columns)
    for invalid in [None, 100, '=100', '=SUM(1,"CURR=USD")', '=_xll.BDH(A1,A2,"CURR=KRW")', '=_xll.BDH(A1,A2,"CURR=USD","CURR=USD")']:
        wrong = formulas[:]
        wrong[1] = invalid
        with pytest.raises(BuildError, match="expected BDH currency USD"):
            verify_currencies(wrong, columns)


def test_daily_levels_keep_internal_nulls_and_unchanged_dates():
    rows = [
        row(date(2026, 1, 1), [None] * len(SERIES)),
        row(date(2026, 1, 2), [100] * len(SERIES)),
        row(date(2026, 1, 5), [None, 0, -1, float("nan"), float("inf")]),
        row(date(2026, 1, 6), [110] * len(SERIES)),
        row(date(2026, 1, 7), [110] * len(SERIES)),
        row(date(2026, 1, 8), [None] * len(SERIES)),
    ]
    points, quality = daily_rows(reversed(rows), match_columns(headers()))
    for key in SERIES:
        assert points[key] == [["2026-01-02", 100], ["2026-01-05", None], ["2026-01-06", 110], ["2026-01-07", 110]]
        assert quality["series"][key]["internalMissingObservations"] == 1
        assert quality["series"][key]["invalidOrMissingValues"] == 3
        assert quality["series"][key]["lastValueChange"] == "2026-01-06"
    assert quality["asOf"] == "2026-01-08"
    assert quality["datedRows"] == 6


@pytest.mark.parametrize("missing", [None, 0, -1, float("nan"), float("inf"), "#N/A N/A", True])
def test_nonpositive_nonfinite_and_non_numeric_levels_become_null(missing):
    rows = [row(date(2026, 1, 2), [100] * len(SERIES)), row(date(2026, 1, 5), [missing] * len(SERIES)), row(date(2026, 1, 6), [101] * len(SERIES))]
    points, _ = daily_rows(rows, match_columns(headers()))
    assert all(points[key][1] == ["2026-01-05", None] for key in SERIES)


def test_duplicate_missing_invalid_dates_and_empty_series_fail():
    columns = match_columns(headers())
    valid = row(date(2026, 1, 2), [100] * len(SERIES))
    with pytest.raises(BuildError, match="duplicate date"):
        daily_rows([valid, valid], columns)
    for stamp in [None, "2026-01-02", 46024]:
        with pytest.raises(BuildError, match="expected an Excel date"):
            daily_rows([row(stamp, [100] * len(SERIES))], columns)
    with pytest.raises(BuildError, match="no positive observations for ACWI_TR"):
        daily_rows([row(date(2026, 1, 2), [None, *([100] * (len(SERIES) - 1))])], columns)
    with pytest.raises(BuildError, match="no dated observations"):
        daily_rows([[None] * (len(SERIES) + 1)], columns)


def test_pinned_snapshot_preserves_source_identity_dates_and_levels():
    root = Path(__file__).resolve().parents[1]
    snapshot = root / "template/platform/correlation-data.json"
    assert snapshot.read_bytes() == (root / "docs/platform/correlation-data.json").read_bytes()
    data = json.loads(snapshot.read_text())
    assert data["schemaVersion"] == 1
    assert data["source"]["asOf"] == "2026-11-05"
    assert data["source"]["sha256"] == "a8bb9c01041baa4da150063895e447406c02d6caaecff89e049e3b9823b8a44e"
    assert data["source"]["quality"]["datedRows"] == 6505
    series = {item["id"]: item for item in data["series"]}
    assert list(series) == list(SERIES)
    for key, identity in SERIES.items():
        item = series[key]
        assert [item["label"], item["ticker"], item["field"], item["currency"]] == list(identity)
        dates = [point[0] for point in item["observations"]]
        assert dates == sorted(set(dates))
        assert item["observations"][-1][0] == "2026-11-05"
        assert all(point[1] is None or point[1] > 0 for point in item["observations"])
    assert series["ACWI_TR"]["column"] == "GA"
    assert len(series["ACWI_TR"]["observations"]) == 4855
    assert series["ACWI_TR"]["observations"][0] == ["2008-03-28", 50.1]
    assert series["ACWI_TR"]["observations"][-1] == ["2026-11-05", 225.4399]
    assert series["LEGATRUU"]["column"] == "GC"
    assert len(series["LEGATRUU"]["observations"]) == 6505
    assert series["LEGATRUU"]["observations"][-1] == ["2026-11-05", 496.7026]
    assert "LBUSTRUU" not in series and "KBPMABIN" not in series
    exclusion = data["source"]["quality"]["exclusions"][0]
    assert exclusion["ids"] == ["LBUSTRUU", "KBPMABIN"]
    assert exclusion["commonObservations"] == 6504
