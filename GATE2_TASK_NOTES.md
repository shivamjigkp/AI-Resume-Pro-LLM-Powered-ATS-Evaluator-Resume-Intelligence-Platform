Implement Gate 2 and improve Gate 1 spreadsheet management. Do not break existing Gate 1, Gate 4, templates, resume selection, or email workflow. OUTREACH TAB ORDER Keep this exact order: [Gate 1] [Gate 2] [Outreach] [Gate 4] GATE 2 — LEAD DISCOVERY & GOOGLE SHEETS

1. Gate 2 should be a clean clickable card/button in the Outreach area.
2. When the user clicks Gate 2, do NOT open a small sidebar, popup, or cramped panel. Open a large, dedicated, full-width expandable Gate 2 workspace below the main resume area, exactly like the SGResume / Gate 1 full-container behavior.
3. Gate 2 purpose:

* Search for companies/leads based on user-provided search criteria.
* Create a new Google Sheet lead list from search results.
* Allow the user to keep all results or choose only selected results.
* Remove duplicate leads automatically.
* Allow the list to be dynamically updated later by running a new search and adding only unique results.

4. Gate 2 UI should include:

* Search query / keywords
* Role
* Location
* Industry / company type
* Optional company name
* Search button
* Search results table with checkbox selection
* Select All / Deselect All
* Duplicate detection and removal
* Button: “Create New Lead Sheet”
* Input for lead-sheet name
* Button: “Add Selected Leads to Existing Sheet”
* Existing Google Sheet selector
* Preview of selected leads before saving
* Clear status/result messages

5. Each generated/updated Google Sheet should use a consistent lead schema: Name | Email | Company | Role | Status | Notes
6. Gate 2 should allow multiple saved lead sheets. Example:

* Software Engineer Leads
* Data Analyst Leads
* Delhi Startup Leads
* LinkedIn Search — August

7. When updating an existing lead sheet:

* Never create duplicate rows.
* Use email as the primary unique identifier when available.
* If email is missing, use a safe combination such as Name + Company + Role.
* Preserve existing Status and Notes values.
* Show how many new leads were added, how many duplicates were skipped, and how many results were selected. GATE 1 — MULTIPLE GOOGLE SHEET SUPPORT Currently Gate 1 uses one configured Google Sheet. Improve it so the user is not restricted to one sheet.

1. In the Gate 1 full workspace, add a “Lead Source / Google Sheet” section.
2. It should provide:

* Dropdown to select from saved Google Sheets
* Clearly show the currently active sheet
* Option to add/connect a new Google Sheet by Sheet ID
* Option to create a new blank lead sheet
* Option to refresh the saved sheet list
* Option to remove a saved sheet connection
* Ability to select which sheet will be used for the current draft/send campaign

3. Example UI: Lead Sheet: [Software Engineer Leads ▼] [Manage Sheets] [Refresh]
4. “Manage Sheets” should open a spacious panel inside the Gate 1 full workspace, not a small popup. It should allow:

* Add a Google Sheet
* Give it a display name
* Paste Sheet ID
* View saved sheets
* Choose default sheet
* Delete/remove a saved connection
* Open/select a sheet for the current campaign

5. Gate 1 must always display the selected lead sheet name before “Create Drafts” or “Send Emails”.
6. The selected sheet should be used for:

* Reading leads
* Skipping already Sent/Drafted leads
* Updating Status and Notes
* Preventing duplicate outreach on re-runs

7. Fast Apply should use the saved default lead sheet, but the user must still be able to change the sheet before running it. IMPORTANT UX RULES

* Gate 1 and Gate 2 must both be spacious, full-width, scrollable workspaces below the main website area.
* No fixed-height container; allow unlimited vertical content and normal scrolling.
* Keep original resume and SGResume independent and unchanged.
* Use clear labels, helpful empty states, and safe default behavior.
* Default email action must remain “Create Drafts”; direct send needs explicit user action/confirmation.                      This is a large, real codebase task. Let me read the docs and core files before touching anything.
Ran 11 commands, viewed 7 files, created a file · 4 notes
Read project docs
Read server.py
Read app.py
app.py is a legacy/unused Streamlit prototype — server.py (Flask) is the real backend. Let me check config.py, gate1 helpers, and then find the Gate 1/Outreach frontend section.
Read config.py
Read gate1 sheets helper
Read google_auth and outreach_engine
Grep for Gate references in HTML
Read resume_builder_1.html
Read resume_builder_1.html
Now let me view the full gate1Section (901-1073) and the sg-section CSS/pattern, plus the settings modal sheet-id block and JS around config load/save and Gate1 JS functions.
Read resume_builder_1.html
Find sg-section CSS rules
Good, this confirms `.sg-section` is the full-width workspace pattern (max-width 1700px, no fixed height, natural scroll). Now let's see the JS functions: openGate1Panel/closeGate1Panel, switchOutreachSubTab, and the config load/save section with gate1SheetIdInput.
Read resume_builder_1.html
Find JS function definitions relevant to Gate1
Read resume_builder_1.html
Read resume_builder_1.html
Read resume_builder_1.html
Architected modular sheet registry system with deduplication logic and fallback resolution.
Check requirements and remaining gate1 files
Check gitignore
Now I have a full picture. Let's implement the backend first.
Create the multi-sheet registry module for Gate 1 / Gate 2      dekho limit hit ho gyi to ye galti tum mat karna 80 % lage limit ho gyi turant file update