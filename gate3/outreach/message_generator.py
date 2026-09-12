"""AI-powered outreach message generation for recruiter contact using Groq."""

import json
import os
import urllib.request

try:
    from groq import Groq
except ImportError:
    Groq = None

from ..config import settings
from ..models import Application, ResumeData


SYSTEM_PROMPT = """You write concise, personalized recruiter outreach messages.

## Rules
- Keep messages under 150 words
- Be specific about the role and why you're a fit
- Reference 1-2 concrete achievements with metrics
- End with a clear, low-friction ask
- Be professional but human — no corporate-speak
- For follow-ups: reference the previous message, add new value
- NEVER be pushy or desperate

Return ONLY the message body, no subject line unless asked."""


INITIAL_TEMPLATE = """Write a recruiter outreach message.

Candidate: {name}
Current role: {current_role}
Top achievement: {achievement}

Target role: {job_title} at {company}
Recruiter name: {recruiter_name}

Context: The candidate {application_context}"""


FOLLOW_UP_TEMPLATE = """Write follow-up #{follow_up_number} to a recruiter.

Candidate: {name}
Role applied for: {job_title} at {company}
Recruiter: {recruiter_name}
Days since last contact: {days_since}
Previous message summary: {previous_summary}

Keep it brief (under 100 words). Add value — mention a relevant recent achievement, article, or industry insight. Don't just "check in"."""


class OutreachMessageGenerator:
    """AI-powered outreach message generation for recruiter contact."""

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

    def _generate(self, prompt: str, max_tokens: int = 512, temperature: float = 0.6) -> str:
        if self.client:
            try:
                response = self.client.chat.completions.create(
                    model=settings.llm_model,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                )
                return response.choices[0].message.content.strip()
            except Exception:
                pass
        
        # HTTP fallback
        if self.api_key:
            try:
                url = "https://api.groq.com/openai/v1/chat/completions"
                headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
                payload = {
                    "model": settings.llm_model,
                    "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "max_tokens": max_tokens
                }
                req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    return data["choices"][0]["message"]["content"].strip()
            except Exception:
                pass

        return f"Hi Hiring Team, I recently reviewed the open position and would love to connect regarding how my engineering background aligns with your current technical goals. Looking forward to discussing further."

    async def generate_initial(
        self,
        resume: ResumeData,
        application: Application,
    ) -> str:
        """Generate an initial outreach message to a recruiter."""

        achievement = "N/A"

        if resume.experience and resume.experience[0].bullets:
            achievement = resume.experience[0].bullets[0].text

        context = (
            "has applied for the role"
            if application.applied_at
            else "is interested in the role"
        )

        prompt = INITIAL_TEMPLATE.format(
            name=resume.contact.name,
            current_role=(
                f"{resume.experience[0].title} at {resume.experience[0].company}"
                if resume.experience
                else "N/A"
            ),
            achievement=achievement,
            job_title=application.job.title,
            company=application.job.company,
            recruiter_name=application.recruiter_name or "Hiring Manager",
            application_context=context,
        )

        return self._generate(prompt, max_tokens=512, temperature=0.6)

    async def generate_follow_up(
        self,
        resume: ResumeData,
        application: Application,
        follow_up_number: int,
        days_since_last: int,
        previous_summary: str = "",
    ) -> str:
        """Generate a follow-up message."""

        prompt = FOLLOW_UP_TEMPLATE.format(
            name=resume.contact.name,
            job_title=application.job.title,
            company=application.job.company,
            recruiter_name=application.recruiter_name or "Hiring Manager",
            follow_up_number=follow_up_number,
            days_since=days_since_last,
            previous_summary=(
                previous_summary
                or "Initial outreach expressing interest in the role"
            ),
        )

        return self._generate(prompt, max_tokens=256, temperature=0.6)

    async def generate_email_subject(
        self,
        application: Application,
        is_follow_up: bool = False,
    ) -> str:
        """Generate an email subject line."""

        if is_follow_up:
            return f"Re: {application.job.title} at {application.job.company}"

        prompt = f"""Write a short, specific email subject line for reaching out about a
{application.job.title} role at {application.job.company}.
No generic subjects like "Job Inquiry".
Make it specific and compelling.
Return ONLY the subject line."""

        response = self.client.chat.completions.create(
            model=settings.llm_model,
            max_tokens=50,
            temperature=0.7,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        )

        return response.choices[0].message.content.strip().strip('"')