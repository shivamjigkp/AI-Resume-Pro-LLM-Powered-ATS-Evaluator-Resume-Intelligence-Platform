import re

with open('server.py', 'r', encoding='utf-8') as f:
    text = f.read()

# Find the start of list_lead_sheets
start = text.find('@app.route("/api/gate1/sheets", methods=["GET"])')
# Find the next route
end = text.find('@app.route("/api/gate1/sheets", methods=["POST"])', start)

correct_func = '''@app.route("/api/gate1/sheets", methods=["GET"])
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

'''

text = text[:start] + correct_func + text[end:]

with open('server.py', 'w', encoding='utf-8') as f:
    f.write(text)
print("Fixed server.py")
