"""
gate1/sheets_registry.py
──────────────────────────
Local registry of saved Google Sheet lead lists so Gate 1 / Gate 2 are no
longer restricted to a single hardcoded GOOGLE_SHEET_ID. Persisted to
lead_sheets.json next to server.py (gitignored, same treatment as
secrets.json / token.json — it only stores Sheet IDs + display names, no
secrets, but is kept out of git for the same "don't leak my local setup"
reasons).

Schema:
{
  "sheets": [
    {
      "key": "a1b2c3d4e5f6",         # internal stable id, used by the UI/API
      "name": "Software Engineer Leads",
      "sheet_id": "1AbCдефXYZ...",   # the actual Google Sheet ID
      "is_default": true,
      "created_at": "2026-08-24 10:00:00"
    },
    ...
  ]
}

Backward compatibility: if no sheet has ever been registered here, callers
fall back to the legacy single-sheet GOOGLE_SHEET_ID env var (see
resolve_sheet_id below) so existing setups keep working unmodified.
"""
import os
import json
import time
import uuid
import logging

logger = logging.getLogger("Gate1.SheetsRegistry")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY_FILE = os.path.join(BASE_DIR, "lead_sheets.json")


def _load() -> dict:
    if os.path.exists(REGISTRY_FILE):
        try:
            with open(REGISTRY_FILE, "r") as f:
                data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("sheets"), list):
                    return data
        except Exception as e:
            logger.error(f"Error reading lead_sheets.json: {e}")
    return {"sheets": []}


def _save(data: dict) -> bool:
    try:
        with open(REGISTRY_FILE, "w") as f:
            json.dump(data, f, indent=2)
        return True
    except Exception as e:
        logger.error(f"Failed to save lead_sheets.json: {e}")
        return False


def list_sheets() -> list:
    return _load()["sheets"]


def get_sheet(key: str):
    if not key:
        return None
    for s in list_sheets():
        if s["key"] == key:
            return s
    return None


def get_sheet_by_sheet_id(sheet_id: str):
    if not sheet_id:
        return None
    for s in list_sheets():
        if s["sheet_id"] == sheet_id:
            return s
    return None


def get_default_sheet():
    sheets = list_sheets()
    for s in sheets:
        if s.get("is_default"):
            return s
    return sheets[0] if sheets else None


def add_sheet(name: str, sheet_id: str, make_default: bool = False) -> dict:
    """Registers a Google Sheet by ID (adding a brand-new connection, or one
    created via 'Create blank lead sheet'). Re-adding an existing sheet_id
    just updates its display name rather than creating a duplicate entry."""
    name = (name or "").strip()
    sheet_id = (sheet_id or "").strip()
    if not sheet_id:
        raise ValueError("Sheet ID is required.")

    data = _load()
    existing = next((s for s in data["sheets"] if s["sheet_id"] == sheet_id), None)
    if existing:
        if name:
            existing["name"] = name
        entry = existing
    else:
        entry = {
            "key": uuid.uuid4().hex[:12],
            "name": name or f"Sheet {sheet_id[:8]}",
            "sheet_id": sheet_id,
            "is_default": False,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        data["sheets"].append(entry)

    if make_default or len(data["sheets"]) == 1:
        for s in data["sheets"]:
            s["is_default"] = (s["key"] == entry["key"])

    _save(data)
    return entry


def remove_sheet(key: str) -> bool:
    data = _load()
    before = len(data["sheets"])
    was_default = any(s["key"] == key and s.get("is_default") for s in data["sheets"])
    data["sheets"] = [s for s in data["sheets"] if s["key"] != key]
    changed = len(data["sheets"]) != before
    if was_default and data["sheets"]:
        data["sheets"][0]["is_default"] = True
    if changed:
        _save(data)
    return changed


def set_default(key: str) -> bool:
    data = _load()
    found = False
    for s in data["sheets"]:
        is_match = (s["key"] == key)
        s["is_default"] = is_match
        found = found or is_match
    if found:
        _save(data)
    return found


def resolve_sheet_id(sheet_key: str = None, explicit_sheet_id: str = None, legacy_env_sheet_id: str = None):
    """
    Figures out which Google Sheet a Gate 1 campaign / Gate 2 save should use.
    Resolution order:
      1. explicit_sheet_id — a raw Sheet ID passed directly by the caller.
      2. sheet_key — looked up against the saved registry.
      3. the registry's default sheet, if any are saved.
      4. legacy_env_sheet_id — the old single-sheet GOOGLE_SHEET_ID setting,
         for setups that haven't added anything to the registry yet.
    Returns (sheet_id, display_name), or (None, None) if nothing resolves.
    """
    if explicit_sheet_id:
        entry = get_sheet_by_sheet_id(explicit_sheet_id)
        return explicit_sheet_id, (entry["name"] if entry else explicit_sheet_id)

    if sheet_key:
        entry = get_sheet(sheet_key)
        if entry:
            return entry["sheet_id"], entry["name"]

    default_entry = get_default_sheet()
    if default_entry:
        return default_entry["sheet_id"], default_entry["name"]

    if legacy_env_sheet_id:
        return legacy_env_sheet_id, "Legacy GOOGLE_SHEET_ID"

    return None, None