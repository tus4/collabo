"""Export daily ACWI_TR / KBPMABIN / USDKRW levels for correlation simulation.

The cached KBPMABIN column is retained under its exact source identity, never
replaced by a proxy. An explicit audit compares its cache with LBUSTRUU and
marks an identical history as provisional. This is not Bloomberg verification.
The source workbook remains outside the public repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from .common import BuildError
from .reference import FIRST_DATA_ROW, HEADER_ROW, SERIES, match_columns, positive


COMPARATOR = ("미국종합", "LBUSTRUU INDEX", "TOT_RETURN_INDEX_GROSS_DVDS")


def comparator_column(headers: Sequence[Sequence[Any]]) -> int:
    """Require the distinct comparator headers instead of a fixed column number."""
    if len(headers) != 3:
        raise BuildError("D: expected three Bloomberg header rows")
    matches = [
        col for col in range(max(map(len, headers)))
        if tuple(str(row[col]).strip() if col < len(row) and row[col] is not None else "" for row in headers) == COMPARATOR
    ]
    if len(matches) != 1:
        raise BuildError(f"D: expected exactly one LBUSTRUU audit comparator; found {len(matches)}")
    return matches[0]


def verify_currencies(formulas: Sequence[Any], columns: dict[str, int]) -> None:
    for key in ("equity", "bond"):
        formula = formulas[columns[key]] if columns[key] < len(formulas) else None
        currencies = re.findall(r'"CURR=([A-Z]{3})"', formula or "") if isinstance(formula, str) else []
        is_bdh = isinstance(formula, str) and re.match(r"^=(?:_xll\.)?BDH\(", formula, re.IGNORECASE)
        if not is_bdh or currencies != [SERIES[key][3]]:
            raise BuildError(f"D!{get_column_letter(columns[key] + 1)}10: expected BDH currency {SERIES[key][3]} for {key}")


def daily_rows(rows: Iterable[Sequence[Any]], columns: dict[str, int], comparator: int) -> tuple[list[list[Any]], dict[str, Any]]:
    """Preserve every dated row after the first common positive asset observation.

    Interior and trailing invalid values remain null; there is no forward fill
    or intersection deletion. Duplicate-cache audit uses all source dates,
    including those before the two selected assets have common observations.
    """
    ordered, seen = [], set()
    invalid = {key: 0 for key in SERIES}
    changed = {key: None for key in SERIES}
    previous = {key: None for key in SERIES}
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
        raw = [row[columns[key]] if columns[key] < len(row) else None for key in SERIES]
        values = [value if positive(value) else None for value in raw]
        compare = row[comparator] if comparator < len(row) else None
        ordered.append((iso, values, compare if positive(compare) else None))
    ordered.sort(key=lambda item: item[0])
    if not ordered:
        raise BuildError("D: no dated observations")

    observations, first_common, last_common = [], None, None
    common_count = fx_common_count = audit_common = audit_equal = 0
    audit_first = audit_last = None
    for iso, values, compare in ordered:
        for key, value in zip(SERIES, values):
            if value is None:
                invalid[key] += 1
            else:
                if value != previous[key]:
                    changed[key] = iso
                previous[key] = value
        equity, bond, fx = values
        if bond is not None and compare is not None:
            audit_common += 1
            audit_equal += bond == compare
            audit_first = audit_first or iso
            audit_last = iso
        if equity is not None and bond is not None:
            first_common = first_common or iso
            last_common = iso
            common_count += 1
            fx_common_count += fx is not None
        if first_common is not None:
            observations.append([iso, *values])
    if first_common is None:
        raise BuildError("D: no common positive ACWI_TR and KBPMABIN observations")
    identical = audit_common >= 2 and audit_equal == audit_common
    audit = {
        "series": "KBPMABIN",
        "column": get_column_letter(columns["bond"] + 1),
        "comparator": "LBUSTRUU",
        "comparatorTicker": COMPARATOR[1],
        "comparatorColumn": get_column_letter(comparator + 1),
        "commonObservations": audit_common,
        "identicalObservations": audit_equal,
        "firstDate": audit_first,
        "lastDate": audit_last,
        "identicalHistory": identical,
    }
    return observations, {
        "status": "provisional" if identical else "cache-checked",
        "code": "KBPMABIN_DUPLICATE_CACHE" if identical else "CACHE_ONLY_NOT_PROVIDER_VERIFIED",
        "reason": "KBPMABIN and LBUSTRUU cached levels are identical under distinct Bloomberg headers" if identical else "Cached levels checked; Bloomberg source identity not independently verified",
        "asOf": ordered[-1][0],
        "firstCommonDate": first_common,
        "lastCommonDate": last_common,
        "lastValueChange": changed,
        "datedRows": len(ordered),
        "retainedRows": len(observations),
        "commonDailyRows": common_count,
        "fxCommonDailyRows": fx_common_count,
        "invalidOrMissingValues": invalid,
        "retainedMissingValues": {key: sum(row[i + 1] is None for row in observations) for i, key in enumerate(SERIES)},
        "duplicateAudit": audit,
    }


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
        observations, quality = daily_rows(sheet.iter_rows(min_row=FIRST_DATA_ROW, values_only=True), columns, comparator_column(headers))
    finally:
        cached.close()
    formulas = load_workbook(workbook, read_only=True, data_only=False)
    try:
        verify_currencies(next(formulas["D"].iter_rows(min_row=FIRST_DATA_ROW, max_row=FIRST_DATA_ROW, values_only=True)), columns)
    finally:
        formulas.close()
    return {
        "schemaVersion": 1,
        "source": {
            "file": workbook.name, "sheet": "D", "asOf": quality["asOf"],
            "url": source_url, "modifiedTime": modified_time,
            "sha256": hashlib.sha256(workbook.read_bytes()).hexdigest(),
            "frequency": "daily source levels; dated gaps retained; no forward fill",
            "series": {
                key: {"label": value[0], "ticker": value[1], "field": value[2], "currency": value[3], "column": get_column_letter(columns[key] + 1)}
                for key, value in SERIES.items()
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
        print(f"simulation snapshot: {len(data['observations'])} daily rows; {data['source']['quality']['status']}; as of {data['source']['asOf']}")
        return 0
    except (BuildError, OSError, ValueError) as error:
        print(f"simulation export failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
