# ⚡ Modular Outreach System - Project Task Checklist

- [x] **Milestone 1: Project Setup & Mapped HTML Frontend Structure**
  - [x] Set up modular folder layout in `C:\Users\shiva\Downloads\antigravity game\JOB`.
  - [x] Configure `.gitignore` to prevent API keys and token leaks (Prompt 1 Check).
  - [x] Copy `resume_builder_1.html` as the main UI interface.
  - [x] Create template setup variables (`.env.example` and `secrets.json.example`).
  - [x] Write `config.py` with dynamic `SmartAPIClient` (masked logs, cooldowns, rotation).

- [x] **Milestone 2: Local Python Server & Configurations Synchronization API**
  - [x] Create `server.py` using FastAPI.
  - [x] Implement routing `/` to serve `resume_builder_1.html`.
  - [x] Implement `/api/config/get` and `/api/config/save` endpoints syncing to `.env` & `secrets.json`.
  - [x] Implement endpoint skeletons for Gate 1, Gate 2, and Gate 4.

- [ ] **Milestone 3: Gate 2 — Lead Generation (Independent Backend Module)**
  - [ ] Implement PDF Extractor (`gate2/pdf_parser.py` using PyMuPDF + Gemini).
  - [ ] Implement Career Page Scraper (`gate2/scraper.py` using requests/BS4).
  - [ ] Implement AI Lead Finder (`gate2/ai_finder.py` with location filters).
  - [ ] Connect HTML UI tab to call Gate 2 endpoints and show data preview tables.

- [ ] **Milestone 4: Gate 3 — Resume Tailoring Prompts Upgrade (Frontend UI)**
  - [ ] Add the 3 options (Company-wise, Role-wise, and Hybrid) in `resume_builder_1.html`.
  - [ ] Update JS Prompts (`buildP2Mapped`) with templates tailoring rules (Google XYZ formulas).
  - [ ] Verify browser-side key rotations and native `window.print()` PDF layouts.

- [x] **Milestone 5: Gate 1 — Email Outreach Backend Integrations**
  - [x] Implement Gmail API Authentication (`gate1/gmail_helper.py` + `gate1/google_auth.py`).
  - [x] Add MX DNS validation & syntax filters (`gate1/email_validator.py`).
  - [x] Load role template text files and map dynamic variables (`gate1/template_loader.py`, `gate1/templates/`).
  - [x] Integrate HTML outreach panel to trigger outbox sends / drafts (`triggerEmailOutreach()` → `/api/gate1/send-emails`).

- [x] **Milestone 6: Gate 4 — Playwright Form-Filler Automation**
  - [x] Implement dynamic page DOM scraper (`gate4/dom_mapper.py`).
  - [x] Connect Playwright over CDP remote debugging port 9223.
  - [x] Resolve browser profile lock and Lenovo Vantage conflicts.
  - [x] Implement resilient dropdown select & radio/checkbox click filling handlers.
  - [x] Add editable UI default heuristics form inputs in HTML.
  - [x] Sync UI defaults with Flask backend request payload.
  - [x] Test hybrid mapping execution flow with custom user defaults.

- [x] **Milestone 7: Frontend UX Polish (resume_builder_1.html)**
  - [x] School Records / Achievements / Certifications: replaced plain textareas with per-item Add + Edit + Delete row UI (🗑 delete, "+ Add" button), no change to underlying data sync (`syncFormToD`/`populateForm`).
  - [x] SGResume panel: added an AI / Offline **Mode** dropdown next to "Generate SGResume" — Offline mode calls the existing rule-based `sgFallbackTrim()` directly, skipping the AI request.
  - [x] Rebranded app to "Mastermind Research Technologies Resume AI" — page title, nav header (now links to `https://www.mastermindresearchtech.com/`), OpenRouter request header, exported JSON filename.
  - [x] Fixed AI analysis getting stuck indefinitely on "Scoring resume vs JD": added `fetchWithTimeout()` (AbortController, 25s for keyed providers / 15s for the Free AI fallback) to all 6 AI provider calls so a slow/unreachable provider now fails over quickly instead of hanging forever.
  - [x] Fixed "Test All Configured Keys" modal getting stuck on "⏳ Testing..." rows forever — added `withUiTimeout()`, a hard 20s per-provider cap at the UI level (`Promise.race`), so tests always resolve to ✅/❌.
