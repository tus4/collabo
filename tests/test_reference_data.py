"""Data extraction invariants without depending on private workbook contents."""

from datetime import date

import pytest

from dashboard_builder.common import BuildError
from dashboard_builder.reference import SERIES, endpoint_rows, match_columns


def headers():
    return [["Dates", *[entry[row] for entry in SERIES.values()]] for row in range(3)]


def test_exact_header_identity_rejects_price_index_proxy_and_ambiguity():
    assert match_columns(headers()) == {"equity": 1, "bond": 2, "fx": 3}
    old_equity = headers()
    old_equity[0][1] = "미국_S&P500_TR"
    old_equity[1][1] = "SPX INDEX"
    with pytest.raises(BuildError, match="ACWI_TR / ACWI INDEX"):
        match_columns(old_equity)
    wrong = headers()
    wrong[2][1] = "PX_LAST"
    with pytest.raises(BuildError, match="exactly one"):
        match_columns(wrong)
    repeated = [row + [row[1]] for row in headers()]
    with pytest.raises(BuildError, match="found 2"):
        match_columns(repeated)


def test_endpoint_union_preserves_fx_missing_local_endpoint_and_partial_month():
    rows = [
        [date(2026, 8, 31), 100, 200, 1300],
        [date(2026, 9, 29), 101, 201, 1310],
        [date(2026, 9, 30), 102, 202, None],
        [date(2026, 10, 28), 103, 203, 1320],
    ]
    points, quality = endpoint_rows(rows, match_columns(headers()))
    assert [point[0] for point in points] == ["2026-08-31", "2026-09-29", "2026-09-30", "2026-10-28"]
    assert points[2][-1] is None
    assert quality["asOf"] == "2026-10-28"
    assert quality["commonDailyRows"] == 4
    assert quality["fxCommonDailyRows"] == 3


def test_missing_and_invalid_values_are_not_zero_returns_or_filled_months():
    rows = [
        [date(2026, 6, 30), 100, None, 1300],
        [date(2026, 7, 31), 100, 200, 1300],
        [date(2026, 8, 31), 0, 201, 1310],
        [date(2026, 9, 29), 103, float("inf"), 1320],
        [date(2026, 9, 30), 104, 204, 1330],
    ]
    points, quality = endpoint_rows(rows, match_columns(headers()))
    assert [point[0] for point in points] == ["2026-07-31", "2026-09-30"]
    assert quality["invalidOrMissingValues"] == {"equity": 1, "bond": 2, "fx": 0}
    assert quality["firstCommonDate"] == "2026-07-31"


def test_duplicate_and_invalid_dates_fail_before_export():
    row = [date(2026, 9, 30), 100, 200, 1300]
    with pytest.raises(BuildError, match="duplicate date"):
        endpoint_rows([row, row], match_columns(headers()))
    with pytest.raises(BuildError, match="expected an Excel date"):
        endpoint_rows([["2026-09-30", 100, 200, 1300]], match_columns(headers()))


def test_sorting_and_latest_unchanged_observation_are_preserved():
    rows = [[date(2026, 9, 30), 101, 202, 1310], [date(2026, 8, 31), 101, 202, 1300]]
    points, quality = endpoint_rows(rows, match_columns(headers()))
    assert points[-1] == ["2026-09-30", 101, 202, 1310]
    assert quality["lastValueChange"] == {"equity": "2026-08-31", "bond": "2026-08-31", "fx": "2026-09-30"}
