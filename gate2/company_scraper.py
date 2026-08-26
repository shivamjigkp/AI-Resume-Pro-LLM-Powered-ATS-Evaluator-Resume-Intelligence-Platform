import requests
import re
import urllib.parse
import logging

logger = logging.getLogger("Gate2CompanyScraper")

def discover_companies(role, industry, location, keywords):
    query = f"{industry} companies in {location} hiring {role} careers {keywords}".strip()
    logger.info(f"Scraping companies for: {query}")
    
    url = "https://lite.duckduckgo.com/lite/"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    data = {"q": query}
    
    try:
        resp = requests.post(url, headers=headers, data=data, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        logger.error(f"Search failed: {e}")
        return []
        
    html = resp.text
    
    # Extract links from DuckDuckGo Lite HTML
    links = re.findall(r'<a[^>]*href="([^"]+)"[^>]*>([^<]+)</a>', html)
    
    leads = []
    seen_domains = set()
    
    for url, title in links:
        url = url.strip()
        if not url.startswith("http"): continue
        if any(x in url.lower() for x in ["duckduckgo.com", "bing.com", "yahoo.com", "google.com", "wikipedia", "glassdoor", "indeed", "linkedin"]):
            continue
            
        domain_match = re.search(r'https?://(?:www\.)?([^/]+)', url)
        if not domain_match: continue
        
        domain = domain_match.group(1).lower()
        if domain in seen_domains: continue
        seen_domains.add(domain)
        
        company_name = domain.split('.')[0].capitalize()
        
        # We guess the careers email. We can also use Agent Router later!
        guessed_email = f"careers@{domain}"
        
        leads.append({
            "name": f"HR / Recruiting - {company_name}",
            "email": guessed_email,
            "company": company_name,
            "role": "Recruitment / HR",
            "notes": f"Apply URL: {url}"
        })
        
        if len(leads) >= 20: break
            
    return leads
