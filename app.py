import streamlit as st
import json
import os
from config import secrets_client, SECRETS_FILE, GOOGLE_SHEET_ID, BASE_RESUME_PATH, EMAIL_DELAY_SECONDS, AUTOFILL_WAIT_MS

# Configure Streamlit page options
st.set_page_config(
    page_title="Modular Outreach System",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="expanded"
)

# ---------------------------------------------------------
# Sidebar Navigation
# ---------------------------------------------------------
st.sidebar.title("⚡ Job Outreach Agent")
st.sidebar.markdown("---")

current_page = st.sidebar.radio(
    "Navigate Modules:",
    [
        "🔑 Settings & API Config",
        "🔍 Gate 2: Lead Gen",
        "🎯 Gate 3: Resume Tailoring",
        "📧 Gate 1: Email Outreach",
        "🌐 Gate 4: Browser Autofill",
        "🚀 Full Pipeline (End-to-End)"
    ]
)

st.sidebar.markdown("---")
st.sidebar.info("All operations and API keys are stored locally on your machine.")

# Helper to save configs
def save_gui_secrets(updated_secrets):
    if secrets_client.save_secrets(updated_secrets):
        st.success("Configuration saved successfully!")
        st.rerun()
    else:
        st.error("Failed to save configuration.")

# ---------------------------------------------------------
# PAGE 1: API Config & Settings
# ---------------------------------------------------------
if current_page == "🔑 Settings & API Config":
    st.title("🔑 API Settings & Global Configurations")
    st.write("Configure your API keys, safety delays, and Google Sheets integrations here.")
    
    # Reload fresh configs
    secrets_client.secrets_data = secrets_client._load_secrets()
    current_data = secrets_client.secrets_data
    
    tab_global, tab_sections, tab_system = st.tabs([
        "🌍 Global API Keys", 
        "🧩 Section Overrides", 
        "⚙️ System Paths & Delays"
    ])
    
    with tab_global:
        st.subheader("Global API Keys")
        st.caption("Keys configured here act as default keys and will be rotated automatically.")
        
        # Load existing keys or empty strings
        gemini_keys_val = "\n".join(current_data.get("GLOBAL", {}).get("gemini_keys", []))
        groq_keys_val = "\n".join(current_data.get("GLOBAL", {}).get("groq_keys", []))
        
        col1, col2 = st.columns(2)
        with col1:
            g_keys = st.text_area(
                "Gemini API Keys (One per line):", 
                value=gemini_keys_val,
                height=180,
                help="Add multiple Gemini keys to bypass rate limits. They will rotate automatically.",
                type="password"  # Masked input for privacy (Prompt 1 Check)
            )
        with col2:
            gr_keys = st.text_area(
                "Groq API Keys (One per line):", 
                value=groq_keys_val,
                height=180,
                type="password"
            )
            
        priority_list = current_data.get("GLOBAL", {}).get("provider_priority", ["gemini", "groq", "free_ai"])
        priority_str = ", ".join(priority_list)
        new_priority = st.text_input(
            "Global Provider Priority (Comma separated):",
            value=priority_str,
            help="Order of models used. e.g. gemini, groq, free_ai"
        )

    with tab_sections:
        st.subheader("Section API Overrides")
        st.caption("Dedicated keys for specific gates to prevent cross-rate-limiting.")
        
        sections_data = current_data.get("SECTIONS", {})
        
        st.markdown("**Gate 3: Resume Tailoring dedicated keys**")
        g3_gemini = st.text_area(
            "Gemini Keys for Resume Tailoring (One per line):",
            value="\n".join(sections_data.get("gate3_resume_tailor", {}).get("gemini_keys", [])),
            height=100,
            type="password"
        )
        
        st.markdown("---")
        st.markdown("**Gate 2: Lead Gen dedicated keys**")
        g2_gemini = st.text_area(
            "Gemini Keys for Lead Generation (One per line):",
            value="\n".join(sections_data.get("gate2_lead_gen", {}).get("gemini_keys", [])),
            height=100,
            type="password"
        )

    with tab_system:
        st.subheader("System Paths & Safety Delays")
        
        sheet_id = st.text_input(
            "Google Sheet ID:",
            value=GOOGLE_SHEET_ID,
            help="ID of your Google Sheet Tracker."
        )
        
        resume_path = st.text_input(
            "Base Resume (.docx) Path:",
            value=BASE_RESUME_PATH,
            help="Path to your master base resume file."
        )
        
        col_delay, col_wait = st.columns(2)
        with col_delay:
            delay_sec = st.number_input(
                "Email Outreach Delay (Seconds):",
                min_value=5,
                max_value=300,
                value=EMAIL_DELAY_SECONDS,
                help="Safety gap between cold emails to prevent spam classification."
            )
        with col_wait:
            wait_ms = st.number_input(
                "Autofill DOM Wait (Milliseconds):",
                min_value=500,
                max_value=10000,
                value=AUTOFILL_WAIT_MS,
                step=500
            )

    # Save button trigger
    if st.button("Save Configurations", type="primary"):
        # Format input keys
        gemini_list = [k.strip() for k in g_keys.split("\n") if k.strip()]
        groq_list = [k.strip() for k in gr_keys.split("\n") if k.strip()]
        priority_parsed = [p.strip().lower() for p in new_priority.split(",") if p.strip()]
        
        g3_gemini_list = [k.strip() for k in g3_gemini.split("\n") if k.strip()]
        g2_gemini_list = [k.strip() for k in g2_gemini.split("\n") if k.strip()]
        
        # Build secrets schema
        updated_data = {
            "GLOBAL": {
                "gemini_keys": gemini_list,
                "groq_keys": groq_list,
                "nvidia_keys": current_data.get("GLOBAL", {}).get("nvidia_keys", []),
                "openrouter_keys": current_data.get("GLOBAL", {}).get("openrouter_keys", []),
                "provider_priority": priority_parsed
            },
            "SECTIONS": {
                "gate2_lead_gen": {
                    "gemini_keys": g2_gemini_list,
                    "provider_priority": ["gemini", "free_ai"]
                },
                "gate3_resume_tailor": {
                    "gemini_keys": g3_gemini_list,
                    "provider_priority": ["gemini", "groq"]
                },
                "gate4_form_fill": {
                    "gemini_keys": [],
                    "provider_priority": ["gemini", "free_ai"]
                }
            }
        }
        
        # Save .env configurations
        with open(".env", "w") as env_file:
            env_file.write(f'GOOGLE_SHEET_ID="{sheet_id}"\n')
            env_file.write(f'BASE_RESUME_PATH="{resume_path}"\n')
            env_file.write(f'EMAIL_DELAY_SECONDS={delay_sec}\n')
            env_file.write(f'AUTOFILL_WAIT_MS={wait_ms}\n')
            
        save_gui_secrets(updated_data)

# ---------------------------------------------------------
# Placeholder pages for other Gates (Modular Development)
# ---------------------------------------------------------
elif current_page == "🔍 Gate 2: Lead Gen":
    st.title("🔍 Gate 2: Lead Generation")
    st.info("Module layout placeholder. This component will handle PDF Imports, Career Page Scraping, and AI Finder.")

elif current_page == "🎯 Gate 3: Resume Tailoring":
    st.title("🎯 Gate 3: Resume Tailoring")
    st.info("Module layout placeholder. This component will tailor your base resume docx and export customized PDFs.")

elif current_page == "📧 Gate 1: Email Outreach":
    st.title("📧 Gate 1: Email Outreach")
    st.info("Module layout placeholder. This component handles Gmail validations, template swaps, and draft generation.")

elif current_page == "🌐 Gate 4: Browser Autofill":
    st.title("🌐 Gate 4: Browser Autofill")
    st.info("Module layout placeholder. This component autofills job applications on active browser tabs via Port 9222.")

elif current_page == "🚀 Full Pipeline (End-to-End)":
    st.title("🚀 Full Pipeline Integration")
    st.info("Unified end-to-end flow control will be unlocked after verifying all separate Gate modules.")
