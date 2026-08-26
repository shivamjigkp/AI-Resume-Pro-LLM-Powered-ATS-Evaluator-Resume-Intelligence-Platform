# 🗺️ Complete Project Roadmap: Mapped MERN-style HTML + Python Outreach System

This roadmap maps your existing **`resume_builder_1.html`** (Mastermind Research Technologies Resume AI) as the primary UI controller, connected to a local Python backend that handles heavy-duty automation.

---

## 🏗️ Core System Pipeline (Unified Flow)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND: resume_builder_1.html                 │
│      (Template Gallery, Live ATS Score, Key Manager GUI, LocalStorage) │
└────────────────────────────────────────────────────────────────────────┘
                                 │  ▲
                 Local HTTP APIs │  │ JSON Data / Status Logs
                                 ▼  │
┌────────────────────────────────────────────────────────────────────────┐
│                        BACKEND: python_server.py                       │
│    (gspread Sheets, Gmail OAuth, Playwright CDP Form Filler, PyMuPDF)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚪 Mapped Module Breakdown

### 🎨 THE FRONTEND & UI — `resume_builder_1.html` (Updated)
* **Goal:** Act as the dashboard for all Gates.
* **Modifications:**
  * We will add new tabs/panels in the left sidebar:
    * `🎯 Gate 2: Lead Gen` (Inputs for Location/Role search, Scrape triggers, Import PDF).
    * `📧 Gate 1: Outreach` (Outbox settings: Drafts vs. Auto Send, Sheet row range selection).
    * `🌐 Gate 4: Autofill` (Port 9222 connection toggles).
  * Update the existing `Local API Keys` modal to sync directly with `secrets.json` on the backend.

---

### 🔍 GATE 2: Lead Generation (Scrapers & Parsers)
* **Status:** Triggered from HTML Frontend, processed by Python Backend.
* **Option 1: PDF Extractor** -> Upload PDF in browser -> Sends to Python backend -> Extracts text using PyMuPDF and cleans with Gemini key pool -> Inserts into Google Sheet.
* **Option 2: Career Scraper** -> Inputs company list in browser -> Python scrapes domains, career paths, and extracts email/roles -> Updates Sheet.
* **Option 3: AI Finder** -> Select location filter in browser -> Python searches LinkedIn and search engines -> Saves verified recruiter leads to Google Sheet.

---

### 🎯 GATE 3: Resume Tailoring Engine (The Core HTML Editor)
* **Status:** Mapped directly to `resume_builder_1.html`'s existing AI pipelines.
* **How it works:**
  * Uses the browser-side code inside `resume_builder_1.html` (which has multi-provider failover for Gemini, Groq, Nvidia, OpenRouter).
  * We will add the **3 tailored modes** (Company-wise, Role-wise, and Hybrid) directly into the UI prompts.
  * PDF printing uses the browser's native `window.print()` functionality, guaranteeing pixel-perfect PDF exports of any of the 15 templates.

---

### 📧 GATE 1: Email Outreach (The Outbox)
* **Status:** Triggered from HTML Frontend, executed via Gmail API on Python backend.
* **Mechanism:**
  * User selects row ranges and mode (Auto vs. Draft) in the browser.
  * Python reads data from Google Sheet, verifies email MX records, formats HTML email templates, attaches the compiled resume PDF, and sends/drafts the mail.
  * Live status is streamed back to the browser console.

---

### 🌐 GATE 4: Browser Automation (Playwright Autofill)
* **Status:** Playwright script runs on Python backend, controlled by the browser UI.
* **Mechanism:**
  * Connects over Port 9222 debugging stream.
  * Auto-types form data, maps custom questions via AI, and uploads the active tailored resume.

---

## 🔒 Security Rules & Guidelines (Mayank Shah Compliance)
* **Secrets Separation:** The HTML frontend saves keys inside local `secrets.json` on the backend. Keys are NEVER sent to git or external cloud systems.
* **Masked Displays:** Keys in the Settings panel will always be masked (`AIzaSy...4aB`).
* **Redacted Logs:** Console logs automatically filter API strings before outputting.

---

## 📅 Roadmap Mestones Checklist

* [x] **Milestone 1: Project Migration & Folder Setup** (Completed)
  * Mapped `resume_builder_1.html` into `JOB` directory, set `.gitignore`, `requirements.txt`, and configurations.
* [ ] **Milestone 2: Local Python Server & Backend API**
  * Create `python_server.py` (Flask/FastAPI) to host the HTML page locally and receive HTTP requests.
* [ ] **Milestone 3: Gate 2 Integration (Lead Gen UI & Backend)**
  * Add Lead Gen panel in the HTML and map endpoints to Python scrapers/parsers.
* [ ] **Milestone 4: Gate 3 Tailoring Prompts Upgrade**
  * Add the 3 options (Company, Role, Hybrid) inside the HTML JS code prompts.
* [ ] **Milestone 5: Gate 1 Integration (Email Outbox API)**
  * Connect the HTML email interface to the Gmail/Sheets Python backend.
* [ ] **Milestone 6: Gate 4 Integration (Browser Form-Filler CDP)**
  * Link browser autofill trigger button to Playwright.
* [x] **Milestone 7: Frontend UX Polish — Add / Edit / Delete Everywhere** (Completed)
  * Converted the plain "one-per-line" textareas for **School Records**, **Achievements**, and **Certifications** into proper row-based editors — each item now has its own editable input + a 🗑 delete button, plus a "+ Add" button, matching the existing Experience/Projects card UX.
  * Underlying data still syncs through the existing hidden `<textarea>` + `syncFormToD()` / `populateForm()` pipeline, so save/load, AI parsing, and PDF export were untouched.
* [x] **Milestone 8: SGResume — AI / Offline Mode Toggle** (Completed)
  * Added a **Mode** dropdown (`🤖 AI` / `⚡ Offline`) next to the "Generate SGResume" button.
  * Offline mode skips the AI call entirely and goes straight to the existing rule-based `sgFallbackTrim()` trimmer — no internet/API usage, font size unchanged.
  * AI mode behaves as before, with automatic fallback to the offline trimmer if the AI call fails.
* [x] **Milestone 9: Branding Update — Mastermind Research Technologies** (Completed)
  * Renamed the app across `<title>`, nav header (now a clickable link to `https://www.mastermindresearchtech.com/`), OpenRouter request header, and the exported JSON filename.
* [x] **Milestone 10: AI Reliability Fix — Provider Request Timeouts** (Completed)
  * Root cause of "AI analysis stuck loading forever": the AI provider calls (`callGemini`, `callGroq`, `callNvidia`, `callOpenRouter`, `callCustom`, `callFreeAI`) used plain `fetch()` with **no timeout**, so a slow/unreachable provider (most often the free fallback, since no paid key is configured) could hang indefinitely with the "AI acting as senior recruiter..." spinner stuck on screen.
  * Added a shared `fetchWithTimeout()` helper (AbortController-based) and wired it into all 6 provider calls — 25s timeout for keyed providers, 15s for the Free AI fallback. A slow provider now fails fast with a clear "Timed out..." error and the app moves on to the next provider / offline analysis instead of hanging.
  * **Not a wiring break from earlier changes** — this was a pre-existing gap in the AI-calling code, unrelated to the list-editor/branding/SGResume edits above; it's now fixed.
* [x] **Milestone 11: "Test All Configured Keys" Stuck Fix** (Completed)
  * `testKeys()` (the 🧪 button in the API Keys modal, seen stuck on "⏳ Testing Gemini..." / "⏳ Testing Free AI...") could hang for minutes because provider functions retry across multiple keys/models internally, even though each individual request now has a `fetchWithTimeout()`.
  * Added `withUiTimeout()` — a hard cap per provider at the UI level via `Promise.race`, so the test modal always resolves to ✅/❌ within a bounded time instead of sitting on "Testing..." forever.
* [x] **Milestone 12: Multi-Key Test False-Negative Fix** (Completed)
  * Root cause found: with **multiple Gemini keys** (or the model-fallback chains on Groq/NVIDIA/OpenRouter/Custom) configured, `testKeys()` was still looping through *every* key × *every* model, which can legitimately take longer than any reasonable UI timeout — even though the key itself works fine (confirmed: real resume analysis succeeded with the same key while the Test button showed ❌).
  * Added a `quickTest` mode to `callGemini`/`callGroq`/`callNvidia`/`callOpenRouter`/`callCustom`: when called from the Test button, each provider now checks only its **primary key + primary model, single attempt** — a fast, representative check. Full key/model rotation still runs normally during real AI calls (`callAI()` for resume analysis, SGResume, etc.) — nothing about production behavior changed, only the speed of the test itself.