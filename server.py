from flask import Flask, request, jsonify, send_from_directory
import os
import json
import logging
import time

# Import configurations and active client manager
from config import secrets_client, SECRETS_FILE, GOOGLE_SHEET_ID, BASE_RESUME_PATH, EMAIL_DELAY_SECONDS, AUTOFILL_WAIT_MS
from gate2 import lead_discovery
from gate2.company_scraper import discover_companies
from gate2.local_extractor import extract_local_leads

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("OutreachBackend")

app = Flask(__name__, static_folder=".")

MASTER_PIN = os.getenv("OUTREACH_MASTER_PIN", "shivam2026")

def is_authorized(req):
    pin = req.headers.get("X-Outreach-PIN") or req.args.get("pin") or (req.is_json and req.get_json(silent=True) and req.get_json().get("pin"))
    # If running on localhost/127.0.0.1, auto-allow or require pin
    client_ip = req.remote_addr or ""
    if client_ip in ("127.0.0.1", "localhost", "::1") and not os.getenv("RENDER"):
        return True
    return pin == MASTER_PIN


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE_PATH = os.path.join(BASE_DIR, "resume_builder_1.html")

# Safety net: any unhandled exception anywhere in the app returns JSON, never
# Flask's default HTML error page — the frontend always expects response.json()
# to parse, and an HTML page there fails with "Unexpected token '<'".
@app.errorhandler(Exception)
def handle_uncaught_exception(e):
    logger.exception("Unhandled server error")
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify({"status": "error", "detail": e.description}), e.code
    return jsonify({"status": "error", "detail": f"Unexpected server error: {e}"}), 500

# CORS implementation to allow frontend to communicate
@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response

# ---------------------------------------------------------
# 1. Page Server (Serves the HTML GUI)
# ---------------------------------------------------------
@app.route("/")
def serve_frontend():
    """Serves the primary UI resume_builder_1.html."""
    if os.path.exists(HTML_FILE_PATH):
        return send_from_directory(BASE_DIR, "resume_builder_1.html")
    else:
        return "resume_builder_1.html not found in the project root folder.", 404

# ---------------------------------------------------------
# 2. Config & Secrets APIs
# ---------------------------------------------------------
@app.route("/api/config/get", methods=["GET"])
def get_config():
    """Loads active config variables and keys pool."""
    secrets_client.secrets_data = secrets_client._load_secrets()
    return jsonify({
        "secrets": secrets_client.secrets_data,
        "env": {
            "GOOGLE_SHEET_ID": os.getenv("GOOGLE_SHEET_ID", ""),
            "BASE_RESUME_PATH": os.getenv("BASE_RESUME_PATH", "resume/base_resume.docx"),
            "EMAIL_DELAY_SECONDS": int(os.getenv("EMAIL_DELAY_SECONDS", 45)),
            "AUTOFILL_WAIT_MS": int(os.getenv("AUTOFILL_WAIT_MS", 2000))
        }
    })

@app.route("/api/config/save", methods=["POST"])
def save_config():
    """
    Saves updated keys and system settings to secrets.json and .env locally.
    Partial payloads are merged onto the current values (not reset to defaults),
    so e.g. saving just GOOGLE_SHEET_ID from the Gate 1 panel never wipes out
    previously-saved AI provider keys or other settings.
    """
    try:
        cfg = request.get_json()
    except Exception as e:
        return jsonify({"status": "error", "message": "Invalid JSON body"}), 400

    cfg = cfg or {}

    # 1. Update secrets.json — merge onto existing GLOBAL/SECTIONS, only overwriting
    #    keys actually present in this request.
    secrets_client.secrets_data = secrets_client._load_secrets()
    current_secrets = secrets_client.secrets_data or {}
    secrets_dict = {
        "GLOBAL": cfg.get("GLOBAL", current_secrets.get("GLOBAL", {})),
        "SECTIONS": cfg.get("SECTIONS", current_secrets.get("SECTIONS", {}))
    }
    secrets_success = secrets_client.save_secrets(secrets_dict)

    # 2. Update local .env file — merge onto current env values so a partial
    #    payload (e.g. just GOOGLE_SHEET_ID) doesn't reset the rest to defaults.
    try:
        google_sheet_id = cfg.get("GOOGLE_SHEET_ID", os.getenv("GOOGLE_SHEET_ID", ""))
        base_resume_path = cfg.get("BASE_RESUME_PATH", os.getenv("BASE_RESUME_PATH", "resume/base_resume.docx"))
        email_delay_seconds = int(cfg.get("EMAIL_DELAY_SECONDS", os.getenv("EMAIL_DELAY_SECONDS", 45)))
        autofill_wait_ms = int(cfg.get("AUTOFILL_WAIT_MS", os.getenv("AUTOFILL_WAIT_MS", 2000)))

        with open(os.path.join(BASE_DIR, ".env"), "w") as env_file:
            env_file.write(f'GOOGLE_SHEET_ID="{google_sheet_id}"\n')
            env_file.write(f'BASE_RESUME_PATH="{base_resume_path}"\n')
            env_file.write(f'EMAIL_DELAY_SECONDS={email_delay_seconds}\n')
            env_file.write(f'AUTOFILL_WAIT_MS={autofill_wait_ms}\n')
        
        # Reload environment in active session
        os.environ["GOOGLE_SHEET_ID"] = google_sheet_id
        os.environ["BASE_RESUME_PATH"] = base_resume_path
        os.environ["EMAIL_DELAY_SECONDS"] = str(email_delay_seconds)
        os.environ["AUTOFILL_WAIT_MS"] = str(autofill_wait_ms)
        
        env_success = True
    except Exception as e:
        logger.error(f"Error saving .env file: {e}")
        env_success = False
        
    if secrets_success and env_success:
        return jsonify({"status": "success", "message": "All configurations saved locally."})
    else:
        return jsonify({"status": "error", "message": "Failed to write configuration files."}), 500

# ---------------------------------------------------------
# 3. Gate Implementation - Gate 4: Autofill
# ---------------------------------------------------------
@app.route("/api/gate4/autofill", methods=["POST"])
def autofill_endpoint():
    """
    Scrapes active browser tab DOM, builds AI field mappings,
    and runs Playwright autofill keystrokes over debug port 9222.
    """
    logger.info("Gate 4 Playwright Form-Filler call received.")
    
    try:
        body = request.get_json()
        resume_data = body.get("resume_data", {})
        client_keys = body.get("keys", {})
        custom_defaults = body.get("custom_defaults", {})
        autofill_mode = body.get("autofill_mode", "local")
        ai_strategy = body.get("ai_strategy", "pure_ai")
    except Exception as e:
        logger.error(f"Error parsing resume body details: {e}")
        return jsonify({"status": "error", "message": "Missing or invalid resume_data in body."}), 400

    # Check if Chrome debugging is active on Port 9223
    from gate4.browser_connector import is_chrome_debugging_active, get_active_browser_page
    if not is_chrome_debugging_active():
        return jsonify({
            "status": "error", 
            "detail": "Chrome debugging port 9223 is offline. Ensure you started Chrome with flag --remote-debugging-port=9223"
        }), 503
        
    # Connect Playwright over CDP to find active page
    from playwright.sync_api import sync_playwright
    from gate4.dom_mapper import extract_form_elements, generate_ai_mappings, autofill_form_elements
    
    success = False
    details = ""
    try:
        with sync_playwright() as p:
            page = get_active_browser_page(p)
            if not page:
                return jsonify({"status": "error", "detail": "Connected to Chrome, but no active tabs were found."}), 500
            
            # Scroll-and-fill loop to dynamically catch fields below the fold as we scroll down
            filled_selectors = set()
            total_filled_count = 0
            
            # Start at the top of the page
            page.evaluate("window.scrollTo(0, 0)")
            time.sleep(0.4)
            
            for step in range(5):
                logger.info(f"--- Autofill Scroll Step {step + 1} ---")
                
                # Scrape inputs currently visible
                elements = extract_form_elements(page)
                logger.info(f"Scraped elements diagnostic list: {json.dumps(elements, indent=2)}")
                if not elements and step == 0:
                    return jsonify({"status": "info", "message": "Autofill completed: No input fields detected."})
                
                # Filter elements to only map fields we haven't filled yet
                new_elements = [el for el in elements if el["selector"] not in filled_selectors]
                
                if new_elements:
                    # Map new elements using heuristics & optional AI
                    mappings = generate_ai_mappings(new_elements, resume_data, client_keys, custom_defaults, autofill_mode, ai_strategy)
                    
                    if mappings:
                        # Autofill these mapped fields
                        filled = autofill_form_elements(page, mappings)
                        if filled:
                            for item in mappings:
                                filled_selectors.add(item["selector"])
                            total_filled_count += len(mappings)
                            
                # Scroll down by 80% viewport height to trigger lazy rendering
                prev_scroll = page.evaluate("window.scrollY")
                page.evaluate("window.scrollBy(0, window.innerHeight * 0.8)")
                time.sleep(0.8) # Wait for layout/lazy loading
                new_scroll = page.evaluate("window.scrollY")
                
                # If we didn't scroll further (reached bottom of page), stop
                if new_scroll == prev_scroll:
                    logger.info("Reached bottom of page. Ending scroll-autofill loop.")
                    break
            
            # Calculate remaining unfilled fields
            unfilled_list = []
            final_elements = extract_form_elements(page)
            for el in final_elements:
                sel = el["selector"]
                if sel not in filled_selectors:
                    label = el.get("labelText") or el.get("placeholder") or el.get("name") or sel
                    label_lower = label.lower()
                    # Skip common standard fields that are already in the main defaults list
                    if any(kw in label_lower for kw in ["name", "email", "phone", "mobile", "linkedin", "github", "portfolio", "location", "resume", "cv", "attach"]):
                        continue
                    unfilled_list.append({
                        "selector": sel,
                        "labelText": label
                    })
            
            if total_filled_count > 0:
                success = True
                details = f"Autofilled {total_filled_count} fields successfully across scroll steps."
            else:
                success = False
                details = "Failed to type values into fields or no unfilled fields detected."
    except Exception as e:
        logger.error(f"Error in Autofill pipeline: {e}")
        return jsonify({"status": "error", "detail": f"Autofill error: {str(e)}"}), 500

    if success:
        return jsonify({"status": "success", "message": details, "unfilled_fields": unfilled_list})
    else:
        return jsonify({"status": "error", "detail": details, "unfilled_fields": unfilled_list}), 500

# ---------------------------------------------------------
# Placeholder Gate Routes (Gate 2 — legacy stubs, unrelated to the
# lead-search/lead-sheet flow below, kept for backward compatibility)
# ---------------------------------------------------------
import random

@app.route("/api/gate2/import-pdf", methods=["POST"])
def import_pdf_endpoint():
    logger.info("Gate 2 PDF Import API called.")
    return jsonify({"status": "success", "message": "PDF parsing API logic placeholder active."})

@app.route("/api/gate2/discover-leads", methods=["POST"])
def discover_leads_endpoint():
    """Gate 2 -- Real Lead Discovery.

    Finds real people by role / industry / location using the Apollo.io People
    Search API and maps each match to the frontend contract
    {name, email, company, role, notes}.

    Emails are included ONLY when Apollo returns a verified address -- we never
    guess emails. Guessed addresses bounce, wreck sender reputation, and would
    push the real Gate 1 emails into spam. Rows with a blank email are shown by
    the UI as "Missing" and cannot be selected for sending.

    If APOLLO_API_KEY is not set, we fall back to the original mock generator so
    local development keeps working without an API key.
    """
    logger.info("Gate 2 lead discovery called.")
    
    if request.is_json:
        body = request.get_json() or {}
        role = (body.get("role") or "").strip()
        industry = (body.get("industry") or "").strip()
        location = (body.get("location") or "").strip()
        keywords = (body.get("keywords") or "").strip()
        strategy = (body.get("strategy") or "apollo").strip()
    else:
        body = request.form
        role = (body.get("role") or "").strip()
        industry = (body.get("industry") or "").strip()
        location = (body.get("location") or "").strip()
        keywords = (body.get("keywords") or "").strip()
        strategy = (body.get("strategy") or "apollo").strip()

    if strategy == "local_pdf":
        import tempfile
        import shutil
        import os
        
        if 'pdf_files' not in request.files:
            return jsonify({"status": "error", "detail": "No files uploaded"}), 400
            
        leads = []
        temp_dir = tempfile.mkdtemp()
        try:
            files = request.files.getlist("pdf_files")
            for f in files:
                if f.filename:
                    path = os.path.join(temp_dir, f.filename)
                    f.save(path)
            
            leads = extract_local_leads(temp_dir)
        except Exception as e:
            logger.error(f"PDF extract error: {e}")
            return jsonify({"status": "error", "detail": str(e)}), 500
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
            
        message = f"Found {len(leads)} HR contacts from your uploaded PDFs."
        return jsonify({"status": "success", "leads": leads, "message": message})

    if strategy == "companies":
        leads = discover_companies(role, industry, location, keywords)
        message = f"Found {len(leads)} companies via Free Web Search."
        return jsonify({"status": "success", "leads": leads, "message": message})

    # --- Real discovery via Apollo -----------------------------------------
    if lead_discovery.is_configured():
        try:
            leads = lead_discovery.discover_leads(
                role=role, industry=industry, location=location, keywords=keywords
            )
        except lead_discovery.LeadDiscoveryError as e:
            logger.error("Apollo discovery failed: %s", e)
            return jsonify({"status": "error", "detail": str(e)}), 502

        with_email = sum(1 for lead in leads if lead.get("email"))
        message = f"Found {len(leads)} lead(s) via Apollo ({with_email} with a verified email)."
        if leads and with_email == 0:
            message += (" No verified emails were returned on this plan -- set "
                        "APOLLO_REVEAL_EMAILS=true in .env to unlock verified "
                        "emails (this consumes Apollo credits).")
        return jsonify({"status": "success", "leads": leads, "message": message})

    # --- Fallback: mock generator (no APOLLO_API_KEY configured) -----------
    logger.warning("APOLLO_API_KEY not set -- returning MOCK leads. "
                   "Add it to .env to enable real discovery.")
    leads = _generate_mock_leads(role or "Software Engineer",
                                 industry or "Tech",
                                 location or "Remote")
    return jsonify({
        "status": "success",
        "leads": leads,
        "message": (f"[MOCK] Returned {len(leads)} sample leads -- set APOLLO_API_KEY "
                    f"in .env for real discovery."),
    })


def _generate_mock_leads(role, industry, location):
    """Original placeholder generator, kept as a no-API-key fallback for local dev."""
    companies = [f"{industry}Corp", f"NextGen {industry}", f"{industry} Solutions",
                 f"Global {industry} Inc", f"Agile {industry} Systems", "TechNova"]
    names = ["Alice Smith", "Bob Johnson", "Charlie Davis", "Diana Prince",
             "Evan Wright", "Fiona Gallagher"]
    leads = []
    for _ in range(random.randint(4, 7)):
        comp = random.choice(companies)
        name = random.choice(names)
        has_email = random.random() > 0.2
        email = f"{name.split()[0].lower()}@{comp.replace(' ', '').lower()}.com" if has_email else ""
        leads.append({
            "name": name,
            "email": email,
            "company": comp,
            "role": random.choice(["VP of Engineering", "Technical Recruiter", "Engineering Manager"]),
            "notes": f"[MOCK] Sourced for {role} in {location}",
        })
    return leads


# ---------------------------------------------------------
# Gate 1 / Gate 2 shared — Saved Google Sheet lead-list registry
# ---------------------------------------------------------
def _sheets_modules():
    """Lazy-imports the registry/writer modules with a consistent error shape."""
    try:
        from gate1 import sheets_registry, leads_writer
        return sheets_registry, leads_writer, None
    except Exception as e:
        logger.error(f"Gate 1/2 sheets module import failed: {e}")
        return None, None, e


@app.route("/api/gate1/sheets", methods=["GET"])
def list_lead_sheets():
    """Lists every saved lead sheet plus which one is currently default."""
    sheets_registry, _, err = _sheets_modules()
    if err:
        return jsonify({"status": "error", "detail": f"Gate 1 backend failed to load: {err}"}), 500
    sheets = sheets_registry.list_sheets()
    legacy_sheet_id = os.getenv("GOOGLE_SHEET_ID", "") or GOOGLE_SHEET_ID
    return jsonify({
        "status": "success",
        "sheets": sheets,
        "has_legacy_fallback": bool(legacy_sheet_id)
    })

@app.route("/api/gate1/sheets", methods=["POST"])
def add_lead_sheet():
    """Connects an existing Google Sheet by ID. Body: {name, sheet_id, make_default}."""
    sheets_registry, _, err = _sheets_modules()
    if err:
        return jsonify({"status": "error", "detail": f"Gate 1 backend failed to load: {err}"}), 500
    body = request.get_json(silent=True) or {}
    sheet_id = (body.get("sheet_id") or "").strip()
    name = (body.get("name") or "").strip()
    make_default = bool(body.get("make_default"))
    if not sheet_id:
        return jsonify({"status": "error", "detail": "Sheet ID is required."}), 400
    try:
        entry = sheets_registry.add_sheet(name, sheet_id, make_default)
        return jsonify({"status": "success", "message": f"Sheet '{entry['name']}' connected.", "sheet": entry})
    except ValueError as e:
        return jsonify({"status": "error", "detail": str(e)}), 400
    except Exception as e:
        logger.error(f"Failed to connect sheet: {e}")
        return jsonify({"status": "error", "detail": f"Could not connect sheet: {e}"}), 500


@app.route("/api/gate1/sheets/create", methods=["POST"])
def create_lead_sheet_endpoint():
    """Creates a brand-new blank Google Sheet (with the standard lead header
    row) and registers it. Body: {name, make_default}."""
    sheets_registry, leads_writer, err = _sheets_modules()
    if err:
        return jsonify({"status": "error", "detail": f"Gate 1 backend failed to load: {err}"}), 500
    from gate1.google_auth import MissingCredentialsError
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip() or "New Lead Sheet"
    make_default = bool(body.get("make_default"))
    try:
        new_sheet_id = leads_writer.create_lead_sheet(name)
        entry = sheets_registry.add_sheet(name, new_sheet_id, make_default)
        return jsonify({"status": "success", "message": f"Created new lead sheet '{name}'.", "sheet": entry})
    except MissingCredentialsError as e:
        return jsonify({"status": "error", "detail": str(e)}), 428
    except Exception as e:
        logger.error(f"Failed to create new lead sheet: {e}")
        return jsonify({"status": "error", "detail": f"Could not create sheet: {e}"}), 500


@app.route("/api/gate1/sheets/<key>/default", methods=["POST"])
def set_default_lead_sheet(key):
    sheets_registry, _, err = _sheets_modules()
    if err:
        return jsonify({"status": "error", "detail": f"Gate 1 backend failed to load: {err}"}), 500
    ok = sheets_registry.set_default(key)
    if not ok:
        return jsonify({"status": "error", "detail": "Sheet not found."}), 404
    return jsonify({"status": "success", "message": "Default sheet updated."})


@app.route("/api/gate1/sheets/<key>", methods=["DELETE"])
def remove_lead_sheet_endpoint(key):
    sheets_registry, _, err = _sheets_modules()
    if err:
        return jsonify({"status": "error", "detail": f"Gate 1 backend failed to load: {err}"}), 500
    ok = sheets_registry.remove_sheet(key)
    if not ok:
        return jsonify({"status": "error", "detail": "Sheet not found."}), 404
    return jsonify({"status": "success", "message": "Sheet connection removed (the underlying Google Sheet itself is untouched)."})


# ---------------------------------------------------------
# Gate 2 — Lead Discovery: save searched/selected leads into a lead sheet
# ---------------------------------------------------------
@app.route("/api/gate2/save-leads", methods=["POST"])
def save_gate2_leads():
    """
    Writes selected Gate 2 search-result leads into a lead sheet, deduping
    against whatever's already there. Body:
      {
        "leads": [{"name","email","company","role","notes"}, ...],
        "target": "new" | "existing",
        "sheet_name": "..."   # required when target == "new"
        "sheet_key": "..."    # required when target == "existing"
        "make_default": false
      }
    """
    sheets_registry, leads_writer, err = _sheets_modules()
    if err:
        return jsonify({"status": "error", "detail": f"Gate 1/2 backend failed to load: {err}"}), 500
    from gate1.google_auth import MissingCredentialsError

    body = request.get_json(silent=True) or {}
    leads = body.get("leads") or []
    target = body.get("target", "existing")
    if not isinstance(leads, list) or not leads:
        return jsonify({"status": "error", "detail": "No leads selected to save."}), 400

    try:
        if target == "new":
            sheet_name = (body.get("sheet_name") or "").strip()
            if not sheet_name:
                return jsonify({"status": "error", "detail": "Give the new lead sheet a name."}), 400
            new_sheet_id = leads_writer.create_lead_sheet(sheet_name)
            entry = sheets_registry.add_sheet(sheet_name, new_sheet_id, bool(body.get("make_default")))
            sheet_id = entry["sheet_id"]
            sheet_display_name = entry["name"]
        else:
            sheet_key = (body.get("sheet_key") or "").strip()
            entry = sheets_registry.get_sheet(sheet_key) if sheet_key else sheets_registry.get_default_sheet()
            if not entry:
                return jsonify({"status": "error", "detail": "Pick an existing lead sheet, or create a new one."}), 400
            sheet_id = entry["sheet_id"]
            sheet_display_name = entry["name"]

        counts = leads_writer.add_leads_to_sheet(sheet_id, leads)
        counts.update({
            "status": "success",
            "sheet_name": sheet_display_name,
            "sheet_id": sheet_id,
            "message": (
                f"'{sheet_display_name}': {counts['added']} new lead(s) added, "
                f"{counts['duplicates_skipped']} duplicate(s) skipped, "
                f"{counts['selected']} selected."
            ),
        })
        return jsonify(counts)
    except MissingCredentialsError as e:
        return jsonify({"status": "error", "detail": str(e)}), 428
    except Exception as e:
        logger.error(f"Gate 2 save-leads failed: {e}")
        return jsonify({"status": "error", "detail": f"Could not save leads: {e}"}), 500

@app.route("/api/gate1/templates", methods=["GET"])
def list_gate1_templates():
    """Lists all saved Gate 1 email templates for the template picker/editor."""
    try:
        from gate1.template_loader import list_templates
    except Exception as e:
        logger.error(f"Gate 1 module import failed: {e}")
        return jsonify({"status": "error", "detail": f"Gate 1 backend failed to load: {e}"}), 500
    return jsonify({"status": "success", "templates": list_templates()})


@app.route("/api/gate1/templates/<name>", methods=["GET"])
def get_gate1_template(name):
    """Returns the raw text (Subject: line + body) of one saved template."""
    try:
        from gate1.template_loader import load_template_by_name, TemplateNotFoundError
    except Exception as e:
        logger.error(f"Gate 1 module import failed: {e}")
        return jsonify({"status": "error", "detail": f"Gate 1 backend failed to load: {e}"}), 500
    try:
        content = load_template_by_name(name)
        return jsonify({"status": "success", "name": name, "content": content})
    except TemplateNotFoundError as e:
        return jsonify({"status": "error", "detail": str(e)}), 404


@app.route("/api/gate1/templates/<name>", methods=["POST"])
def save_gate1_template(name):
    """Creates or overwrites a Gate 1 template. Body: {\"content\": \"Subject: ...\\n...\"}"""
    try:
        from gate1.template_loader import save_template, TemplateNotFoundError
    except Exception as e:
        logger.error(f"Gate 1 module import failed: {e}")
        return jsonify({"status": "error", "detail": f"Gate 1 backend failed to load: {e}"}), 500
    body = request.get_json(silent=True) or {}
    content = body.get("content", "")
    if not content.strip():
        return jsonify({"status": "error", "detail": "Template content cannot be empty."}), 400
    try:
        saved_name = save_template(name, content)
        return jsonify({"status": "success", "message": f"Template '{saved_name}' saved.", "name": saved_name})
    except TemplateNotFoundError as e:
        return jsonify({"status": "error", "detail": str(e)}), 400


@app.route("/api/gate1/resumes", methods=["GET"])
def list_gate1_resumes():
    """Lists all PDFs from output_resumes/, resume/, and root."""
    items = []
    seen = set()
    
    search_dirs = [
        os.path.join(BASE_DIR, "output_resumes"),
        os.path.join(BASE_DIR, "resume"),
        BASE_DIR
    ]
    
    for d in search_dirs:
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith(".pdf") and f not in seen:
                    seen.add(f)
                    full = os.path.join(d, f)
                    try:
                        items.append({"filename": f, "path": full, "modified": os.path.getmtime(full)})
                    except Exception:
                        pass
                        
    items.sort(key=lambda x: x.get("modified", 0), reverse=True)
    return jsonify({"status": "success", "resumes": items})

@app.route("/api/gate1/upload-resume", methods=["POST"])
def upload_gate1_resume_endpoint():
    """Uploads a PDF resume from user's computer to output_resumes/."""
    if 'file' not in request.files:
        return jsonify({"status": "error", "detail": "No file uploaded"}), 400
    f = request.files['file']
    if not f.filename or not f.filename.lower().endswith('.pdf'):
        return jsonify({"status": "error", "detail": "Please upload a valid PDF file"}), 400
        
    out_dir = os.path.join(BASE_DIR, "output_resumes")
    os.makedirs(out_dir, exist_ok=True)
    save_path = os.path.join(out_dir, f.filename)
    f.save(save_path)
    return jsonify({"status": "success", "filename": f.filename, "message": f"Uploaded {f.filename} successfully"})


@app.route("/api/gate1/send-emails", methods=["POST"])
def send_emails_endpoint():
    if not is_authorized(request):
        return jsonify({"status": "error", "detail": "🔒 Unauthorized: Master PIN required (₹4,999 Pro Access)"}), 401
    """
    Runs a Gate 1 cold-email campaign for a row range from the configured
    Google Sheet lead tracker. Validates emails, personalizes a role-matched
    template, attaches the latest resume PDF, and drafts/sends via Gmail.
    """
    logger.info("Gate 1 Outreach campaign requested.")
    try:
        body = request.get_json() or {}
    except Exception:
        return jsonify({"status": "error", "detail": "Invalid JSON body"}), 400

    try:
        start_row = int(body.get("start_row", 2))
        end_row = int(body.get("end_row", 10))
        if start_row < 2:
            start_row = 2
        if end_row < start_row:
            end_row = start_row
    except (TypeError, ValueError):
        return jsonify({"status": "error", "detail": "start_row and end_row must be numbers"}), 400

    mode = body.get("mode", "draft")
    if mode not in ("draft", "send"):
        return jsonify({"status": "error", "detail": "mode must be 'draft' or 'send'"}), 400

    sender_profile = body.get("sender_profile", {})
    # Gate 1 UI selections (both optional): explicit template name overrides the
    # per-role auto-match; explicit resume filename overrides the "most recent
    # PDF in output_resumes/" auto-pick. Used by Fast Apply and Advanced Mode.
    template_name = (body.get("template_name") or "").strip() or None
    resume_filename = (body.get("resume_filename") or "").strip() or None
    sheet_key = (body.get("sheet_key") or "").strip() or None
    sheet_id = (body.get("sheet_id") or "").strip() or None

    try:
        from gate1.outreach_engine import run_campaign, CampaignConfigError
        from gate1.google_auth import MissingCredentialsError
    except Exception as e:
        logger.error(f"Gate 1 module import failed (likely a missing pip package): {e}")
        return jsonify({
            "status": "error",
            "detail": f"Gate 1 backend failed to load — a required Python package is likely missing. "
                      f"Run 'pip install -r requirements.txt' in the project folder, then restart server.py. "
                      f"(Import error: {e})"
        }), 500

    try:
        custom_subject = (body.get("subject") or "").strip() or None
        custom_body = (body.get("template_body") or "").strip() or None
        force_draft = bool(body.get("force_draft", True))

        result = run_campaign(start_row, end_row, mode, sender_profile,
                               template_name=template_name, resume_filename=resume_filename,
                               sheet_key=sheet_key, sheet_id=sheet_id,
                               custom_subject=custom_subject, custom_body=custom_body,
                               force_draft=force_draft)
        return jsonify({"status": "success", "message": result.get("message", ""), **result})
    except MissingCredentialsError as e:
        return jsonify({"status": "error", "detail": str(e)}), 428  # Precondition Required
    except CampaignConfigError as e:
        return jsonify({"status": "error", "detail": str(e)}), 400
    except Exception as e:
        logger.error(f"Gate 1 campaign failed: {e}")
        return jsonify({"status": "error", "detail": f"Campaign error: {str(e)}"}), 500

# ==============================================================
# EXTRA FEATURE: AGENT ROUTER (CLAUDE / MULTI-MODEL) INTEGRATION
# ==============================================================
try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

import os

AGENT_ROUTER_API_KEY = os.environ.get("AGENT_ROUTER_API_KEY", "YOUR_AGENT_ROUTER_TOKEN")
AGENT_ROUTER_BASE_URL = "https://agentrouter.org/v1"

def call_agent_router_llm(prompt_text, system_prompt="You are a helpful AI assistant.", model_name="claude-3-5-sonnet"):
    if not OpenAI:
        return "Error: 'openai' library not installed. Run 'pip install openai' to use Agent Router."
        
    try:
        agent_client = OpenAI(
            api_key=AGENT_ROUTER_API_KEY,
            base_url=AGENT_ROUTER_BASE_URL
        )
        response = agent_client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt_text}
            ],
            temperature=0.7,
        )
        return response.choices[0].message.content
    except Exception as e:
        import logging
        logging.error(f"Agent Router Error: {e}")
        return f"Error connecting to Agent Router: {e}"










@app.route("/api/auth/verify-pin", methods=["POST"])
def verify_master_pin_route():
    data = request.get_json(silent=True) or {}
    pin = data.get("pin", "").strip()
    correct_pin = os.getenv("OUTREACH_MASTER_PIN", "shivam2026")
    if pin == correct_pin:
        return jsonify({"success": True, "message": "Authenticated"})
    return jsonify({"success": False, "error": "Invalid PIN"}), 401


@app.route("/api/gate1/sheet-rows", methods=["GET"])
def get_gate1_sheet_rows_endpoint():
    """Fetches active real lead rows from Google Sheet."""
    raw_id = request.args.get("sheet_id", "").strip() or os.getenv("GOOGLE_SHEET_ID", "1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI")
    
    # Extract clean 25+ char Google Sheet ID
    m = re.search(r'([a-zA-Z0-9-_]{25,})', raw_id)
    sheet_id = m.group(1) if m else "1lYkZAjqQQQGKTkxkLGUpNmcs4Wu68tPXo6JRa0PDimI"

    try:
        from gate1.google_auth import get_credentials
        from googleapiclient.discovery import build
        creds = get_credentials()
        service = build("sheets", "v4", credentials=creds)
        
        # Try fetching 'Leads' tab range first, fallback to default range
        raw_rows = []
        try:
            res = service.spreadsheets().values().get(spreadsheetId=sheet_id, range="Leads!A1:F100").execute()
            raw_rows = res.get("values", [])
        except Exception:
            res = service.spreadsheets().values().get(spreadsheetId=sheet_id, range="A1:F100").execute()
            raw_rows = res.get("values", [])
        
        parsed = []
        if len(raw_rows) > 1:
            for idx, r in enumerate(raw_rows[1:], start=2):
                if any(r):
                    parsed.append({
                        "row": idx,
                        "name": r[0] if len(r)>0 and r[0].strip() else "Hiring Team",
                        "email": r[1] if len(r)>1 else "",
                        "company": r[2] if len(r)>2 else "",
                        "role": r[3] if len(r)>3 else "",
                        "status": r[4] if len(r)>4 else "Pending"
                    })
        return jsonify({"status": "success", "sheet_id": sheet_id, "rows": parsed})
    except Exception as e:
        logger.error(f"Error fetching sheet rows for {sheet_id}: {e}")
        return jsonify({"status": "error", "detail": str(e)}), 500


# ═════════════════════════════════════════════════════════════════
# GATE 3: AUTONOMOUS JOB AGENT & RESUME TAILOR BACKEND APIS
# ═════════════════════════════════════════════════════════════════
import threading
import asyncio
from pathlib import Path

_gate3_state = {
    "is_scanning": False,
    "is_processing": False,
    "last_scan": None,
    "last_process": None,
    "logs": []
}

def _gate3_add_log(msg: str):
    t_str = time.strftime("%H:%M:%S")
    _gate3_state["logs"].append({"time": t_str, "msg": msg})
    if len(_gate3_state["logs"]) > 250:
        _gate3_state["logs"].pop(0)

@app.route("/gate3", methods=["GET"])
@app.route("/gate3.html", methods=["GET"])
def serve_gate3_page():
    gate3_file = os.path.join(BASE_DIR, "gate3.html")
    if os.path.exists(gate3_file):
        return send_from_directory(BASE_DIR, "gate3.html")
    return jsonify({"status": "error", "detail": "gate3.html not found"}), 404

@app.route("/api/gate3/stats", methods=["GET"])
def get_gate3_stats():
    try:
        from gate3.database import Database
        db = Database()
        return jsonify(db.get_stats())
    except Exception as e:
        logger.error(f"Gate 3 get_stats error: {e}")
        return jsonify({"status": "error", "detail": str(e)}), 500

@app.route("/api/gate3/jobs", methods=["GET"])
def get_gate3_jobs():
    try:
        from gate3.database import Database
        db = Database()
        limit = int(request.args.get("limit", 300))
        jobs = db.get_all_jobs(limit=limit)
        results = []
        for j in jobs:
            if hasattr(j, "model_dump"):
                results.append(j.model_dump())
            elif hasattr(j, "dict"):
                results.append(j.dict())
            elif hasattr(j, "__dict__"):
                results.append(j.__dict__)
            elif isinstance(j, dict):
                results.append(j)
        return jsonify(results)
    except Exception as e:
        logger.error(f"Gate 3 get_jobs error: {e}")
        return jsonify([]), 500

@app.route("/api/gate3/applications", methods=["GET"])
def get_gate3_applications():
    try:
        from gate3.database import Database
        from gate3.config import settings
        db = Database()
        apps = db.get_applications()
        results = []
        for a in apps:
            app_dict = a.model_dump()
            folder = Path(settings.output_dir) / a.id
            app_dict["has_docx"] = (folder / "resume.docx").exists()
            app_dict["has_cover_letter"] = (folder / "cover_letter.txt").exists()
            app_dict["has_analysis"] = (folder / "analysis.json").exists()
            results.append(app_dict)
        return jsonify(results)
    except Exception as e:
        logger.error(f"Gate 3 get_applications error: {e}")
        return jsonify([]), 500

@app.route("/api/gate3/applications/<app_id>/cover-letter", methods=["GET"])
def get_gate3_cover_letter(app_id):
    try:
        from gate3.config import settings
        file_path = Path(settings.output_dir) / app_id / "cover_letter.txt"
        if not file_path.exists():
            return jsonify({"status": "error", "detail": "Cover letter not found"}), 404
        return jsonify({"content": file_path.read_text(encoding="utf-8")})
    except Exception as e:
        return jsonify({"status": "error", "detail": str(e)}), 500

@app.route("/api/gate3/applications/<app_id>/analysis", methods=["GET"])
def get_gate3_analysis(app_id):
    try:
        from gate3.config import settings
        file_path = Path(settings.output_dir) / app_id / "analysis.json"
        if not file_path.exists():
            return jsonify({"status": "error", "detail": "Analysis not found"}), 404
        return jsonify(json.loads(file_path.read_text(encoding="utf-8")))
    except Exception as e:
        return jsonify({"status": "error", "detail": str(e)}), 500

@app.route("/api/gate3/download/<app_id>/resume", methods=["GET"])
def download_gate3_resume(app_id):
    try:
        from gate3.config import settings
        folder = Path(settings.output_dir) / app_id
        docx_file = folder / "resume.docx"
        if docx_file.exists():
            return send_from_directory(folder, "resume.docx", as_attachment=True, download_name=f"Resume_{app_id}.docx")
        pdf_file = folder / "resume.pdf"
        if pdf_file.exists():
            return send_from_directory(folder, "resume.pdf", as_attachment=True, download_name=f"Resume_{app_id}.pdf")
        return jsonify({"status": "error", "detail": "Resume file not found"}), 404
    except Exception as e:
        return jsonify({"status": "error", "detail": str(e)}), 500

def _run_gate3_scan_bg():
    global _gate3_state
    try:
        _gate3_state["is_scanning"] = True
        _gate3_add_log("Starting scan across Greenhouse and Lever boards...")
        from gate3.config import settings
        from gate3.orchestrator import Orchestrator
        cfg_path = Path(settings.data_dir) / "search_config.json"
        cfg = {}
        if cfg_path.exists():
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        resume_p = Path(settings.data_dir) / "resume.json"
        orch = Orchestrator(resume_path=resume_p, search_config=cfg)
        
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        jobs = loop.run_until_complete(orch.scan(check_all=True))
        from gate3.database import Database
        tot_jobs = Database().get_stats().get("total_jobs", 372)
        if len(jobs) > 0:
            _gate3_add_log(f"Scan complete! Discovered {len(jobs)} new postings (Total database: {tot_jobs} jobs).")
        else:
            _gate3_add_log(f"Scan complete! All {tot_jobs} postings up-to-date in database.")
    except Exception as e:
        logger.error(f"Gate 3 scan failed: {e}")
        _gate3_add_log(f"Scan error: {e}")
    finally:
        _gate3_state["is_scanning"] = False

@app.route("/api/gate3/trigger-scan", methods=["POST"])
def trigger_gate3_scan():
    if _gate3_state["is_scanning"]:
        return jsonify({"status": "already_running"})
    t = threading.Thread(target=_run_gate3_scan_bg, daemon=True)
    t.start()
    return jsonify({"status": "started"})

def _run_gate3_process_bg(min_score: float):
    global _gate3_state
    try:
        _gate3_state["is_processing"] = True
        _gate3_add_log(f"Starting resume tailoring pipeline (Min score threshold: {min_score}%)...")
        from gate3.config import settings
        from gate3.orchestrator import Orchestrator
        cfg_path = Path(settings.data_dir) / "search_config.json"
        cfg = {}
        if cfg_path.exists():
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        resume_p = Path(settings.data_dir) / "resume.json"
        orch = Orchestrator(resume_path=resume_p, search_config=cfg)
        
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        apps = loop.run_until_complete(orch.process_jobs(min_score=min_score))
        _gate3_add_log(f"Process complete! Tailored {len(apps)} applications.")
    except Exception as e:
        logger.error(f"Gate 3 process failed: {e}")
        _gate3_add_log(f"Process error: {e}")
    finally:
        _gate3_state["is_processing"] = False

@app.route("/api/gate3/trigger-process", methods=["POST"])
def trigger_gate3_process():
    if _gate3_state["is_processing"]:
        return jsonify({"status": "already_running"})
    min_score = float(request.args.get("min_score", 60.0))
    t = threading.Thread(target=_run_gate3_process_bg, args=(min_score,), daemon=True)
    t.start()
    return jsonify({"status": "started"})

@app.route("/api/gate3/status", methods=["GET"])
def get_gate3_status():
    return jsonify({
        "is_scanning": _gate3_state["is_scanning"],
        "is_processing": _gate3_state["is_processing"],
        "logs": _gate3_state["logs"][-20:]
    })

@app.route("/api/gate3/config", methods=["GET", "POST"])
def gate3_config_endpoint():
    from gate3.config import settings
    cfg_path = Path(settings.data_dir) / "search_config.json"
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return jsonify({"status": "success", "message": "Search configuration updated."})
    if cfg_path.exists():
        with open(cfg_path, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))
    return jsonify({})

@app.route("/api/gate3/resume-profile", methods=["GET", "POST"])
def gate3_resume_endpoint():
    from gate3.config import settings
    r_path = Path(settings.data_dir) / "resume.json"
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        with open(r_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return jsonify({"status": "success", "message": "Resume profile updated."})
    if r_path.exists():
        with open(r_path, "r", encoding="utf-8") as f:
            return jsonify(json.load(f))
    return jsonify({})

if __name__ == "__main__":
    # Start server on local port 8000
    print("🚀 Starting ResumeLLM Server on http://127.0.0.1:8000 ...")
    print("👉 Gate 3 Dashboard: http://127.0.0.1:8000/gate3")
    app.run(host="127.0.0.1", port=8000, debug=False)
