"""Cover letter generator with zero-dependency fallback."""

import json
import os
import urllib.request
import urllib.error

try:
    from groq import Groq
except ImportError:
    Groq = None

from ..config import settings
from ..models import JobPosting, ResumeData

SYSTEM_PROMPT = """You are an expert executive cover letter writer.
Write a concise, compelling cover letter (3 short paragraphs) tailored to the role."""


class CoverLetterGenerator:
    """Generates tailored cover letters."""

    def __init__(self):
        self.api_key = settings.groq_api_key or os.getenv("GROQ_API_KEY", "")
        if not self.api_key:
            try:
                from config import secrets_client
                groq_keys = secrets_client.get_active_keys("GLOBAL", "groq")
                if groq_keys:
                    self.api_key = groq_keys[0]
            except Exception:
                pass
        self.client = None
        if Groq and self.api_key:
            try:
                self.client = Groq(api_key=self.api_key)
            except Exception:
                self.client = None

    async def generate(self, resume: ResumeData, job: JobPosting) -> str:
        prompt = f"Candidate: {resume.contact.name if hasattr(resume, 'contact') else 'Shivam Gupta'}\nRole: {job.title} at {job.company}\nJD: {job.description[:2000]}"
        if self.client:
            try:
                res = self.client.chat.completions.create(
                    model=settings.llm_model,
                    max_tokens=800,
                    temperature=0.4,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt}
                    ]
                )
                return res.choices[0].message.content
            except Exception:
                pass

        # Direct HTTP fallback
        if self.api_key:
            try:
                url = "https://api.groq.com/openai/v1/chat/completions"
                headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
                payload = {
                    "model": settings.llm_model,
                    "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
                    "temperature": 0.4,
                    "max_tokens": 800
                }
                req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
                with urllib.request.urlopen(req, timeout=25) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    return data["choices"][0]["message"]["content"]
            except Exception:
                pass

        # Standard fallback template
        c_name = resume.contact.name if hasattr(resume, "contact") and hasattr(resume.contact, "name") and resume.contact.name else "Shivam Gupta"
        return f"""Dear Hiring Team at {job.company},

I am writing to express my strong interest in the {job.title} position. With my solid background in software development, machine learning, and scalable systems, I am excited about the opportunity to contribute to your team.

My experience aligns well with the technical challenges and requirements of this role. I have a proven track record of designing, building, and deploying performant applications that solve real-world problems.

I would welcome the opportunity to discuss how my technical skills and enthusiasm can benefit {job.company}. Thank you for your time and consideration.

Sincerely,
{c_name}"""
