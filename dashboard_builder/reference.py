"""Export the requested reference-portfolio series, never the whole workbook.

This is a separate, explicit refresh command. The normal site builder copies the
checked-in snapshot with the other platform assets and does not fetch Drive.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from .common import BuildError


SERIES = {
    "equity": ("미국_S&P500_TR", "SPX INDEX", "TOT_RETURN_INDEX_GROSS_DVDS", "USD"),
    "bond": ("한국종합", "KBPMABIN INDEX", "TOT_RETURN_INDEX_GROSS_DVDS", "KRW"),
    "fx": ("달러원", "USDKRW CURNCY", "PX_LAST", "KRW/USD"),
}
HEADER_ROW = 7
FIRST_DATA_ROW = 10


def match_columns(headers: Sequence[Sequence[Any]]) -> dict[str, int]:
    """Match label, Bloomberg ticker and field together; never choose a proxy."""
    if len(headers) != 3:
        raise BuildError("D: expected label/ticker/field header rows 7–9")
    width = max(map(len, headers))
    result = {}
    for key, (label, ticker, field, _) in SERIES.items():
        expected = (label, ticker, field)
        matches = [
            col for col in range(width)
            if tuple(str(row[col]).strip() if col < len(row) and row[col] is not None else "" for row in headers) == expected
        ]
        if len(matches) != 1:
            raise BuildError(f"D: expected exactly one {label} / {ticker} / {field}; found {len(matches)}")
        result[key] = matches[0]
    return result


def positive(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def endpoint_rows(rows: Iterable[Sequence[Any]], columns: dict[str, int]) -> tuple[list[list[Any]], dict[str, Any]]:
    """Keep the union of local and KRW common-date month-end observations.

    If FX is unavailable on a local endpoint, keep that endpoint and the month's
    last FX-valid endpoint. This is sufficient to reproduce either basis from
    daily data without filling missing dates or publishing all daily levels.
    """
    seen = set()
    local, krw = {}, {}
    dated_count = common_count = fx_common_count = 0
    invalid = {key: 0 for key in SERIES}
    first_common = as_of = None
    previous = {key: None for key in SERIES}
    changed = {key: None for key in SERIES}
    ordered = []
    for row_number, row in enumerate(rows, FIRST_DATA_ROW):
        if not row or all(value is None for value in row):
            continue
        stamp = row[0]
        if not isinstance(stamp, (date, datetime)):
            raise BuildError(f"D!A{row_number}: expected an Excel date, found {stamp!r}")
        stamp = stamp.date() if isinstance(stamp, datetime) else stamp
        iso = stamp.isoformat()
        if iso in seen:
            raise BuildError(f"D!A{row_number}: duplicate date {iso}")
        seen.add(iso)
        values = [row[columns[key]] if columns[key] < len(row) else None for key in SERIES]
        ordered.append((iso, values))
    for iso, values in sorted(ordered):
        dated_count += 1
        as_of = iso
        for key, value in zip(SERIES, values):
            if not positive(value):
                invalid[key] += 1
            else:
                if previous[key] != value:
                    changed[key] = iso
                previous[key] = value
        equity, bond, fx = values
        if not positive(equity) or not positive(bond):
            continue
        common_count += 1
        first_common = first_common or iso
        item = [iso, equity, bond, fx if positive(fx) else None]
        local[iso[:7]] = item
        if positive(fx):
            fx_common_count += 1
            krw[iso[:7]] = item
    if not local:
        raise BuildError("D: no common positive equity and bond observations")
    endpoints = {row[0]: row for row in [*local.values(), *krw.values()]}
    return [endpoints[key] for key in sorted(endpoints)], {
        "asOf": as_of,
        "firstCommonDate": first_common,
        "lastCommonDate": max(endpoints),
        "lastValueChange": changed,
        "datedRows": dated_count,
        "commonDailyRows": common_count,
        "fxCommonDailyRows": fx_common_count,
        "invalidOrMissingValues": invalid,
        "localEndpointMonths": len(local),
        "krwEndpointMonths": len(krw),
    }


def extract(workbook: Path, source_url: str, modified_time: str) -> dict[str, Any]:
    """Read cached Bloomberg observations and verify the selected index currencies."""
    if not workbook.is_file():
        raise BuildError(f"workbook not found: {workbook}")
    cached = load_workbook(workbook, read_only=True, data_only=True)
    try:
        if "D" not in cached.sheetnames:
            raise BuildError("required sheet D not found")
        sheet = cached["D"]
        headers = list(sheet.iter_rows(min_row=HEADER_ROW, max_row=HEADER_ROW + 2, values_only=True))
        columns = match_columns(headers)
        observations, quality = endpoint_rows(sheet.iter_rows(min_row=FIRST_DATA_ROW, values_only=True), columns)
    finally:
        cached.close()
    formulas = load_workbook(workbook, read_only=True, data_only=False)
    try:
        row = next(formulas["D"].iter_rows(min_row=FIRST_DATA_ROW, max_row=FIRST_DATA_ROW, values_only=True))
        for key in ("equity", "bond"):
            formula = row[columns[key]]
            currency = re.search(r'"CURR=([A-Z]{3})"', formula or "") if isinstance(formula, str) else None
            if not currency or currency.group(1) != SERIES[key][3]:
                raise BuildError(f"D!{get_column_letter(columns[key] + 1)}10: expected BDH currency {SERIES[key][3]}")
    finally:
        formulas.close()
    return {
        "schemaVersion": 1,
        "source": {
            "file": workbook.name,
            "sheet": "D",
            "asOf": quality["asOf"],
            "url": source_url,
            "modifiedTime": modified_time,
            "sha256": hashlib.sha256(workbook.read_bytes()).hexdigest(),
            "frequency": "common-date monthly endpoints including latest partial month",
            "series": {
                key: {"label": values[0], "ticker": values[1], "field": values[2], "currency": values[3], "column": get_column_letter(columns[key] + 1)}
                for key, values in SERIES.items()
            },
            "quality": quality,
        },
        "observations": observations,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--modified-time", required=True)
    args = parser.parse_args(argv)
    try:
        data = extract(args.workbook, args.source_url, args.modified_time)
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_name(args.output.name + ".tmp")
        temporary.write_text(payload, encoding="utf-8")
        temporary.replace(args.output)
        print(f"reference snapshot: {len(data['observations'])} endpoints, source as of {data['source']['asOf']}")
        return 0
    except (BuildError, OSError, ValueError) as error:
        print(f"reference export failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
