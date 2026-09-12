"""Recruiter outreach and follow-up automation."""

from .email_sender import EmailOutreach
from .message_generator import OutreachMessageGenerator

__all__ = ["EmailOutreach", "OutreachMessageGenerator"]
