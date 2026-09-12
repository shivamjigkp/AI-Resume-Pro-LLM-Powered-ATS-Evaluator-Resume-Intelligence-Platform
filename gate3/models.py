"""Core data models for the resume agent system."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


# ── Resume Schema (extended JSON Resume) ──────────────────────────────────────


class ContactInfo(BaseModel):
    name: str
    email: str
    phone: str = ""
    linkedin: str = ""
    github: str = ""
    website: str = ""
    location: str = ""


class ResumeBullet(BaseModel):
    text: str
    tags: list[str] = Field(default_factory=list)
    metrics: dict[str, str | int | float] | None = None


class Experience(BaseModel):
    company: str
    title: str
    start_date: str
    end_date: str = "Present"
    location: str = ""
    bullets: list[ResumeBullet] = Field(default_factory=list)


class Education(BaseModel):
    institution: str
    degree: str
    field_of_study: str = ""
    start_date: str = ""
    end_date: str = ""
    gpa: str = ""
    highlights: list[str] = Field(default_factory=list)


class Project(BaseModel):
    name: str
    description: str
    url: str = ""
    technologies: list[str] = Field(default_factory=list)
    highlights: list[str] = Field(default_factory=list)


class Skills(BaseModel):
    languages: list[str] = Field(default_factory=list)
    frameworks: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    platforms: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    other: list[str] = Field(default_factory=list)


class ResumeData(BaseModel):
    """Source-of-truth resume data. All customizations derive from this."""

    contact: ContactInfo
    summary: str = ""
    experience: list[Experience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    skills: Skills = Field(default_factory=Skills)
    projects: list[Project] = Field(default_factory=list)


# ── Job Posting ───────────────────────────────────────────────────────────────


class JobSource(str, Enum):
    ADZUNA = "adzuna"
    GREENHOUSE = "greenhouse"
    LEVER = "lever"
    LINKEDIN = "linkedin"
    COMPANY_SITE = "company_site"
    MANUAL = "manual"


class JobPosting(BaseModel):
    """A discovered job posting."""

    id: str = Field(description="Unique identifier (source_externalid)")
    title: str
    company: str
    location: str = ""
    description: str
    url: str
    source: JobSource
    salary_min: int | None = None
    salary_max: int | None = None
    posted_at: datetime | None = None
    discovered_at: datetime = Field(default_factory=datetime.utcnow)
    tags: list[str] = Field(default_factory=list)
    remote: bool | None = None


# ── Application Tracking ─────────────────────────────────────────────────────


class ApplicationStatus(str, Enum):
    DISCOVERED = "discovered"
    RESUME_CUSTOMIZED = "resume_customized"
    APPLIED = "applied"
    FOLLOW_UP_SENT = "follow_up_sent"
    INTERVIEW = "interview"
    REJECTED = "rejected"
    OFFER = "offer"
    WITHDRAWN = "withdrawn"


class Application(BaseModel):
    """Tracks an individual job application."""

    id: str = Field(description="Unique application ID")
    job: JobPosting
    status: ApplicationStatus = ApplicationStatus.DISCOVERED
    resume_path: str = ""
    cover_letter_path: str = ""
    applied_at: datetime | None = None
    follow_up_dates: list[datetime] = Field(default_factory=list)
    recruiter_name: str = ""
    recruiter_email: str = ""
    recruiter_linkedin: str = ""
    notes: str = ""
    match_score: float = 0.0
    customization_summary: str = ""


# ── Outreach ──────────────────────────────────────────────────────────────────


class OutreachType(str, Enum):
    EMAIL = "email"
    LINKEDIN = "linkedin"


class OutreachMessage(BaseModel):
    """A recruiter outreach message."""

    application_id: str
    type: OutreachType
    recipient: str
    subject: str = ""
    body: str
    sent_at: datetime | None = None
    is_follow_up: bool = False
    follow_up_number: int = 0


class SearchConfig(BaseModel):
    """Configuration for automated job scans."""

    keywords: list[str] = Field(default_factory=list)
    location: str = ""
    remote_only: bool = False
    country: str = "us"
    greenhouse_companies: list[str] = Field(default_factory=list)
    lever_companies: list[str] = Field(default_factory=list)
    min_score: float = 60.0

