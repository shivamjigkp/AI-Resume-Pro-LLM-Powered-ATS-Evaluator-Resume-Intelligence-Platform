"""
gate1/sheets_helper.py
────────────────────────
Reads leads and writes campaign status back using official Google Sheets API v4.
100% Python 3.14 compatible and robust.
"""
import logging
from typing import List, Dict, Tuple
from googleapiclient.discovery import build
from .google_auth import get_credentials

logger = logging.getLogger("Gate1.SheetsHelper")


def _get_sheets_service():
    creds = get_credentials()
    return build('sheets', 'v4', credentials=creds)


def read_lead_rows(sheet_id: str, start_row: int, end_row: int, sheet_tab: str = "Leads") -> Tuple[List[Dict], List[str]]:
    """
    Reads rows [start_row, end_row] inclusive from the Google Sheet.
    Returns (leads_list, headers_lower).
    """
    service = _get_sheets_service()
    
    # Try tab specific first, fallback to generic
    ranges_to_try = [f"{sheet_tab}!A1:Z{end_row}", f"A1:Z{end_row}"]
    values = []
    
    for r in ranges_to_try:
        try:
            resp = service.spreadsheets().values().get(spreadsheetId=sheet_id, range=r).execute()
            values = resp.get("values", [])
            if values:
                break
        except Exception as e:
            logger.debug(f"Failed to fetch range {r}: {e}")

    if not values:
        logger.warning("No values found in sheet %s", sheet_id)
        return [], []

    header = values[0]
    header_lower = [str(h).strip().lower() for h in header]

    def col_val(row_cells, col_name, default=""):
        if col_name in header_lower:
            idx = header_lower.index(col_name)
            if idx < len(row_cells):
                return str(row_cells[idx]).strip()
        return default

    leads = []
    # 1-based row indexing matching sheet row numbers
    for i in range(start_row, min(end_row + 1, len(values) + 1)):
        row_idx = i - 1
        if row_idx >= len(values):
            break
        row_cells = values[row_idx]
        
        email = col_val(row_cells, "email")
        name = col_val(row_cells, "name", "Hiring Team")
        company = col_val(row_cells, "company", "")
        role = col_val(row_cells, "role", "")
        status = col_val(row_cells, "status", "Pending")

        leads.append({
            "row": i,
            "name": name,
            "email": email,
            "company": company,
            "role": role,
            "status": status,
        })

    return leads, header_lower


def update_row_status(sheet_id: str, row_num: int, header_lower: List[str], status: str, note: str = "", sheet_tab: str = "Leads"):
    """Writes back Status to the Google Sheet row."""
    try:
        service = _get_sheets_service()
        # Status is typically Column E (index 4)
        col_letter = "E"
        if "status" in header_lower:
            idx = header_lower.index("status")
            col_letter = chr(65 + idx)
            
        range_name = f"{sheet_tab}!{col_letter}{row_num}"
        body = {"values": [[status]]}
        service.spreadsheets().values().update(
            spreadsheetId=sheet_id,
            range=range_name,
            valueInputOption="RAW",
            body=body
        ).execute()
        logger.info(f"Updated Sheet Row {row_num} Status to '{status}'")
    except Exception as e:
        logger.warning(f"Could not update status for row {row_num}: {e}")