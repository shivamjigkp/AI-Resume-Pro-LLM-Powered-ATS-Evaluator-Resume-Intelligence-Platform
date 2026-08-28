"""
gate1/outreach_engine.py
─────────────────────────
Orchestrates a full Gate 1 cold-email campaign run with support for custom Subject,
Body template (from ChatGPT), Resume attachment, and Force Re-Draft.
"""
import os
import time
import logging
from typing import Dict

from .email_validator import validate_email_full
from .sheets_helper import read_lead_rows, update_row_status
from .sheets_registry import resolve_sheet_id
from .template_loader import load_template, load_template_by_name, render_template, split_subject_and_body
from .gmail_helper import get_gmail_service, build_message, create_draft, send_message
from config import BASE_DIR, OUTPUT_RESUMES_DIR, EMAIL_DELAY_SECONDS

logger = logging.getLogger("Gate1.Outreach")


class CampaignConfigError(Exception):
    pass


def resolve_resume_attachment(explicit_filename: str = None) -> str:
    """
    Finds a PDF resume to attach. If explicit_filename is provided, it resolves
    to that file in output_resumes/, resume/, or BASE_DIR. Otherwise, auto-picks
    the most recently modified PDF.
    """
    search_dirs = [
        os.path.join(BASE_DIR, OUTPUT_RESUMES_DIR),
        os.path.join(BASE_DIR, "resume"),
        BASE_DIR
    ]

    if explicit_filename and explicit_filename != "auto":
        for d in search_dirs:
            candidate = os.path.join(d, explicit_filename)
            if os.path.isfile(candidate):
                logger.info(f"Using explicitly chosen resume: {candidate}")
                return candidate
        logger.warning(f"Explicit resume '{explicit_filename}' not found, falling back to auto-pick.")

    # Auto-pick the newest PDF
    all_pdfs = []
    for d in search_dirs:
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith(".pdf"):
                    full = os.path.join(d, f)
                    try:
                        all_pdfs.append((os.path.getmtime(full), full))
                    except Exception:
                        pass

    if all_pdfs:
        all_pdfs.sort(key=lambda x: x[0], reverse=True)
        newest = all_pdfs[0][1]
        logger.info(f"Auto-selected newest resume PDF: {newest}")
        return newest

    logger.warning("No PDF resumes found. Proceeding without an attachment.")
    return None


def run_campaign(start_row: int, end_row: int, mode: str, sender_profile: Dict,
                  template_name: str = None, resume_filename: str = None,
                  sheet_key: str = None, sheet_id: str = None,
                  custom_subject: str = None, custom_body: str = None,
                  force_draft: bool = True) -> Dict:
    """
    Runs the outreach campaign with support for custom Subject, Body, and Force Re-draft.
    """
    legacy_sheet = os.getenv("GOOGLE_SHEET_ID")
    active_sheet_id, sheet_name = resolve_sheet_id(sheet_key=sheet_key, explicit_sheet_id=sheet_id, legacy_env_sheet_id=legacy_sheet)
    if not active_sheet_id:
        raise CampaignConfigError("No Google Sheet configured.")
    if not sheet_name:
        sheet_name = "Lead Tracker"

    gmail_service = get_gmail_service()

    leads, header_lower = read_lead_rows(active_sheet_id, start_row, end_row)
    if not leads:
        return {"sent": 0, "drafted": 0, "skipped": 0, "failed": 0,
                "message": f"No lead rows found in range [{start_row}, {end_row}] on sheet '{sheet_name}'.",
                "details": []}

    resume_path = resolve_resume_attachment(resume_filename)
    sent_count = 0
    drafted_count = 0
    skipped_count = 0
    failed_count = 0
    details = []

    for lead in leads:
        row_num = lead.get("row", 0)
        email = lead.get("email", "")
        name = lead.get("name", "")
        company = lead.get("company", "")
        role = lead.get("role", "")
        current_status = str(lead.get("status", "")).lower()

        # Duplicate check (Skip unless force_draft is True)
        if not force_draft and current_status in ("sent", "drafted"):
            skipped_count += 1
            details.append({"row": row_num, "email": email, "company": company, "status": "skipped", "reason": f"already {current_status}"})
            continue

        if not email:
            failed_count += 1
            details.append({"row": row_num, "email": "", "company": company, "status": "failed", "error": "Missing email address"})
            continue

        try:
            # Build template
            if custom_body and custom_body.strip():
                tmpl_text = custom_body.strip()
                if custom_subject and not tmpl_text.lower().startswith("subject:"):
                    tmpl_text = f"Subject: {custom_subject}\n\n" + tmpl_text
            elif template_name:
                tmpl_text = load_template_by_name(template_name)
            else:
                tmpl_text = load_template(role)

            target_company = company if (company and company.strip()) else "your team"
            target_role = role if (role and role.strip()) else "Software Development / Quantitative Analyst"
            target_recruiter = name if (name and name.strip() and name.lower() != "none") else "Hiring Team"

            context = {
                "recruiter_name": target_recruiter,
                "company": target_company,
                "company_name": target_company,
                "role": target_role,
                "sender_name": sender_profile.get("name", "Shivam Gupta"),
                "my_name": sender_profile.get("name", "Shivam Gupta"),
                "sender_email": sender_profile.get("email", "quantxcoder@gmail.com"),
                "sender_phone": sender_profile.get("phone", "+91-8081513780"),
                "sender_linkedin": sender_profile.get("linkedin", "https://linkedin.com/in/shivam-gupta-05209a279"),
                "sender_github": sender_profile.get("github", "https://github.com/shivamjigkp"),
                "college": sender_profile.get("college", "MMMUT, Gorakhpur"),
                "branch": sender_profile.get("branch", "ECE – Data Science & Machine Learning"),
                "other_links": sender_profile.get("other_links", ""),
                "experience_summary": sender_profile.get("experience_summary", "")
            }

            rendered = render_template(tmpl_text, context)
            extracted_sub, body = split_subject_and_body(rendered)
            
            # Prioritize custom_subject from the live editor
            raw_subject = custom_subject if (custom_subject and custom_subject.strip()) else (extracted_sub or f"Application for {target_role} at {target_company}")
            
            # Replace tags in final_subject
            final_subject = raw_subject
            for k, v in context.items():
                final_subject = final_subject.replace("{{" + k + "}}", str(v) if v else "")

            html_body = body.replace("\n", "<br>")
            msg = build_message(to=email, subject=final_subject, html_body=html_body, attachment_path=resume_path)

            # Create Draft or Send via Gmail
            if mode == "send":
                msg_id = send_message(gmail_service, msg)
                status_to_write = "Sent"
                sent_count += 1
            else:
                msg_id = create_draft(gmail_service, msg)
                status_to_write = "Drafted"
                drafted_count += 1

            # Update Sheet Row Status
            try:
                update_row_status(active_sheet_id, row_num, header_lower, status_to_write, note=f"Processed via Gate 1 ({time.strftime('%Y-%m-%d %H:%M')})")
            except Exception as e_sheet:
                logger.warning(f"Could not update sheet row {row_num}: {e_sheet}")

            details.append({"row": row_num, "email": email, "company": company, "status": status_to_write.lower(), "msg_id": msg_id})

            if mode == "send":
                time.sleep(2.0)

        except Exception as e_lead:
            failed_count += 1
            logger.error(f"Row {row_num} failed: {e_lead}")
            details.append({"row": row_num, "email": email, "company": company, "status": "failed", "error": str(e_lead)})

    msg_summary = f"Campaign complete [{sheet_name}]: {sent_count} sent, {drafted_count} drafted, {skipped_count} skipped, {failed_count} failed."
    return {
        "sent": sent_count,
        "drafted": drafted_count,
        "skipped": skipped_count,
        "failed": failed_count,
        "resume_attached": bool(resume_path),
        "resume_path": resume_path,
        "sheet_name": sheet_name,
        "sheet_id": active_sheet_id,
        "details": details,
        "message": msg_summary,
    }