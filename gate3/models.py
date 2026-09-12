"""Core data models for the resume agent system with zero-dependency fallback."""

from datetime import datetime
from enum import Enum

try:
    from pydantic import BaseModel, Field
except ImportError:
    class BaseModel:
        def __init__(self, **kwargs):
            # Set default annotations if any
            for field, val in self.__class__.__dict__.items():
                if not field.startswith("_") and not callable(val):
                    setattr(self, field, val)
            for k, v in kwargs.items():
                setattr(self, k, v)

        def model_dump(self, mode="python"):
            d = {}
            for k, v in self.__dict__.items():
                if k.startswith("_"):
                    continue
                if hasattr(v, "model_dump"):
                    d[k] = v.model_dump(mode=mode)
                elif isinstance(v, list):
                    d[k] = [x.model_dump(mode=mode) if hasattr(x, "model_dump") else (x.value if hasattr(x, 'value') else x) for x in v]
                elif hasattr(v, "value"):
                    d[k] = v.value
                elif isinstance(v, datetime):
                    d[k] = v.isoformat() if mode == "json" else v
                else:
                    d[k] = v
            return d

        def dict(self, *args, **kwargs):
            return self.model_dump()

        @classmethod
        def model_validate(cls, obj):
            if isinstance(obj, dict):
                return cls(**obj)
            return obj

    def Field(default=None, default_factory=None, **kwargs):
        if default_factory is not None:
            return default_factory()
        return default

# ── Resume Schema ─────────────────────────────────────────────────────────────

class ContactInfo(BaseModel):
    name: str = ""
    email: str = ""
    phone: str = ""
    linkedin: str = ""
    github: str = ""
    website: str = ""
    location: str = ""


class ResumeBullet(BaseModel):
    text: str = ""
    tags: list = Field(default_factory=list)
    metrics: dict | None = None


class Experience(BaseModel):
    company: str = ""
    title: str = ""
    start_date: str = ""
    end_date: str = "Present"
    location: str = ""
    bullets: list = Field(default_factory=list)


class Education(BaseModel):
    institution: str = ""
    degree: str = ""
    field_of_study: str = ""
    start_date: str = ""
    end_date: str = ""
    gpa: str = ""
    highlights: list = Field(default_factory=list)


class Project(BaseModel):
    name: str = ""
    description: str = ""
    url: str = ""
    technologies: list = Field(default_factory=list)
    highlights: list = Field(default_factory=list)


class Skills(BaseModel):
    languages: list = Field(default_factory=list)
    frameworks: list = Field(default_factory=list)
    tools: list = Field(default_factory=list)
    platforms: list = Field(default_factory=list)
    certifications: list = Field(default_factory=list)
    other: list = Field(default_factory=list)


class ResumeData(BaseModel):
    contact: ContactInfo = Field(default_factory=ContactInfo)
    summary: str = ""
    experience: list = Field(default_factory=list)
    education: list = Field(default_factory=list)
    skills: Skills = Field(default_factory=Skills)
    projects: list = Field(default_factory=list)


class JobSource(str, Enum):
    ADZUNA = "adzuna"
    GREENHOUSE = "greenhouse"
    LEVER = "lever"
    LINKEDIN = "linkedin"
    COMPANY_SITE = "company_site"
    MANUAL = "manual"


class JobPosting(BaseModel):
    id: str = ""
    title: str = ""
    company: str = ""
    location: str = ""
    description: str = ""
    url: str = ""
    source: JobSource = JobSource.MANUAL
    salary_min: int | None = None
    salary_max: int | None = None
    posted_at: datetime | None = None
    discovered_at: datetime = Field(default_factory=datetime.utcnow)
    department: str = ""
    requirements: list = Field(default_factory=list)
    keywords: list = Field(default_factory=list)
    raw_data: dict = Field(default_factory=dict)


class SearchConfig(BaseModel):
    keywords: list = Field(default_factory=list)
    locations: list = Field(default_factory=lambda: ["remote", "US", "United States"])
    sources: list = Field(
        default_factory=lambda: [JobSource.GREENHOUSE, JobSource.LEVER, JobSource.ADZUNA]
    )
    greenhouse_companies: list = Field(default_factory=list)
    lever_companies: list = Field(default_factory=list)
    min_salary: int | None = None
    max_days_old: int = 7
    exclude_keywords: list = Field(default_factory=list)


class ApplicationStatus(str, Enum):
    DISCOVERED = "discovered"
    MATCHED = "matched"
    TAILORED = "tailored"
    RESUME_CUSTOMIZED = "tailored"
    READY = "ready"
    APPLIED = "applied"
    FAILED = "failed"
    INTERVIEW = "interview"
    REJECTED = "rejected"
    OFFER = "offer"


class Application(BaseModel):
    id: str = ""
    job: JobPosting | None = None
    job_id: str = ""
    job_title: str = ""
    company: str = ""
    job_url: str = ""
    resume_path: str = ""
    cover_letter_path: str = ""
    status: ApplicationStatus = ApplicationStatus.DISCOVERED
    match_score: float = 0.0
    customization_summary: str = ""
    notes: str = ""
    recruiter_name: str = ""
    applied_at: datetime | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class OutreachChannel(str, Enum):
    EMAIL = "email"
    LINKEDIN = "linkedin"

OutreachType = OutreachChannel


class OutreachMessage(BaseModel):
    id: str = ""
    application_id: str = ""
    recipient_name: str = ""
    recipient_email: str = ""
    recipient_linkedin: str = ""
    channel: OutreachChannel = OutreachChannel.EMAIL
    subject: str = ""
    body: str = ""
    status: str = "draft"
    sent_at: datetime | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
