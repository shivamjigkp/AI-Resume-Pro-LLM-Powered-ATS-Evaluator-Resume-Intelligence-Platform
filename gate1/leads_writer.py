"""
gate1/leads_writer.py
────────────────────────
Creates new Google Sheet lead lists and appends leads to existing ones.
Used by:
  - Gate 2 (Lead Discovery) — "Create New Lead Sheet" / "Add Selected Leads
    to Existing Sheet" (server.py: /api/gate2/save-leads)
  - Gate 1's "Lead Source / Google Sheet" panel — "create a new blank lead
    sheet" action (server.py: /api/gate1/sheets/create)

Lead schema written to every sheet (row 1 header, in this exact order):
  Name | Email | Company | Role | Status | Notes

This matches gate1/sheets_helper.py's expected schema, so any sheet created
or updated here is immediately usable by the Gate 1 outreach campaign
engine without further setup.

Dedup rule when appending leads to an existing sheet:
  - Primary key: email (case-insensitive, trimmed), when present.
  - Fallback key (email missing): Name + Company + Role (case-insensitive,
    trimmed).
  - Existing Status/Notes values on rows that already exist are NEVER
    touched — this module only appends brand-new rows, it never edits or
    overwrites a row that's already there.
"""
import logging
from typing import List, Dict

import gspread

from .google_auth import get_credentials

logger = logging.getLogger("Gate1.LeadsWriter")

HEADER = ["Name", "Email", "Company", "Role", "Status", "Notes"]

_client_cache = {"gc": None}


def _get_client():
    """Lazily authorizes a single cached gspread client for this process.
    Raises MissingCredentialsError (from google_auth.get_credentials) if
    OAuth hasn't been set up yet — callers should let that propagate so the
    Flask endpoints can surface the 428 "setup needed" response."""
    if _client_cache["gc"] is None:
        creds = get_credentials()
        _client_cache["gc"] = gspread.authorize(creds)
    return _client_cache["gc"]


def create_lead_sheet(name: str) -> str:
    """
    Creates a brand-new Google Sheet with the standard lead header row and
    returns its Sheet ID. The sheet is created in the authenticated user's
    Drive (same Google account used for Gmail send/draft).
    """
    gc = _get_client()
    title = (name or "New Lead Sheet").strip() or "New Lead Sheet"
    sh = gc.create(title)
    ws = sh.sheet1
    try:
        ws.update_title("Leads")
    except Exception as e:
        logger.warning(f"Could not rename default worksheet tab: {e}")
    ws.update("A1", [HEADER])
    try:
        ws.format("A1:F1", {"textFormat": {"bold": True}})
    except Exception as e:
        # Cosmetic only — a failed bold-header call should never block sheet creation.
        logger.warning(f"Could not bold the header row: {e}")
    return sh.id


def _normalized_key(name: str, email: str, company: str, role: str) -> str:
    email = (email or "").strip().lower()
    if email:
        return f"email:{email}"
    return f"combo:{(name or '').strip().lower()}|{(company or '').strip().lower()}|{(role or '').strip().lower()}"


def add_leads_to_sheet(sheet_id: str, leads: List[Dict]) -> Dict:
    """
    Appends `leads` (each a dict with name/email/company/role/[status]/[notes]
    keys, case-insensitive on the caller's side — the frontend always sends
    lowercase) to the worksheet at `sheet_id`, skipping any lead that already
    exists there. Duplicates are detected by email first, falling back to
    Name+Company+Role when email is blank. Rows already present in the sheet
    are left completely untouched (their Status/Notes are preserved).

    If the target sheet is missing one of the standard columns, the missing
    column(s) are appended to its header rather than failing the whole call
    — so a sheet a user connected manually (not created via this module)
    still works as long as it at least has Email or Name.

    Returns {"selected": N, "added": N, "duplicates_skipped": N}.
    """
    gc = _get_client()
    sh = gc.open_by_key(sheet_id)
    ws = sh.get_worksheet(0)

    all_values = ws.get_all_values()
    if not all_values:
        ws.update("A1", [HEADER])
        header = list(HEADER)
        all_values = [header]
    else:
        header = all_values[0]

    header_lower = [h.strip().lower() for h in header]
    missing_cols = [h for h in HEADER if h.lower() not in header_lower]
    if missing_cols:
        header = header + missing_cols
        ws.update("A1", [header])
        header_lower = [h.strip().lower() for h in header]

    # Build the set of dedupe keys already present in the sheet.
    existing_keys = set()
    for row in all_values[1:]:
        if not row or not any(str(c).strip() for c in row):
            continue
        data = {}
        for idx, col in enumerate(header_lower):
            data[col] = row[idx] if idx < len(row) else ""
        existing_keys.add(_normalized_key(
            data.get("name", ""), data.get("email", ""),
            data.get("company", ""), data.get("role", "")
        ))

    selected = len(leads)
    new_rows = []
    added = 0
    for lead in leads:
        lead = lead or {}
        lname = lead.get("name") or lead.get("Name") or ""
        lemail = lead.get("email") or lead.get("Email") or ""
        lcompany = lead.get("company") or lead.get("Company") or ""
        lrole = lead.get("role") or lead.get("Role") or ""
        lnotes = lead.get("notes") or lead.get("Notes") or ""
        lstatus = lead.get("status") or lead.get("Status") or ""

        key = _normalized_key(lname, lemail, lcompany, lrole)
        if key in existing_keys:
            continue
        existing_keys.add(key)  # guard against duplicates within this same batch too

        row = [""] * len(header)
        for idx, col in enumerate(header_lower):
            if col == "name":
                row[idx] = lname
            elif col == "email":
                row[idx] = lemail
            elif col == "company":
                row[idx] = lcompany
            elif col == "role":
                row[idx] = lrole
            elif col == "status":
                row[idx] = lstatus
            elif col == "notes":
                row[idx] = lnotes
        new_rows.append(row)
        added += 1

    if new_rows:
        ws.append_rows(new_rows, value_input_option="USER_ENTERED")

    return {
        "selected": selected,
        "added": added,
        "duplicates_skipped": selected - added,
    }