"""
gate1/template_loader.py
────────────────────────
Loads a role-specific email template text file if one exists (e.g. a lead
with Role="Backend Engineer" looks for templates/backend_engineer.txt),
falling back to templates/default.txt otherwise.

Template files use {{placeholder}} tokens filled in per-lead. The first
line may optionally be "Subject: ..." to set a custom subject line;
everything after that is the email body (plain text, converted to <br>
line breaks for the HTML email).

Available placeholders:
  {{recruiter_name}}   — lead's Name column (falls back to "there")
  {{company}}           — lead's Company column
  {{role}}               — lead's Role column
  {{sender_name}}       — your name (from Outreach Profile Details)
  {{sender_email}}      — your email
  {{sender_phone}}      — your phone
  {{sender_linkedin}}   — your LinkedIn URL
  {{sender_github}}     — your GitHub URL
  {{experience_summary}}— your profile summary / total experience
"""
import os
import re
import logging

logger = logging.getLogger("Gate1.Templates")

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")


def _slugify(role: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (role or "").lower()).strip("_")


def load_template(role: str = "") -> str:
    slug = _slugify(role)
    if slug:
        candidate = os.path.join(TEMPLATES_DIR, f"{slug}.txt")
        if os.path.exists(candidate):
            with open(candidate, "r", encoding="utf-8") as f:
                return f.read()
    default_path = os.path.join(TEMPLATES_DIR, "default.txt")
    with open(default_path, "r", encoding="utf-8") as f:
        return f.read()


class TemplateNotFoundError(Exception):
    pass


def _safe_template_path(name: str) -> str:
    """Slugifies `name` and resolves it to a path inside TEMPLATES_DIR,
    guarding against path traversal (e.g. name="../../server")."""
    slug = _slugify(name)
    if not slug:
        raise TemplateNotFoundError("Template name is empty.")
    path = os.path.abspath(os.path.join(TEMPLATES_DIR, f"{slug}.txt"))
    if os.path.commonpath([path, os.path.abspath(TEMPLATES_DIR)]) != os.path.abspath(TEMPLATES_DIR):
        raise TemplateNotFoundError("Invalid template name.")
    return path


def list_templates() -> list:
    """Returns [{name, filename, subject, preview}, ...] for every saved
    template, used by the Gate 1 UI's template picker/editor."""
    os.makedirs(TEMPLATES_DIR, exist_ok=True)
    items = []
    for fname in sorted(os.listdir(TEMPLATES_DIR)):
        if not fname.lower().endswith(".txt"):
            continue
        name = fname[:-4]
        path = os.path.join(TEMPLATES_DIR, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = f.read()
        except Exception:
            raw = ""
        subject, body = split_subject_and_body(raw)
        preview_line = next((ln.strip() for ln in body.split("\n") if ln.strip()), "")
        items.append({
            "name": name,
            "filename": fname,
            "subject": subject or "",
            "preview": (preview_line[:120] + "…") if len(preview_line) > 120 else preview_line,
        })
    return items


def load_template_by_name(name: str) -> str:
    """Loads a specific template by its exact saved name (no role fallback).
    Raises TemplateNotFoundError if it doesn't exist."""
    path = _safe_template_path(name)
    if not os.path.exists(path):
        raise TemplateNotFoundError(f"Template '{name}' was not found.")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def save_template(name: str, content: str) -> str:
    """Creates or overwrites a template file. Returns the saved slug name."""
    path = _safe_template_path(name)
    os.makedirs(TEMPLATES_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content or "")
    return os.path.basename(path)[:-4]


def render_template(text: str, context: dict) -> str:
    for key, value in context.items():
        text = text.replace("{{" + key + "}}", str(value) if value else "")
    return text


def split_subject_and_body(rendered: str):
    """If the first line is 'Subject: ...', extract it; otherwise no custom subject."""
    lines = rendered.split("\n")
    if lines and lines[0].strip().lower().startswith("subject:"):
        subject = lines[0].split(":", 1)[1].strip()
        body = "\n".join(lines[1:]).strip()
        return subject, body
    return None, rendered.strip()
