"""Export selected daily total-return indices for the Correlation time series.

Refresh this snapshot explicitly from data_git/data_bb.xlsx. The regular site
builder copies the checked-in JSON and never publishes the source workbook.

LBUSTRUU and KBPMABIN are excluded: the 2026-11-05 source cache contains
identical levels for all 6,504 common dates despite distinct Bloomberg headers.
Keep both out of the new comparison until the source discrepancy is resolved.
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


# label, Bloomberg ticker, field and BDH currency must all match the source.
SERIES = {
    "ACWI_TR": ("ACWI_TR", "ACWI INDEX", "TOT_RETURN_INDEX_GROSS_DVDS", "USD"),
    "LEGATRUU": ("Globa_Bond_Unhedged", "LEGATRUU Index", "TOT_RETURN_INDEX_GROSS_DVDS", "USD"),
    "LEGATRUH": ("Globa_Bond_Hedged", "LEGATRUH Index", "TOT_RETURN_INDEX_GROSS_DVDS", "USD"),
    "S&P500_TR": ("미국_S&P500_TR", "SPX INDEX", "TOT_RETURN_INDEX_GROSS_DVDS", "USD"),
    "KOSPI_TR": ("한국_KOSPI_TR", "KOSPI INDEX", "TOT_RETURN_INDEX_GROSS_DVDS", "KRW"),
}
EXCLUSIONS = [{
    "ids": ["LBUSTRUU", "KBPMABIN"],
    "columns": ["HJ", "HK"],
    "reason": "identical cached source levels under distinct Bloomberg headers",
    "observedAsOf": "2026-11-05",
    "commonObservations": 6504,
    "sourceSha256": "a8bb9c01041baa4da150063895e447406c02d6caaecff89e049e3b9823b8a44e",
}]
HEADER_ROW = 7
FIRST_DATA_ROW = 10


def match_columns(headers: Sequence[Sequence[Any]]) -> dict[str, int]:
    """Match all three headers exactly, rejecting proxies and duplicate matches."""
    if len(headers) != 3:
        raise BuildError("D: expected label/ticker/field header rows 7–9")
    width = max(map(len, headers))
    columns = {}
    for key, identity in SERIES.items():
        matches = [
            col for col in range(width)
            if tuple(str(row[col]).strip() if col < len(row) and row[col] is not None else "" for row in headers) == identity[:3]
        ]
        if len(matches) != 1:
            raise BuildError(f"D: expected exactly one {key} / {identity[1]} / {identity[2]}; found {len(matches)}")
        columns[key] = matches[0]
    return columns


def verify_currencies(formula_row: Sequence[Any], columns: dict[str, int]) -> None:
    """Require the source BDH override rather than inferring currency from ticker."""
    for key, column in columns.items():
        formula = formula_row[column] if column < len(formula_row) else None
        currencies = re.findall(r'"CURR=([A-Z]{3})"', formula, flags=re.IGNORECASE) if isinstance(formula, str) else []
        is_bdh = isinstance(formula, str) and re.match(r"^=(?:_xll\.)?BDH\(", formula, flags=re.IGNORECASE)
        if not is_bdh or len(currencies) != 1 or currencies[0].upper() != SERIES[key][3]:
            raise BuildError(f"D!{get_column_letter(column + 1)}10: expected BDH currency {SERIES[key][3]} for {key}")


def positive(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def daily_rows(rows: Iterable[Sequence[Any]], columns: dict[str, int]) -> tuple[dict[str, list[list[Any]]], dict[str, Any]]:
    """Retain dated missing values and unchanged levels without forward-filling."""
    seen = set()
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
        ordered.append((iso, [value if positive(value) else None for value in values]))
    ordered.sort()
    if not ordered:
        raise BuildError("D: no dated observations")
    points, series_quality = {}, {}
    for index, key in enumerate(SERIES):
        valid = [position for position, (_, values) in enumerate(ordered) if values[index] is not None]
        if not valid:
            raise BuildError(f"D: no positive observations for {key}")
        start, end = valid[0], valid[-1]
        points[key] = [[iso, values[index]] for iso, values in ordered[start:end + 1]]
        previous = None
        changed = None
        for iso, value in points[key]:
            if value is not None:
                if value != previous:
                    changed = iso
                previous = value
        series_quality[key] = {
            "firstDate": points[key][0][0],
            "lastDate": points[key][-1][0],
            "validObservations": len(valid),
            "internalMissingObservations": len(points[key]) - len(valid),
            "invalidOrMissingValues": len(ordered) - len(valid),
            "lastValueChange": changed,
        }
    return points, {"asOf": ordered[-1][0], "datedRows": len(ordered), "series": series_quality}


def extract(workbook: Path, source_url: str, modified_time: str) -> dict[str, Any]:
    if not workbook.is_file():
        raise BuildError(f"workbook not found: {workbook}")
    cached = load_workbook(workbook, read_only=True, data_only=True)
    try:
        if "D" not in cached.sheetnames:
            raise BuildError("required sheet D not found")
        sheet = cached["D"]
        headers = list(sheet.iter_rows(min_row=HEADER_ROW, max_row=HEADER_ROW + 2, values_only=True))
        columns = match_columns(headers)
        observations, quality = daily_rows(sheet.iter_rows(min_row=FIRST_DATA_ROW, values_only=True), columns)
        quality["exclusions"] = EXCLUSIONS
    finally:
        cached.close()
    formulas = load_workbook(workbook, read_only=True, data_only=False)
    try:
        row = next(formulas["D"].iter_rows(min_row=FIRST_DATA_ROW, max_row=FIRST_DATA_ROW, values_only=True))
        verify_currencies(row, columns)
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
            "frequency": "daily source observations; missing values retained; no forward fill",
            "quality": quality,
        },
        "series": [
            {
                "id": key,
                "label": identity[0],
                "ticker": identity[1],
                "field": identity[2],
                "currency": identity[3],
                "column": get_column_letter(columns[key] + 1),
                "observations": observations[key],
            }
            for key, identity in SERIES.items()
        ],
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
        print(f"correlation snapshot: {len(data['series'])} series, {data['source']['quality']['datedRows']} dated rows, source as of {data['source']['asOf']}")
        return 0
    except (BuildError, OSError, ValueError) as error:
        print(f"correlation export failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
