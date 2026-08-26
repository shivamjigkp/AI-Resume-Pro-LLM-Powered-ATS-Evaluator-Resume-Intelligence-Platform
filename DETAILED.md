# 📄 Software Requirements Specification (SRS) — Mapped HTML + Python Architecture

This document specifies the interface mappings and technical APIs linking the HTML frontend (`resume_builder_1.html`) to the local Python backend controller (`python_server.py`).

---

## 1. Mapped System Architecture

```
┌────────────────────────────────────────────────────────┐
│             FRONTEND: resume_builder_1.html            │
│  - Edits 15 PDF Templates                              │
│  - Executes client-side AI tailoring (Gemini/Groq/etc)  │
│  - Makes fetch() calls to local Python backend APIs   │
└────────────────────────────────────────────────────────┘
                           │  ▲
           Local HTTP APIs │  │ JSON response / stream
                           ▼  │
┌────────────────────────────────────────────────────────┐
│             BACKEND: python_server.py (FastAPI)        │
│  - Serves static HTML and files                        │
│  - Gate 1: Gmail API Outbox & MX validation            │
│  - Gate 2: Google Sheets connector, BS4 Crawler        │
│  - Gate 4: Playwright Chrome CDP Connection (Port 9222) │
└────────────────────────────────────────────────────────┘
```

---

## 2. Backend API Endpoint Specifications

The Python backend (`python_server.py`) will expose the following endpoints to be called by `resume_builder_1.html`:

### 2.1 API Config Synchronization
* **Endpoint:** `POST /api/config/save`
* **Request Body:** JSON object representing `secrets.json` schema.
* **Backend Action:** Writes to local `secrets.json` and updates `.env`.

### 2.2 Gate 2: Extract PDF Contacts
* **Endpoint:** `POST /api/gate2/import-pdf`
* **Request Body:** Form-Data containing PDF file.
* **Backend Action:** Extracts text via PyMuPDF -> parses to JSON with Gemini rotation client -> Appends to Google Sheet -> returns count.

### 2.3 Gate 2: Career Scraper
* **Endpoint:** `POST /api/gate2/scrape-companies`
* **Request Body:** `{"companies": ["Google", "Zerodha"]}`
* **Backend Action:** Runs scraping threads to discover career domains and email patterns -> Saves to sheet.

### 2.4 Gate 1: Outbox Sender
* **Endpoint:** `POST /api/gate1/send-emails`
* **Request Body:** `{"start_row": 2, "end_row": 15, "mode": "draft"}`  # Mode can be 'draft' or 'send'
* **Backend Action:** Fetches sheet rows -> validates MX records -> creates Gmail drafts/sends emails -> updates status.

### 2.5 Gate 4: Playwright Autofill
* **Endpoint:** `POST /api/gate4/autofill`
* **Request Body:** `{"resume_data": {...}}`
* **Backend Action:** Playwright connects over CDP (port 9222) -> Scrapes active browser DOM -> Maps fields via AI -> Fills input tags.

---

## 3.Mappping UI Elements inside `resume_builder_1.html`

To integrate all Gates inside the existing HTML page, we will add an **Outreach Dashboard Section** inside the Left Sidebar panel (replacing or adding to the current tabs).

### 3.1 Mapped HTML Layout Updates:
```html
<!-- Mapped Outreach Tabs inside Sidebar -->
<div class="tabs" id="tabBar">
  <button class="tab active" data-tab="jd">🎯 JD & ATS</button>
  <button class="tab" data-tab="upload">📥 Upload</button>
  <button class="tab" data-tab="basics">👤 Basics</button>
  <button class="tab" data-tab="outreach">📧 Outreach & Gates</button> <!-- NEW TAB -->
</div>
```

Inside the new `outreach` pane:
```html
<div class="pane" id="pane-outreach">
  <h3>🔍 Gate 2: Lead Generation</h3>
  <button onclick="triggerPdfImport()">Upload Contacts PDF</button>
  <button onclick="triggerAIFinder()">Find Leads (AI)</button>
  
  <hr>
  <h3>📧 Gate 1: Email Outreach</h3>
  <label>Sheet Row Range:</label>
  <input type="number" id="startRow" value="2"> to <input type="number" id="endRow" value="20">
  <select id="outboxMode">
    <option value="draft">Create Drafts (Safe)</option>
    <option value="send">Auto Send (Delayed)</option>
  </select>
  <button onclick="runEmailOutbox()">Execute Outreach</button>
  
  <hr>
  <h3>🌐 Gate 4: Application Filler</h3>
  <button onclick="runBrowserAutofill()">⚡ Autofill Active Chrome Tab</button>
</div>
```

---

## 4. Prompt Mapping for Gate 3 Resume Tailoring

We map the Resume Tailoring prompts directly inside the existing `callAI()` JavaScript logic inside `resume_builder_1.html`. 

We will upgrade `buildP2` (the rewrite prompt) to support the three custom modes:

```javascript
function buildP2Mapped(jd, mode, company, role) {
  let modeInstructions = "";
  if (mode === "company") {
    modeInstructions = `Align summary and project tech stack keywords with ${company}'s domain and tech profile.`;
  } else if (mode === "role") {
    modeInstructions = `Re-order experiences. Prioritize tasks and algorithms highly relevant to a ${role} position.`;
  } else {
    modeInstructions = `Apply both: Align keywords with ${company} and re-order bullet priorities to match ${role}.`;
  }
  
  return `Rewrite my resume to fit this Job Description.
          
          MODE INSTRUCTIONS: ${modeInstructions}
          ... (Google XYZ rules)`;
}
```

---

## 8. Changelog — Frontend (`resume_builder_1.html`)

* **Add / Edit / Delete UX:** School Records, Achievements, and Certifications sections now render as individual editable rows (input + 🗑 delete + "+ Add"), instead of raw multi-line textareas. Underlying data model and sync (`syncFormToD`, `populateForm`) unchanged.
* **SGResume Mode Toggle:** New `Mode` dropdown (`AI` / `Offline`) beside "Generate SGResume". Offline mode calls `sgFallbackTrim()` directly with zero AI/network calls.
* **Branding:** App renamed to "Mastermind Research Technologies Resume AI" across `<title>`, nav header (linked to `https://www.mastermindresearchtech.com/`), OpenRouter request header, and exported JSON filename.
* **AI Reliability Fix:** All AI provider calls (`callGemini`, `callGroq`, `callNvidia`, `callOpenRouter`, `callCustom`, `callFreeAI`) now go through a shared `fetchWithTimeout()` helper (AbortController-based) instead of raw `fetch()`. Fixes the AI analysis step hanging indefinitely when a provider (most often the Free AI fallback, when no paid key is set) is slow or unreachable. Timeouts: 25s for keyed providers, 15s for the Free AI fallback.
