import requests
from typing import Optional
from playwright.sync_api import sync_playwright, Page
import logging

logger = logging.getLogger("BrowserConnector")

CDP_URL = "http://127.0.0.1:9223"

def is_chrome_debugging_active() -> bool:
    """Checks if Chrome is running with remote-debugging-port=9222 active."""
    try:
        response = requests.get(f"{CDP_URL}/json/version", timeout=2)
        if response.status_code == 200:
            return True
    except Exception:
        pass
    return False

def get_active_browser_page(playwright_instance) -> Optional[Page]:
    """
    Connects to the Chrome session over CDP and returns the active tab (page).
    """
    if not is_chrome_debugging_active():
        logger.error("Chrome debugging port 9223 is offline. Ensure Chrome is running with --remote-debugging-port=9223.")
        return None

    try:
        # 1. Connect to existing Chrome browser over CDP
        browser = playwright_instance.chromium.connect_over_cdp(CDP_URL)
        contexts = browser.contexts
        if not contexts:
            logger.error("No active browser contexts found.")
            return None
        
        context = contexts[0]
        pages = context.pages
        if not pages:
            logger.error("No active tabs/pages found in Chrome.")
            return None
        
        ignore_keywords = ["127.0.0.1", "localhost", "about:blank", "vantage", "lenovo", "widget", "extensions"]
        active_page = None
        
        # 2. Query DevTools HTTP /json list to see the most recently focused target url
        active_url = None
        try:
            res = requests.get(f"{CDP_URL}/json", timeout=2)
            if res.status_code == 200:
                targets = res.json()
                for target in targets:
                    if target.get("type") == "page":
                        t_url = target.get("url", "")
                        if t_url and not any(kw in t_url.lower() for kw in ignore_keywords):
                            active_url = t_url
                            logger.info(f"CDP /json reports active focused page URL: {active_url}")
                            break
        except Exception as json_ex:
            logger.warning(f"Could not query DevTools /json list for active page: {json_ex}")
            
        # 3. Match the active_url with Playwright pages
        if active_url:
            # Exact match
            for p in pages:
                if p.url.strip("/").lower() == active_url.strip("/").lower():
                    active_page = p
                    break
            
            # Substring match fallback
            if not active_page:
                for p in pages:
                    if p.url.lower() in active_url.lower() or active_url.lower() in p.url.lower():
                        active_page = p
                        break
        
        # 4. VisibilityState fallback
        if not active_page:
            for p in pages:
                url = p.url.lower()
                if any(kw in url for kw in ignore_keywords):
                    continue
                try:
                    visibility_state = p.evaluate("document.visibilityState")
                    if visibility_state == "visible":
                        active_page = p
                        break
                except Exception as e:
                    logger.debug(f"Could not check visibilityState for page {url}: {e}")
                    continue
                
        # 5. First non-ignored tab fallback
        if not active_page:
            for p in pages:
                url = p.url.lower()
                if any(kw in url for kw in ignore_keywords):
                    continue
                active_page = p
                break
            
        # Final fallback to first page if all else fails
        if not active_page:
            active_page = pages[0]
            
        logger.info(f"Targeting tab: '{active_page.title()}' at URL: {active_page.url}")
        return active_page
    except Exception as e:
        logger.error(f"Error connecting over CDP: {e}")
        return None
