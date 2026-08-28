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
    Uses intelligent fuzzy header matching so headers like 'Company Name', 'Email Address', 'Recruiter Name' work 100%.
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

    def find_col_idx(patterns: List[str]) -> int:
        for p in patterns:
            for idx, h in enumerate(header_lower):
                if p == h or (len(p) > 2 and p in h):
                    return idx
        return -1

    email_idx = find_col_idx(["email", "email address", "e-mail", "recruiter email", "contact email", "mail"])
    name_idx = find_col_idx(["recruiter name", "recruiter_name", "name", "contact name", "hr name", "person", "contact"])
    company_idx = find_col_idx(["company name", "company_name", "company", "organization", "firm", "startup", "comp"])
    role_idx = find_col_idx(["role", "job title", "position", "job role", "profile", "job", "title"])
    status_idx = find_col_idx(["status", "email status", "campaign status", "outreach status", "state"])

    # Fallback to column positions if headers didn't match
    if email_idx == -1: email_idx = 1 if len(header_lower) > 1 else 0
    if company_idx == -1: company_idx = 2 if len(header_lower) > 2 else -1
    if role_idx == -1: role_idx = 3 if len(header_lower) > 3 else -1
    if status_idx == -1: status_idx = 4 if len(header_lower) > 4 else -1

    leads = []
    # 1-based row indexing matching sheet row numbers
    for i in range(start_row, min(end_row + 1, len(values) + 1)):
        row_idx = i - 1
        if row_idx >= len(values):
            break
        row_cells = values[row_idx]

        def get_val(idx, default=""):
            if idx >= 0 and idx < len(row_cells):
                val = str(row_cells[idx]).strip()
                return val if val else default
            return default

        email = get_val(email_idx)
        name = get_val(name_idx, "Hiring Team")
        company = get_val(company_idx, "")
        role = get_val(role_idx, "")
        status = get_val(status_idx, "Pending")

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