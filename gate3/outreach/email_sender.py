"""Email sender for recruiter outreach."""

import smtplib
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from pathlib import Path

from ..config import settings
from ..models import OutreachMessage, OutreachType


class EmailOutreach:
    """Sends outreach emails to recruiters via SMTP."""

    def __init__(self):
        self.host = settings.smtp_host
        self.port = settings.smtp_port
        self.user = settings.smtp_user
        self.password = settings.smtp_password
        self.from_email = settings.from_email

    def send(
        self,
        outreach: OutreachMessage,
        attachment_path: Path | None = None,
    ) -> bool:
        """Send an outreach email.

        Args:
            outreach: The message to send
            attachment_path: Optional resume PDF to attach

        Returns:
            True if sent successfully
        """
        msg = MIMEMultipart()
        msg["From"] = self.from_email
        msg["To"] = outreach.recipient
        msg["Subject"] = outreach.subject

        msg.attach(MIMEText(outreach.body, "plain"))

        # Attach resume if provided
        if attachment_path and attachment_path.exists():
            with open(attachment_path, "rb") as f:
                part = MIMEBase("application", "octet-stream")
                part.set_payload(f.read())
                encoders.encode_base64(part)
                part.add_header(
                    "Content-Disposition",
                    f'attachment; filename="{attachment_path.name}"',
                )
                msg.attach(part)

        try:
            with smtplib.SMTP(self.host, self.port) as server:
                server.starttls()
                server.login(self.user, self.password)
                server.send_message(msg)
            return True
        except Exception as e:
            print(f"Failed to send email to {outreach.recipient}: {e}")
            return False
