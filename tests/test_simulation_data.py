"""Daily extraction and provisional-data safeguards without private fixtures."""
from datetime import date

import pytest

from dashboard_builder.common import BuildError
from dashboard_builder.reference import SERIES, match_columns
from dashboard_builder.simulation import COMPARATOR, comparator_column, daily_rows, verify_currencies


def headers():
    return [["Dates", *[entry[i] for entry in SERIES.values()], COMPARATOR[i]] for i in range(3)]


def export(rows):
    return daily_rows(rows, match_columns(headers()), comparator_column(headers()))


def test_daily_levels_preserve_interior_and_trailing_missing_values():
    rows = [
        [date(2026, 1, 1), None, 200, 1300, 100],
        [date(2026, 1, 2), 100, 201, 1301, 101],
        [date(2026, 1, 5), 0, 202, None, 102],
        [date(2026, 1, 6), 101, float("inf"), 1302, 103],
        [date(2026, 1, 7), 102, 203, 1303, 104],
        [date(2026, 1, 8), None, None, None, None],
    ]
    points, quality = export(reversed(rows))
    assert points == [["2026-01-02", 100, 201, 1301], ["2026-01-05", None, 202, None], ["2026-01-06", 101, None, 1302], ["2026-01-07", 102, 203, 1303], ["2026-01-08", None, None, None]]
    assert quality["asOf"] == "2026-01-08"
    assert quality["lastCommonDate"] == "2026-01-07"
    assert quality["commonDailyRows"] == 2
    assert quality["retainedMissingValues"] == {"equity": 2, "bond": 2, "fx": 2}


def test_duplicate_cache_is_flagged_without_replacement_or_loss_of_early_evidence():
    rows = [[date(2026, 1, 1), None, 200, 1300, 200], [date(2026, 1, 2), 100, 201, 1301, 201], [date(2026, 1, 5), 101, 202, 1302, 202]]
    points, quality = export(rows)
    assert points[0][2] == 201
    assert quality["status"] == "provisional"
    assert quality["code"] == "KBPMABIN_DUPLICATE_CACHE"
    assert quality["duplicateAudit"]["commonObservations"] == 3
    assert quality["duplicateAudit"]["firstDate"] == "2026-01-01"
    rows[-1][-1] = 202.00000000001
    _, quality = export(rows)
    assert quality["duplicateAudit"]["identicalHistory"] is False
    assert quality["status"] == "cache-checked"


def test_unchanged_latest_values_do_not_change_last_value_change():
    _, quality = export([[date(2026, 1, 2), 100, 200, 1300, 200], [date(2026, 1, 5), 100, 200, 1301, 200]])
    assert quality["lastValueChange"] == {"equity": "2026-01-02", "bond": "2026-01-02", "fx": "2026-01-05"}


def test_dates_identity_and_currencies_fail_closed():
    row = [date(2026, 1, 2), 100, 200, 1300, 200]
    with pytest.raises(BuildError, match="duplicate date"):
        export([row, row])
    with pytest.raises(BuildError, match="expected an Excel date"):
        export([["2026-01-02", 100, 200, 1300, 200]])
    with pytest.raises(BuildError, match="no common"):
        export([[date(2026, 1, 2), None, 200, 1300, 200]])
    ambiguous = [r + [r[-1]] for r in headers()]
    with pytest.raises(BuildError, match="found 2"):
        comparator_column(ambiguous)
    columns = match_columns(headers())
    formulas = [None, '=BDH("ACWI INDEX","CURR=USD")', '=BDH("KBPMABIN INDEX","CURR=KRW")']
    verify_currencies(formulas, columns)
    formulas[2] = '=BDH("KBPMABIN INDEX","CURR=USD")'
    with pytest.raises(BuildError, match="currency KRW"):
        verify_currencies(formulas, columns)
    formulas[2] = '=BDH("KBPMABIN INDEX","CURR=KRW","CURR=USD")'
    with pytest.raises(BuildError, match="currency KRW"):
        verify_currencies(formulas, columns)
