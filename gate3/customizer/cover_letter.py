"""AI-powered cover letter generation using Groq."""

from groq import Groq

from ..config import settings
from ..models import JobPosting, ResumeData

SYSTEM_PROMPT = """You are an expert cover letter writer. You write compelling, concise cover letters
that connect a candidate's experience to a specific role.

## Rules
- 3-4 paragraphs, under 350 words
- Opening: mention the specific role and one compelling reason for interest (NOT "I am writing to apply")
- Body: connect 2-3 specific achievements from the resume to the job's key requirements, with metrics
- Closing: express enthusiasm and suggest next steps
- Tone: professional but warm, not stiff or generic
- Do NOT repeat the resume — add context, narrative, and motivation
- Do NOT use clichés like "passionate about" or "excited to leverage my skills"

Return ONLY the cover letter text, no commentary."""


USER_PROMPT_TEMPLATE = """## Candidate Background
Name: {name}
Current/Recent Role: {recent_role}
Summary: {summary}

Key Achievements:
{achievements}

## Target Role
Title: {job_title}
Company: {company}
Location: {location}

Job Description:
{job_description}

---
Write a personalized cover letter for this candidate applying to this role."""


class CoverLetterGenerator:
    """Generates personalized cover letters using Groq."""

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
        try:
            self.client = Groq(api_key=self.api_key) if self.api_key else None
        except Exception:
            self.client = None

    async def generate(self, resume: ResumeData, job: JobPosting) -> str:
        """Generate a cover letter tailored to the job."""

        if not self.client:
            return f"""Dear Hiring Team at {job.company},

I am writing to express my enthusiastic interest in the {job.title} position. With hands-on experience building production web platforms (Next.js, FastAPI, PostgreSQL) and data-driven systems, I am excited about the opportunity to contribute to your team.

Throughout my software development work, I have focused on translating business and user requirements into clean, performant, and reliable engineering solutions with sub-200ms latency and high reliability.

I would welcome the opportunity to discuss how my technical skills and builder mindset align with {job.company}'s engineering goals.

Warm regards,
{resume.contact.name}
{resume.contact.email} | {resume.contact.phone}"""

        achievements = []

        for exp in resume.experience[:3]:
            for bullet in exp.bullets[:3]:
                achievements.append(f"- [{exp.company}] {bullet.text}")

        user_prompt = USER_PROMPT_TEMPLATE.format(
            name=resume.contact.name,
            recent_role=(
                f"{resume.experience[0].title} at {resume.experience[0].company}"
                if resume.experience
                else "N/A"
            ),
            summary=resume.summary,
            achievements="\n".join(achievements) if achievements else "N/A",
            job_title=job.title,
            company=job.company,
            location=job.location,
            job_description=job.description[:3000],
        )

        response = self.client.chat.completions.create(
            model=settings.llm_model,
            max_tokens=2048,
            temperature=0.6,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )

        return response.choices[0].message.content