"""
gate1/gmail_helper.py
────────────────────────
Thin wrapper over the Gmail API for building outreach emails (with an
optional resume attachment) and either drafting them (safe, reviewable)
or sending them directly.
"""
import os
import base64
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from googleapiclient.discovery import build

from .google_auth import get_credentials

logger = logging.getLogger("Gate1.Gmail")


def get_gmail_service():
    creds = get_credentials()
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def build_message(to: str, subject: str, html_body: str, attachment_path: str = None) -> dict:
    """
    Builds a Gmail API-ready message dict ({'raw': ...}), optionally attaching
    a resume file (PDF/DOCX) if attachment_path points to an existing file.
    """
    msg = MIMEMultipart()
    msg["to"] = to
    msg["subject"] = subject
    msg.attach(MIMEText(html_body, "html"))

    if attachment_path and os.path.exists(attachment_path):
        with open(attachment_path, "rb") as f:
            part = MIMEApplication(f.read(), Name=os.path.basename(attachment_path))
        part["Content-Disposition"] = f'attachment; filename="{os.path.basename(attachment_path)}"'
        msg.attach(part)
    elif attachment_path:
        logger.warning(f"Attachment path given but file not found: {attachment_path}")

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return {"raw": raw}


def create_draft(service, message_body: dict) -> dict:
    return service.users().drafts().create(userId="me", body={"message": message_body}).execute()


def send_message(service, message_body: dict) -> dict:
    return service.users().messages().send(userId="me", body=message_body).execute()
