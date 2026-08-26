"""
gate1/outreach_engine.py
─────────────────────────
Orchestrates a full Gate 1 cold-email campaign run:

  1. Read lead rows [start_row, end_row] from the configured Google Sheet.
  2. Skip rows already marked Sent/Drafted (dedupe across re-runs).
  3. Validate each lead's email (syntax + MX).
  4. Load a role-matched template, personalize it with lead + sender data.
  5. Attach the most recently generated resume PDF, if one exists.
  6. Create a Gmail draft (default, safe) or send directly ('send' mode).
  7. Write Status/Notes back to the sheet.
  8. Rate-limit between sends via EMAIL_DELAY_SECONDS to avoid spam flags.

Any single lead failing (bad email, missing sheet columns, API hiccup) does
NOT abort the whole campaign — it's recorded as a per-row failure and the
run continues, so one bad row doesn't block the rest of the batch.
"""
import os
import time
import logging
from typing import Dict

from .email_validator import validate_email_full
from .sheets_helper import read_lead_rows, update_row_status
from .gmail_helper import get_gmail_service, build_message, create_draft, send_message
from .template_loader import (
    load_template, load_template_by_name, render_template,
    split_subject_and_body, TemplateNotFoundError,
)
from .google_auth import MissingCredentialsError
from . import sheets_registry

from config import GOOGLE_SHEET_ID, OUTPUT_RESUMES_DIR, BASE_RESUME_PATH, EMAIL_DELAY_SECONDS

logger = logging.getLogger("Gate1.Engine")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ALREADY_PROCESSED_STATUSES = {"sent", "drafted"}


class CampaignConfigError(Exception):
    pass


def resolve_resume_attachment(resume_filename: str = None) -> str:
    """
    Picks the resume file to attach.
    If `resume_filename` is given (a Gate 1 "Default Resume" selection — a
    specific PDF's basename inside output_resumes/), that exact file is used
    when it exists inside output_resumes/ (path-traversal guarded).
    Otherwise falls back to the most recently modified PDF in output_resumes/,
    then to BASE_RESUME_PATH if that itself is a PDF.
    Returns None if nothing suitable is found (email is still sent, just without
    an attachment, and this is surfaced in the result summary).
    """
    output_dir = os.path.abspath(os.path.join(BASE_DIR, OUTPUT_RESUMES_DIR))

    if resume_filename:
        candidate = os.path.abspath(os.path.join(output_dir, os.path.basename(resume_filename)))
        if os.path.commonpath([candidate, output_dir]) == output_dir and os.path.exists(candidate):
            return candidate
        # Explicit selection missing on disk — fall through to auto-detection
        # rather than silently sending with no attachment.

    if os.path.isdir(output_dir):
        pdfs = [
            os.path.join(output_dir, f)
            for f in os.listdir(output_dir)
            if f.lower().endswith(".pdf")
        ]
        if pdfs:
            return max(pdfs, key=os.path.getmtime)

    base_path = os.path.join(BASE_DIR, BASE_RESUME_PATH)
    if base_path.lower().endswith(".pdf") and os.path.exists(base_path):
        return base_path

    return None


def run_campaign(start_row: int, end_row: int, mode: str, sender_profile: Dict,
                  template_name: str = None, resume_filename: str = None,
                  sheet_key: str = None, sheet_id: str = None) -> Dict:
    """
    Runs the outreach campaign. `mode` is 'draft' or 'send'.
    `sender_profile` is the Outreach Profile Details from the frontend
    (name, email, phone, location, linkedin, github, experience_summary, total_experience...).
    `template_name`, if given, forces every lead to use that saved Gate 1
    template instead of the per-role auto-match (used by Fast Apply / the
    Advanced Mode manual template picker).
    `resume_filename`, if given, forces attachment of that specific PDF from
    output_resumes/ instead of auto-picking the most recent one.
    `sheet_key` / `sheet_id`: which saved lead sheet to use for this run — see
    gate1/sheets_registry.py::resolve_sheet_id for the full resolution order.
    When neither is given, falls back to the registry's default sheet, then
    to the legacy single-sheet GOOGLE_SHEET_ID setting.
    Returns a summary dict: {sent, drafted, skipped, failed, resume_attached, details:[...]}
    """
    legacy_sheet_id = os.getenv("GOOGLE_SHEET_ID", "") or GOOGLE_SHEET_ID
    resolved_sheet_id, resolved_sheet_name = sheets_registry.resolve_sheet_id(
        sheet_key=sheet_key, explicit_sheet_id=sheet_id, legacy_env_sheet_id=legacy_sheet_id
    )
    sheet_id = resolved_sheet_id
    if not sheet_id:
        raise CampaignConfigError(
            "No lead sheet is configured. Add/select a Google Sheet under Gate 1's "
            "'Lead Source / Google Sheet' section before running a campaign."
        )

    if not sender_profile.get("email"):
        raise CampaignConfigError(
            "Your sender email is empty. Fill in 'Email Address' under Outreach Profile "
            "Details and save it before running a campaign."
        )

    leads, header_lower = read_lead_rows(sheet_id, start_row, end_row)

    resume_path = resolve_resume_attachment(resume_filename)

    result = {
        "sent": 0, "drafted": 0, "skipped": 0, "failed": 0,
        "resume_attached": bool(resume_path),
        "resume_path": resume_path,
        "sheet_name": resolved_sheet_name,
        "sheet_id": sheet_id,
        "details": [],
    }

    if not leads:
        result["message"] = f"No lead rows with data found between rows {start_row} and {end_row}."
        return result

    service = get_gmail_service()

    total = len(leads)
    for idx, lead in enumerate(leads):
        row_num = lead["_row_num"]
        email = (lead.get("email") or "").strip()
        name = (lead.get("name") or "").strip()
        company = (lead.get("company") or "").strip()
        role = (lead.get("role") or "").strip()
        existing_status = (lead.get("status") or "").strip().lower()

        if existing_status in ALREADY_PROCESSED_STATUSES:
            result["skipped"] += 1
            result["details"].append({"row": row_num, "email": email, "status": "skipped", "reason": f"already {existing_status}"})
            continue

        if not email:
            result["skipped"] += 1
            result["details"].append({"row": row_num, "status": "skipped", "reason": "missing email"})
            continue

        valid, reason = validate_email_full(email)
        if not valid:
            result["failed"] += 1
            update_row_status(sheet_id, row_num, header_lower, "Failed", reason)
            result["details"].append({"row": row_num, "email": email, "status": "failed", "reason": reason})
            continue

        try:
            if template_name:
                try:
                    tmpl = load_template_by_name(template_name)
                except TemplateNotFoundError:
                    tmpl = load_template(role)
            else:
                tmpl = load_template(role)
            context = {
                "recruiter_name": name or "there",
                "company": company or "your company",
                "role": role or "the open position",
                "sender_name": sender_profile.get("name", ""),
                "sender_email": sender_profile.get("email", ""),
                "sender_phone": sender_profile.get("phone", ""),
                "sender_linkedin": sender_profile.get("linkedin", ""),
                "sender_github": sender_profile.get("github", ""),
                "experience_summary": sender_profile.get("experience_summary") or sender_profile.get("total_experience", ""),
            }
            rendered = render_template(tmpl, context)
            custom_subject, body = split_subject_and_body(rendered)
            subject = custom_subject or f"Application for {role or 'a role'} at {company or 'your company'}"
            html_body = body.replace("\n", "<br>")

            message_body = build_message(email, subject, html_body, resume_path)

            if mode == "send":
                send_message(service, message_body)
                update_row_status(sheet_id, row_num, header_lower, "Sent")
                result["sent"] += 1
                result["details"].append({"row": row_num, "email": email, "status": "sent"})
            else:
                create_draft(service, message_body)
                update_row_status(sheet_id, row_num, header_lower, "Drafted")
                result["drafted"] += 1
                result["details"].append({"row": row_num, "email": email, "status": "drafted"})

        except Exception as e:
            logger.error(f"Row {row_num} ({email}) failed: {e}")
            result["failed"] += 1
            update_row_status(sheet_id, row_num, header_lower, "Failed", str(e))
            result["details"].append({"row": row_num, "email": email, "status": "failed", "reason": str(e)})

        # Rate-limit between attempts (skip the wait after the very last lead)
        if idx < total - 1:
            time.sleep(EMAIL_DELAY_SECONDS)

    sheet_label = f" [{resolved_sheet_name}]" if resolved_sheet_name else ""
    result["message"] = (
        f"Campaign complete{sheet_label}: {result['sent']} sent, {result['drafted']} drafted, "
        f"{result['skipped']} skipped, {result['failed']} failed."
    )
    return result