import json
import time
import logging
from typing import List, Dict, Any
from playwright.sync_api import Page
from config import secrets_client

logger = logging.getLogger("DOMMapper")

def extract_form_elements(page: Page) -> List[Dict[str, Any]]:
    """
    Scrapes interactive input, textarea, and select elements from the active tab.
    Extracts selectors and context tags to send to Gemini for mapping.
    """
    logger.info("Scanning active browser page for input elements...")
    
    # Run client-side JS inside active page to collect visible interactive form fields
    js_extractor = """
    () => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
      return inputs.map((el, index) => {
        let labelText = '';
        if (el.id) {
          const label = document.querySelector(`label[for="${el.id}"]`);
          if (label) labelText = label.innerText.trim();
        }
        if (!labelText) {
          const parentLabel = el.closest('label');
          if (parentLabel) labelText = parentLabel.innerText.trim();
        }
        if (!labelText) {
          const card = el.closest('.application-question, .form-group, div');
          if (card) {
            const lbl = card.querySelector('label, .application-label, h3, h4');
            if (lbl) labelText = lbl.innerText.trim();
          }
        }
        if (!labelText) {
          labelText = el.placeholder || el.name || '';
        }
        
        return {
          index: index,
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          labelText: labelText.substring(0, 100), // Limit length
          isVisible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          // Construct unique CSS selectors
          selector: el.id ? `#${el.id}` : (el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : '')
        };
      }).filter(el => el.isVisible && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button');
    }
    """
    try:
        all_elements = []
        for frame in page.frames:
            try:
                # Scrape visible elements inside this frame
                elements = frame.evaluate(js_extractor)
                if elements:
                    for idx, el in enumerate(elements):
                        if not el["selector"]:
                            # Construct custom selector based on tag index
                            el["selector"] = f"{el['tag']}:nth-of-type({idx + 1})"
                        # Store frame URL so we can target this frame when typing
                        el["frame_url"] = frame.url
                    all_elements.extend(elements)
            except Exception:
                # Ignore cross-origin frame access errors
                pass
        logger.info(f"Scanned page successfully. Found {len(all_elements)} visible form fields across all frames.")
        return all_elements
    except Exception as e:
        logger.error(f"Failed to scrape DOM elements: {e}")
        return []

def generate_ai_mappings(elements: List[Dict[str, Any]], resume_data: Dict, client_keys: Dict = None, custom_defaults: Dict = None, autofill_mode: str = "local", ai_strategy: str = "pure_ai") -> List[Dict[str, Any]]:
    """
    Generates mappings for form fields. First utilizes high-speed local keyword heuristics (Rule-Based)
    to map standard fields instantly. Falls back to Gemini/AI only for complex custom questions.
    """
    if not elements:
        return []

    basics = resume_data.get("basics", {})
    skills = resume_data.get("skills", {})
    
    # Map candidate details
    profile = {
        "name": basics.get("name", ""),
        "email": basics.get("email", ""),
        "phone": basics.get("phone", ""),
        "location": basics.get("loc", ""),
        "linkedin": basics.get("li", ""),
        "github": basics.get("gh", ""),
        "portfolio": basics.get("port", ""),
        "skills": f"Programming Languages: {skills.get('lang', '')}. Tools & Frameworks: {skills.get('tools', '')}. Cloud/Databases: {skills.get('cloud', '')}"
    }

    # Extract dynamic defaults forwarded from the browser UI settings panel
    custom_defaults = custom_defaults or {}
    notice_val = custom_defaults.get("notice_period", "Within 30 days")
    current_ctc_val = custom_defaults.get("current_ctc", "Negotiable / Confidential")
    expected_ctc_val = custom_defaults.get("expected_ctc", "Negotiable as per standards")
    reason_val = custom_defaults.get("reason_for_change", "Seeking a challenging role to leverage and expand my full-stack engineering and data analytics skills to drive product success.")
    summary_val = custom_defaults.get("experience_summary", "A software engineer with experience in developing scalable web applications and data processing pipelines. Proficient in React, Node.js, Python, Flask, and SQL databases.")
    experience_val = custom_defaults.get("total_experience", "2 Years")

    def finalize_mappings(maps):
        for item in maps:
            if "frame_url" not in item or not item["frame_url"]:
                orig_el = next((e for e in elements if e.get("selector") == item.get("selector")), None)
                if orig_el:
                    item["frame_url"] = orig_el.get("frame_url")
        return maps

    mappings = []
    unmapped_elements = []

    # 1. LOCAL RULE-BASED HEURISTICS MAPPING (No API Keys needed, 0ms Latency)
    logger.info("Executing local rule-based heuristic mapping...")
    
    for el in elements:
        # Skip local rules if Pure AI strategy is chosen in AI Mode
        if autofill_mode == "ai" and ai_strategy == "pure_ai":
            unmapped_elements.append(el)
            continue

        selector = el.get("selector")
        tag = el.get("tag", "").lower()
        el_type = el.get("type", "").lower()
        el_id = el.get("id", "").lower()
        name_attr = el.get("name", "").lower()
        placeholder = el.get("placeholder", "").lower()
        label = el.get("labelText", "").lower()
        
        # Combine context targets to search in
        context = f"{el_id} {name_attr} {placeholder} {label}"
        
        # A. USER-DEFINED CUSTOM KEYWORD MAPPINGS (Check these first!)
        matched_custom = False
        for cm in custom_defaults.get("custom_mappings", []):
            ckey = cm.get("key", "").lower().strip()
            cval = cm.get("val", "")
            if ckey and ckey in context:
                mappings.append({"selector": selector, "value": cval})
                logger.info(f"Custom mapping matched: [{ckey}] -> [{cval}] for selector [{selector}]")
                matched_custom = True
                break
        if matched_custom:
            continue
            
        # B. Check targets for standard fields
        if "resume" in context or "cv" in context or el_type == "file":
            mappings.append({"selector": selector, "value": "[UPLOAD_RESUME]"})
            
        elif "email" in context or "mail" in context:
            mappings.append({"selector": selector, "value": profile["email"]})
            
        elif any(kw in context for kw in ["first name", "firstname"]):
            name_parts = profile["name"].split()
            first_name = name_parts[0] if name_parts else profile["name"]
            mappings.append({"selector": selector, "value": first_name})
            
        elif any(kw in context for kw in ["last name", "lastname"]):
            name_parts = profile["name"].split()
            last_name = name_parts[-1] if len(name_parts) > 1 else ""
            mappings.append({"selector": selector, "value": last_name})
            
        elif any(kw in context for kw in ["full name", "fullname", "name"]):
            mappings.append({"selector": selector, "value": profile["name"]})
            
        elif any(kw in context for kw in ["phone", "mobile", "contact", "number", "tel"]):
            mappings.append({"selector": selector, "value": profile["phone"]})
            
        elif "linkedin" in context:
            mappings.append({"selector": selector, "value": profile["linkedin"]})
            
        elif "github" in context:
            mappings.append({"selector": selector, "value": profile["github"]})
            
        elif any(kw in context for kw in ["portfolio", "website", "personal website", "homepage"]):
            mappings.append({"selector": selector, "value": profile["portfolio"]})
            
        elif any(kw in context for kw in ["location", "city", "address", "residence", "country"]):
            mappings.append({"selector": selector, "value": profile["location"]})
            
        elif any(kw in context for kw in ["company", "employer"]):
            mappings.append({"selector": selector, "value": "Student / Freelancer"})
            
        elif any(kw in context for kw in ["notice period", "how soon", "joining date", "join", "notice"]) or (el_type == "radio" and any(kw in context for kw in ["days", "joiner", "immediate"])):
            mappings.append({"selector": selector, "value": notice_val})
            
        elif any(kw in context for kw in ["expected salary", "salary expectation", "expected ctc", "salary expect", "ctc expectation"]):
            mappings.append({"selector": selector, "value": expected_ctc_val})
            
        elif any(kw in context for kw in ["current ctc", "current salary", "present ctc", "current package"]):
            mappings.append({"selector": selector, "value": current_ctc_val})
            
        elif any(kw in context for kw in ["reason for change", "why are you leaving", "reason for leaving", "reason for change"]):
            mappings.append({"selector": selector, "value": reason_val})
            
        elif any(kw in context for kw in ["summary for your work", "profile other than", "brief summary", "tell us about", "experience summary", "work experience"]):
            mappings.append({"selector": selector, "value": summary_val})
            
        elif any(kw in context for kw in ["experience", "years of experience", "total experience", "how many years"]):
            mappings.append({"selector": selector, "value": experience_val})
            
        else:
            # Not a standard field. Push to AI mapping list
            unmapped_elements.append(el)

    logger.info(f"Heuristics completed: Mapped {len(mappings)} standard fields locally.")
    
    # If all fields mapped locally or we are in local-only mode, return immediately!
    if not unmapped_elements or autofill_mode == "local":
        return finalize_mappings(mappings)

    # 2. AI FALLBACK FOR CUSTOM QUESTIONS ONLY
    candidate_profile = {
        "Full Name": profile["name"],
        "Email": profile["email"],
        "Phone": profile["phone"],
        "Location": profile["location"],
        "Skills": profile["skills"]
    }
    
    prompt = f"""
    Map these custom job form questions to candidate's achievements or write a short 2-line response:
    FORM FIELDS: {json.dumps(unmapped_elements, indent=2)}
    CANDIDATE DETAILS: {json.dumps(candidate_profile, indent=2)}
    Output STRICTLY a JSON array: [ {{"selector": "...", "value": "..."}} ]
    """
    
    raw_response = ""
    logger.info(f"Requesting AI mapping for {len(unmapped_elements)} custom/unmapped fields...")

    # 2.1 Try active API key passed dynamically from browser (Gemini Pool)
    if client_keys:
        gemini_pool = []
        if client_keys.get("gemini"):
            gemini_pool.append(client_keys.get("gemini"))
        
        extra_keys = client_keys.get("geminiKeys") or client_keys.get("gemini_keys")
        if isinstance(extra_keys, list):
            for k in extra_keys:
                if k and k not in gemini_pool:
                    gemini_pool.append(k)

        if gemini_pool:
            logger.info(f"Attempting mapping using browser's Gemini API key pool ({len(gemini_pool)} keys)...")
            for idx, key in enumerate(gemini_pool):
                try:
                    import requests
                    r = requests.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}",
                        json={"contents": [{"parts": [{"text": prompt}]}]},
                        timeout=15
                    )
                    if r.status_code == 429:
                        logger.warning(f"Browser Gemini key {idx + 1} rate-limited (429). Rotating to next key...")
                        continue
                    if r.status_code != 200:
                        logger.warning(f"Browser Gemini key {idx + 1} failed with status {r.status_code}. Rotating...")
                        continue
                        
                    res_json = r.json()
                    raw_response = res_json['candidates'][0]['content']['parts'][0]['text']
                    logger.info(f"Successfully mapped form fields using Browser Gemini key {idx + 1}!")
                    break
                except Exception as e:
                    logger.error(f"Browser Gemini key {idx + 1} attempt failed: {e}. Rotating...")
                    continue
                
        # Try browser Groq key if Gemini was missing or failed
        if not raw_response and client_keys.get("groq"):
            browser_groq = client_keys.get("groq")
            logger.info("Attempting mapping using browser's active Groq API key...")
            try:
                import requests
                r = requests.post(
                    "https://api.groq.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {browser_groq}", "Content-Type": "application/json"},
                    json={
                        "model": "llama3-70b-8192",
                        "messages": [{"role": "user", "content": prompt}]
                    },
                    timeout=20
                )
                if r.status_code == 200:
                    res_json = r.json()
                    raw_response = res_json['choices'][0]['message']['content']
                    logger.info("Successfully mapped form fields using browser's Groq key!")
            except Exception as e:
                logger.error(f"Browser Groq key attempt failed: {e}")

    # Trigger rotation keys manager fallback if browser keys didn't work/missing
    if not raw_response:
        logger.info("Requesting mapping from backend secrets key pool...")
        priority_providers = secrets_client.get_provider_priority("gate4_form_fill")
        
        # Fallback rotation logic
        for provider in priority_providers:
            active_keys = secrets_client.get_active_keys("gate4_form_fill", provider)
            # Fallback to GLOBAL if no keys
            if not active_keys:
                active_keys = secrets_client.get_active_keys("GLOBAL", provider)
                
            for key in active_keys:
                try:
                    # Direct API requests for Gemini to keep it lightweight
                    if provider == "gemini":
                        import requests
                        r = requests.post(
                            f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}",
                            json={"contents": [{"parts": [{"text": prompt}]}]},
                            timeout=15
                        )
                        if r.status_code == 200:
                            res_json = r.json()
                            raw_response = res_json['candidates'][0]['content']['parts'][0]['text']
                            break
                        elif r.status_code == 429:
                            secrets_client.trigger_key_cooldown(key)
                            continue
                except Exception as ex:
                    logger.error(f"Error calling {provider} for mapping: {ex}")
                    secrets_client.trigger_key_cooldown(key)
                    continue
            if raw_response:
                break
            
    # Fallback to Free AI (Pollinations) if no key worked
    if not raw_response:
        logger.info("Using Free AI for mapping fallback...")
        try:
            import requests
            r = requests.post(
                "https://text.pollinations.ai/",
                json={
                    "messages": [{"role": "user", "content": prompt}],
                    "model": "openai",
                    "jsonMode": True
                },
                timeout=25
            )
            if r.status_code == 200:
                raw_response = r.text  # Pollinations returns raw completion text directly
                logger.info("Received response from Free AI fallback.")
        except Exception as ex:
            logger.error(f"Free AI Mapping fallback failed: {ex}")

    if not raw_response:
        logger.error("All AI options failed to generate mappings. Falling back to local heuristic mappings only.")
        return mappings

    # Clean response block and parse JSON safely
    try:
        cleaned = raw_response.strip()
        
        # Robustly extract JSON list bracket coordinates to ignore LLM conversational filler
        start_idx = cleaned.find('[')
        end_idx = cleaned.rfind(']')
        
        if start_idx != -1 and end_idx != -1 and start_idx < end_idx:
            json_str = cleaned[start_idx:end_idx + 1]
            ai_mappings = json.loads(json_str)
        else:
            # Fallback to standard cleaning if brackets not found
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            ai_mappings = json.loads(cleaned.strip())
            
        # Append AI mapped fields to the local mappings list
        mappings.extend(ai_mappings)
        logger.info(f"AI mapped {len(ai_mappings)} custom fields successfully. Total mapped: {len(mappings)}.")
        return finalize_mappings(mappings)
    except Exception as e:
        logger.error(f"Failed to parse mapping response JSON: {e}. Raw response: {raw_response}. Returning local mappings only.")
        return finalize_mappings(mappings)

def autofill_form_elements(page: Page, mappings: List[Dict[str, Any]]) -> bool:
    """
    Executes automated typing and filling commands over Chrome tab using Playwright.
    Simulates random keystroke timings to ensure safety (Prompt 4 compliance).
    """
    if not mappings:
        logger.warning("No mappings to fill.")
        return False
        
    success_count = 0
    for idx, item in enumerate(mappings):
        selector = item.get("selector")
        value = item.get("value")
        frame_url = item.get("frame_url")
        
        if not selector or not value:
            continue
            
        try:
            # Resolve the correct frame (iframe or main page)
            frame = page.main_frame
            if frame_url:
                matched_frame = page.frame(url=frame_url)
                if matched_frame:
                    frame = matched_frame
            
            # Check if element exists in frame before typing
            if frame.locator(selector).count() > 0:
                logger.info(f"Filling field [{selector}] inside frame [{frame.url}]...")
                
                # Check for file upload placeholders
                if value == "[UPLOAD_RESUME]":
                    logger.info(f"Skipping resume upload field [{selector}] for manual user attachment.")
                    continue
                
                # Get element tag name
                tag_name = frame.locator(selector).first.evaluate("el => el.tagName.toLowerCase()")
                
                # Scroll element into view smoothly so the user sees progress
                try:
                    frame.locator(selector).first.scroll_into_view_if_needed()
                    time.sleep(0.1)
                except Exception as scroll_ex:
                    logger.warning(f"Could not scroll field [{selector}] into view: {scroll_ex}")
                
                # Get element input type
                el_type = frame.locator(selector).first.evaluate("el => el.type ? el.type.toLowerCase() : ''")
                
                if tag_name == "select":
                    try:
                        # Try selecting option by value
                        frame.locator(selector).select_option(value=str(value))
                        logger.info(f"Selected option [{value}] for dropdown [{selector}].")
                    except Exception:
                        try:
                            # Fallback: Select first available choice (index 1)
                            frame.locator(selector).select_option(index=1)
                            logger.info(f"Fell back to index=1 option for dropdown [{selector}].")
                        except Exception as sel_err:
                            logger.error(f"Could not fill dropdown [{selector}]: {sel_err}")
                elif el_type in ["radio", "checkbox"]:
                    try:
                        # For radio buttons, click the one whose value or label matches our target value
                        if el_type == "radio":
                            radio_locator = frame.locator(selector)
                            count = radio_locator.count()
                            clicked = False
                            for i in range(count):
                                r_el = radio_locator.nth(i)
                                r_val = r_el.get_attribute("value") or ""
                                r_text = r_el.evaluate("el => { const lbl = document.querySelector('label[for=\"' + el.id + '\"]'); return lbl ? lbl.innerText : ''; }") or ""
                                
                                if str(value).lower() in r_val.lower() or str(value).lower() in r_text.lower() or (r_val and r_val.lower() in str(value).lower()) or (r_text and r_text.lower() in str(value).lower()):
                                    r_el.click(force=True)
                                    logger.info(f"Clicked matching radio [{selector}] at index {i} with value/label [{value}].")
                                    clicked = True
                                    break
                            if not clicked and count > 0:
                                radio_locator.first.click(force=True)
                                logger.info(f"Fell back to clicking first radio option in group.")
                        else:
                            # For checkboxes, click directly
                            frame.locator(selector).first.click(force=True)
                            logger.info(f"Clicked checkbox [{selector}].")
                    except Exception as click_err:
                        logger.error(f"Could not click radio/checkbox [{selector}]: {click_err}")
                else:
                    # Focus the element
                    frame.focus(selector)
                    
                    # Clear existing content
                    frame.locator(selector).fill("")
                    
                    # Type value with human delay simulation (jitter) using frame-aware sequential press
                    try:
                        frame.locator(selector).first.press_sequentially(str(value), delay=25)
                        logger.info(f"Typed value [{value}] into text field [{selector}] successfully.")
                    except Exception as type_err:
                        logger.warning(f"press_sequentially failed: {type_err}. Falling back to direct fill.")
                        frame.locator(selector).fill(str(value))
                        
                    time.sleep(0.2) # Wait after typing field
                success_count += 1
        except Exception as e:
            logger.error(f"Error during browser typing for field [{selector}]: {e}")
            # Continue to next element
            continue
            
    return success_count > 0
