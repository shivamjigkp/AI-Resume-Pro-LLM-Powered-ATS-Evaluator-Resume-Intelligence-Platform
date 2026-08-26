"""
Gate 2 -- Real Lead Discovery via the Apollo.io People Search API.

Why Apollo instead of scraping Google / LinkedIn
-------------------------------------------------
* Google and LinkedIn both PROHIBIT automated scraping of their results/profiles
  in their Terms of Service, and a headless SERP scraper gets CAPTCHA / IP-banned
  within a handful of requests -- so it is neither compliant nor reliable.
* Apollo returns real people filtered by title / industry / location and, on the
  reveal path, VERIFIED work emails from its own licensed dataset. That means we
  never "guess" an address (guessed emails bounce, wreck sender reputation, and
  drag the real Gate 1 emails into spam).

Environment variables (put these in your .env file)
---------------------------------------------------
APOLLO_API_KEY        Required to enable real discovery. If it is unset, the
                      caller should fall back to mock data so local dev works.
APOLLO_REVEAL_EMAILS  "true" / "false" (default "false"). When "true", each
                      matched person is enriched via People Match to reveal a
                      verified email. NOTE: revealing emails consumes Apollo
                      credits, so it is opt-in.
APOLLO_MAX_LEADS      Max leads to return per search, 1-100 (default 10).

Public API
----------
is_configured() -> bool
discover_leads(role, industry, location, keywords, max_leads=None) -> list[dict]
    Each dict matches the frontend contract exactly:
        {"name": str, "email": str, "company": str, "role": str, "notes": str}
    `email` is "" whenever Apollo did not return a verified address.
"""

import os
import logging

import requests

logger = logging.getLogger("Gate2LeadDiscovery")

APOLLO_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/search"
APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match"
DEFAULT_TIMEOUT = 25  # seconds


class LeadDiscoveryError(Exception):
    """Raised when Apollo is misconfigured or an Apollo API call fails."""


# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------
def _api_key() -> str:
    return (os.getenv("APOLLO_API_KEY") or "").strip()


def is_configured() -> bool:
    """True when an Apollo API key is present in the environment."""
    return bool(_api_key())


def _reveal_enabled() -> bool:
    return (os.getenv("APOLLO_REVEAL_EMAILS") or "false").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _max_leads(explicit=None) -> int:
    if explicit is not None:
        value = explicit
    else:
        try:
            value = int(os.getenv("APOLLO_MAX_LEADS", "10"))
        except (TypeError, ValueError):
            value = 10
    return max(1, min(int(value), 100))


def _headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": _api_key(),
    }


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
def _split_terms(text: str):
    """'Software Engineer, SDE-2' -> ['Software Engineer', 'SDE-2']."""
    if not text:
        return []
    out = []
    for chunk in text.replace(";", ",").split(","):
        chunk = chunk.strip()
        if chunk:
            out.append(chunk)
    return out


def _is_real_email(email: str) -> bool:
    """Apollo hands back locked placeholders such as
    'email_not_unlocked@domain.com' for contacts whose email is not revealed.
    Treat those (and blanks) as 'no email' so we never send to a placeholder."""
    if not email or "@" not in email:
        return False
    return "not_unlocked" not in email.lower()


def _full_name(person: dict) -> str:
    name = (person.get("name") or "").strip()
    if name:
        return name
    parts = [person.get("first_name"), person.get("last_name")]
    return " ".join(p for p in parts if p).strip()


def _company(person: dict) -> str:
    org = person.get("organization") or {}
    return (org.get("name") or person.get("organization_name") or "").strip()


# ---------------------------------------------------------------------------
# Apollo calls
# ---------------------------------------------------------------------------
def _search_people(role, industry, location, keywords, per_page):
    """Call Apollo People Search and return the raw list of person dicts."""
    payload = {"page": 1, "per_page": per_page}

    titles = _split_terms(role)
    if titles:
        payload["person_titles"] = titles

    locations = _split_terms(location)
    if locations:
        payload["person_locations"] = locations

    # Apollo has no simple free-text "industry" filter without tag IDs, so we
    # fold industry + any extra keywords into the free-text keyword filter.
    keyword_bits = [b for b in (industry, keywords) if b]
    if keyword_bits:
        payload["q_keywords"] = " ".join(keyword_bits)

    try:
        resp = requests.post(
            APOLLO_SEARCH_URL, headers=_headers(), json=payload, timeout=DEFAULT_TIMEOUT
        )
    except requests.RequestException as exc:
        raise LeadDiscoveryError(f"Could not reach Apollo: {exc}") from exc

    if resp.status_code == 401:
        raise LeadDiscoveryError("Apollo rejected the API key (401). Check APOLLO_API_KEY in .env.")
    if resp.status_code == 403:
        raise LeadDiscoveryError(
            "Apollo denied access (403). The People Search API usually requires a "
            "paid plan / master API key."
        )
    if resp.status_code == 422:
        raise LeadDiscoveryError(f"Apollo could not process the search (422): {resp.text[:200]}")
    if resp.status_code == 429:
        raise LeadDiscoveryError("Apollo rate limit hit (429). Wait a moment and try again.")
    if not resp.ok:
        raise LeadDiscoveryError(f"Apollo search failed ({resp.status_code}): {resp.text[:200]}")

    try:
        data = resp.json()
    except ValueError as exc:
        raise LeadDiscoveryError("Apollo returned a non-JSON response.") from exc

    # Matches arrive under "people"; some plans also populate "contacts".
    return (data.get("people") or []) + (data.get("contacts") or [])


def _reveal_email(person: dict) -> str:
    """Reveal a verified WORK email for one person via Apollo People Match.

    Consumes Apollo credits. Returns a verified email string, or "" on any
    failure (we log and move on rather than break the whole search)."""
    payload = {
        "first_name": person.get("first_name"),
        "last_name": person.get("last_name"),
        "organization_name": _company(person),
        "reveal_personal_emails": False,
    }
    if person.get("id"):
        payload["id"] = person["id"]  # most accurate match key when available

    try:
        resp = requests.post(
            APOLLO_MATCH_URL, headers=_headers(), json=payload, timeout=DEFAULT_TIMEOUT
        )
        if not resp.ok:
            logger.warning("Apollo match failed (%s) for %s", resp.status_code, _full_name(person))
            return ""
        matched = (resp.json() or {}).get("person") or {}
        email = matched.get("email") or ""
        return email if _is_real_email(email) else ""
    except (requests.RequestException, ValueError) as exc:
        logger.warning("Apollo match error for %s: %s", _full_name(person), exc)
        return ""


# ---------------------------------------------------------------------------
# Mapping to the frontend contract
# ---------------------------------------------------------------------------
def _to_lead(person: dict, role: str, location: str, reveal: bool) -> dict:
    email = person.get("email") or ""
    if not _is_real_email(email) and reveal:
        email = _reveal_email(person)
    if not _is_real_email(email):
        email = ""  # never guess -- blank tells the UI to mark the row "Missing"

    return {
        "name": _full_name(person) or "Unknown",
        "email": email,
        "company": _company(person),
        "role": (person.get("title") or "").strip(),
        "notes": f"Sourced via Apollo for '{role or 'any role'}' in '{location or 'any location'}'",
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def discover_leads(role="", industry="", location="", keywords="", max_leads=None):
    """Search Apollo and return leads in the frontend's expected shape.

    Raises LeadDiscoveryError if Apollo is not configured or the call fails."""
    if not is_configured():
        raise LeadDiscoveryError("APOLLO_API_KEY is not set.")

    limit = _max_leads(max_leads)
    reveal = _reveal_enabled()

    people = _search_people(role, industry, location, keywords, per_page=limit)
    leads = [_to_lead(p, role, location, reveal) for p in people[:limit]]

    revealed = sum(1 for lead in leads if lead["email"])
    logger.info("Apollo returned %d lead(s); %d with a verified email.", len(leads), revealed)
    return leads
