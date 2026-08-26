import sys
import os
import json
import logging
import traceback

# Add current directory to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from config import secrets_client
from gate4.browser_connector import is_chrome_debugging_active, get_active_browser_page
from playwright.sync_api import sync_playwright
from gate4.dom_mapper import extract_form_elements, generate_ai_mappings, autofill_form_elements

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("Debugger")

def test_autofill_pipeline():
    logger.info("Starting diagnostic check on active Chrome debug port...")
    
    # 1. Check debugging status
    if not is_chrome_debugging_active():
        logger.error("Chrome debugging port 9223 is OFFLINE. Make sure Chrome is started with remote debugging port active.")
        return
        
    logger.info("Chrome debugging port 9223 is ONLINE. Connecting Playwright...")
    
    # 2. Mock candidate resume profile data
    mock_resume = {
        "basics": {
            "name": "Shivam Gupta",
            "email": "quantxcoder@gmail.com",
            "phone": "+91-8081513780",
            "loc": "Noida, India",
            "li": "linkedin.com/in/shivam-gupta",
            "gh": "github.com/shivamjigkp",
            "port": "portfolio.dev"
        },
        "skills": {
            "lang": "C++, Python, JavaScript",
            "tools": "React, FastAPI, Docker",
            "cloud": "PostgreSQL, AWS"
        }
    }
    
    # 3. Connect Playwright & run pipeline elements sequentially to catch exact line failure
    try:
        with sync_playwright() as p:
            logger.info("Fetching active tab page...")
            page = get_active_browser_page(p)
            if not page:
                logger.error("Failed: Connected to CDP session, but no active tabs found.")
                return
                
            logger.info(f"Targeting active page: Title='{page.title()}', URL='{page.url}'")
            
            logger.info("Executing DOM elements extraction...")
            elements = extract_form_elements(page)
            logger.info(f"Found {len(elements)} form elements.")
            
            logger.info("Executing AI mapping generation...")
            mappings = generate_ai_mappings(elements, mock_resume)
            logger.info(f"Generated mappings: {json.dumps(mappings, indent=2)}")
            
            logger.info("Executing Playwright form filling...")
            filled = autofill_form_elements(page, mappings)
            if filled:
                logger.info("SUCCESS: Autofill script finished successfully without issues!")
            else:
                logger.error("Failed during automated typing phase.")
                
    except Exception as e:
        logger.error("CRITICAL EXCEPTION OCCURRED DURING PIPELINE CHECK:")
        traceback.print_exc()

if __name__ == "__main__":
    test_autofill_pipeline()
