"""
gate1/sheets_helper.py
────────────────────────
Reads leads and writes campaign status back to the user's Google Sheet
("Lead Tracker"), used as the source of truth for who to email.

EXPECTED SHEET SCHEMA (row 1 = header, case-insensitive):
  Name | Email | Company | Role | Status | Notes

  - Name, Email are required per lead row.
  - Company, Role are used for template personalization (and role-based
    template selection — see gate1/template_loader.py).
  - Status / Notes are written back by the campaign engine after each attempt
    (e.g. "Sent", "Drafted", "Failed"). Rows already marked Sent/Drafted are
    skipped on subsequent runs so leads never get emailed twice by accident.
    If your sheet doesn't have Status/Notes columns yet, add them — the
    engine will simply skip writing back if they're missing, but re-runs
    won't be able to dedupe without them.
"""
import logging
from typing import List, Dict, Tuple
import gspread
from .google_auth import get_credentials

logger = logging.getLogger("Gate1.Sheets")

_ws_cache = {}


def _get_worksheet(sheet_id: str, worksheet_index: int = 0):
    cache_key = (sheet_id, worksheet_index)
    if cache_key in _ws_cache:
        return _ws_cache[cache_key]
    creds = get_credentials()
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(sheet_id)
    ws = sh.get_worksheet(worksheet_index)
    _ws_cache[cache_key] = ws
    return ws


def read_lead_rows(sheet_id: str, start_row: int, end_row: int) -> Tuple[List[Dict], List[str]]:
    """
    Reads rows [start_row, end_row] (1-indexed, matching the sheet's own row numbers).
    Returns (leads, header_lower) where each lead dict has lowercase header keys
    plus a '_row_num' key for writing status back later.
    """
    if start_row < 2:
        start_row = 2  # never touch the header row

    ws = _get_worksheet(sheet_id)
    header = ws.row_values(1)
    header_lower = [h.strip().lower() for h in header]

    raw_rows = ws.get(f"A{start_row}:Z{end_row}")

    leads = []
    for i, row in enumerate(raw_rows):
        row_num = start_row + i
        if not row or not any(str(c).strip() for c in row):
            continue
        data = {}
        for idx, col_name in enumerate(header_lower):
            data[col_name] = row[idx] if idx < len(row) else ""
        data["_row_num"] = row_num
        leads.append(data)

    return leads, header_lower


def update_row_status(sheet_id: str, row_num: int, header_lower: List[str], status: str, note: str = ""):
    """Writes back Status (and Notes, if present) for a given row. No-op if columns are missing."""
    ws = _get_worksheet(sheet_id)

    if "status" not in header_lower:
        logger.warning("Sheet has no 'Status' column — skipping status write-back for row %s", row_num)
        return
    status_col = header_lower.index("status") + 1
    try:
        ws.update_cell(row_num, status_col, status)
    except Exception as e:
        logger.error(f"Failed to write Status for row {row_num}: {e}")

    if note and "notes" in header_lower:
        notes_col = header_lower.index("notes") + 1
        try:
            ws.update_cell(row_num, notes_col, note[:300])
        except Exception as e:
            logger.error(f"Failed to write Notes for row {row_num}: {e}")
