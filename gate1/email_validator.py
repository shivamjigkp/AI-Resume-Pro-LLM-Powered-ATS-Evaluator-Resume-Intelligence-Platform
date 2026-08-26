"""
gate1/email_validator.py
─────────────────────────
Two-stage lead email validation before any send/draft is attempted:
  1. Syntax check (RFC-compliant format) via the `email-validator` package.
  2. MX DNS lookup — confirms the domain actually has mail servers configured,
     which catches typo'd / fake domains that pass syntax but can't receive mail.

This never sends a test email or verifies mailbox existence (that would require
SMTP handshakes and is unreliable/abusive) — it's a fast, safe pre-filter.
"""
import logging
from typing import Tuple, Dict
import dns.resolver
from email_validator import validate_email, EmailNotValidError

logger = logging.getLogger("Gate1.EmailValidator")

# Small in-process cache so re-validating the same domain across many leads
# in one campaign run doesn't hammer DNS.
_mx_cache: Dict[str, bool] = {}


def check_syntax(email: str) -> Tuple[bool, str]:
    """Returns (is_valid, normalized_email_or_error_reason)."""
    try:
        result = validate_email(email, check_deliverability=False)
        return True, result.normalized
    except EmailNotValidError as e:
        return False, str(e)


def has_mx_record(domain: str) -> bool:
    """Returns True if the domain has at least one MX record."""
    if domain in _mx_cache:
        return _mx_cache[domain]
    try:
        answers = dns.resolver.resolve(domain, "MX")
        ok = len(answers) > 0
    except Exception as e:
        logger.info(f"MX lookup failed for '{domain}': {e}")
        ok = False
    _mx_cache[domain] = ok
    return ok


def validate_email_full(email: str) -> Tuple[bool, str]:
    """
    Full validation: syntax + MX record.
    Returns (is_valid, reason) — reason is 'Valid' on success, or a human-readable
    failure explanation on rejection.
    """
    if not email or "@" not in email:
        return False, "Empty or malformed email address"

    ok, normalized_or_reason = check_syntax(email)
    if not ok:
        return False, f"Invalid syntax: {normalized_or_reason}"

    domain = normalized_or_reason.split("@")[-1]
    if not has_mx_record(domain):
        return False, f"No MX record found for domain '{domain}' — likely undeliverable"

    return True, "Valid"


def validate_bulk(emails):
    """Validate a list of emails, returns {email: (is_valid, reason)}."""
    return {e: validate_email_full(e) for e in emails}
