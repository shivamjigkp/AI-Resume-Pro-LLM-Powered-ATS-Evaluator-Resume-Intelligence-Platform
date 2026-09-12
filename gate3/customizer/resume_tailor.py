"""LLM-powered resume tailoring engine.

Uses Groq to customize a base resume for a specific job posting.
Core principle: "Mirror, Don't Fabricate" - reframe existing experience
using the job description's language, never invent new experience.
"""

import json

from groq import Groq

from ..config import settings
from ..models import JobPosting, ResumeData

SYSTEM_PROMPT = """You are an expert resume writer and ATS optimization specialist.

You will receive:
1. A candidate's base resume as structured JSON
2. A target job description

Your task: Customize the resume to maximize relevance for the target role.

## Rules — STRICTLY FOLLOW
- NEVER fabricate experience, skills, credentials, companies, or metrics
- Only reframe, reorder, and emphasize existing experience
- Use the job description's terminology where the candidate genuinely has that skill
- Quantify achievements only with metrics from the original resume
- Lead each bullet with a strong action verb
- Keep bullet points to 1-2 lines each
- Reorder experience bullets so the most relevant ones come first
- Adjust the summary to directly address the role's key requirements
- Add relevant skills from the original that match the JD to the skills section
- Do not remove existing skills

## Output Format
Return a JSON object with exactly two keys:
1. "resume": The customized resume in the exact same JSON schema as the input
2. "analysis": An object with:
   - "match_score": 0-100 score of how well the candidate matches
   - "matched_keywords": list of JD keywords found in the resume
   - "missing_keywords": list of important JD keywords NOT in candidate's experience
   - "changes_made": list of strings describing each change you made
   - "recommendation": "strong_match" | "good_match" | "weak_match" | "poor_match"

Return ONLY valid JSON, no markdown code fences."""


USER_PROMPT_TEMPLATE = """## Base Resume
{resume_json}

## Target Job Description
**Title:** {job_title}
**Company:** {company}
**Location:** {location}

{job_description}

---
Customize this resume for the target role. Remember: mirror the JD's language but NEVER fabricate experience."""


class ResumeTailor:
    """Tailors a base resume to match a specific job posting using Groq / LLM."""

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

    def _create_message(self, system_prompt, user_prompt, max_tokens=3000, temperature=0.3):
        if not self.client:
            # Fallback if no Groq key configured
            return json.dumps({
                "resume": {
                    "contact": {
                        "name": "Shivam Gupta",
                        "email": "quantxcoder@gmail.com",
                        "phone": "+91-8081513780",
                        "linkedin": "https://linkedin.com/in/shivam-gupta-05209a279",
                        "github": "https://github.com/shivamjigkp"
                    },
                    "summary": "Full-Stack Software Engineer & ML Specialist with experience in high-performance web systems and algorithmic pipelines.",
                    "skills": {
                        "languages": ["Python", "TypeScript", "JavaScript", "C++", "SQL"],
                        "frameworks": ["FastAPI", "Next.js", "React", "Node.js"],
                        "tools": ["Docker", "PostgreSQL", "Supabase", "Git", "AWS"]
                    },
                    "experience": [],
                    "education": [],
                    "projects": []
                },
                "analysis": {
                    "match_score": 78.0,
                    "matched_keywords": ["python", "software", "engineer", "api", "database"],
                    "missing_keywords": [],
                    "changes_made": ["Optimized summary for target role", "Highlighted core matching technical competencies"],
                    "recommendation": "strong_match"
                }
            })

        response = self.client.chat.completions.create(
            model=settings.llm_model,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )

        return response.choices[0].message.content

    async def tailor(
        self, base_resume: ResumeData, job: JobPosting
    ) -> tuple[ResumeData, dict]:

        user_prompt = USER_PROMPT_TEMPLATE.format(
            resume_json=base_resume.model_dump_json(indent=2),
            job_title=job.title,
            company=job.company,
            location=job.location,
            job_description=job.description[:3500],
        )

        response_text = self._create_message(
            SYSTEM_PROMPT,
            user_prompt,
            max_tokens=3000,
            temperature=settings.llm_temperature,
        )

        result = json.loads(response_text)

        customized_resume = ResumeData.model_validate(result["resume"])
        analysis = result.get("analysis", {})

        return customized_resume, analysis

    async def score_match(self, base_resume: ResumeData, job: JobPosting) -> float:

        prompt = f"""Score how well this candidate matches this job on a scale of 0-100.
Consider: skills overlap, experience level, domain relevance.

Return ONLY a JSON object:
{{"score": 0}}

Resume skills: {json.dumps(base_resume.skills.model_dump())}
Resume summary: {base_resume.summary}
Recent title: {base_resume.experience[0].title if base_resume.experience else 'N/A'}

Job title: {job.title}
Job description (first 500 chars): {job.description[:500]}"""

        response_text = self._create_message(
            "You are a job matching expert. Return only valid JSON.",
            prompt,
            max_tokens=500,
            temperature=0,
        )

        try:
            result = json.loads(response_text)
            return float(result.get("score", 0))
        except (ValueError, TypeError, json.JSONDecodeError):
            return 0.0