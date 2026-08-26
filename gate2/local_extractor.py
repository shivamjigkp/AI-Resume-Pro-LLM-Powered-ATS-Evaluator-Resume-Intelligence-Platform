import os
import pymupdf
import logging
import re

logger = logging.getLogger("Gate2LocalExtractor")

def extract_local_leads(folder_path):
    leads = []
    if not os.path.exists(folder_path):
        return leads
        
    for filename in os.listdir(folder_path):
        if not filename.lower().endswith('.pdf'):
            continue
            
        file_path = os.path.join(folder_path, filename)
        try:
            doc = pymupdf.open(file_path)
            for page_num in range(len(doc)):
                page = doc[page_num]
                tabs = page.find_tables()
                if not tabs or not tabs.tables:
                    continue
                for tab in tabs.tables:
                    rows = tab.extract()
                    for row in rows:
                        if not row: continue
                        
                        # Find which column has the email
                        email_col = -1
                        for i, cell in enumerate(row):
                            if cell and '@' in str(cell):
                                email_col = i
                                break
                                
                        if email_col == -1:
                            continue
                            
                        email = str(row[email_col]).replace('\n', '').strip()
                        name = "Hiring Team"
                        company = "Unknown"
                        role = "HR / Recruiter"
                        
                        # Detect format 1: [SNo, Name, Email, Title, Company]
                        if len(row) >= 5 and email_col == 2:
                            name = str(row[1]).replace('\n', ' ').strip()
                            role = str(row[3]).replace('\n', ' ').strip()
                            company = str(row[4]).replace('\n', ' ').strip()
                        
                        # Detect format 2: [#, Company, Sector, Career Page, Apply Email]
                        elif len(row) >= 5 and email_col == 4:
                            company = str(row[1]).replace('\n', ' ').strip()
                            role = str(row[2]).replace('\n', ' ').strip()
                        
                        # Fallback heuristic
                        else:
                            if email_col > 0:
                                company = str(row[email_col - 1]).replace('\n', ' ').strip()
                                
                        if not name or len(name) < 2: name = "Hiring Team"
                        
                        leads.append({
                            "name": name,
                            "email": email,
                            "company": company,
                            "role": role,
                            "notes": f"Source: {filename}"
                        })
                        if len(leads) >= 500:
                            return leads
        except Exception as e:
            logger.error(f"Error reading {filename}: {e}")
            
    return leads
