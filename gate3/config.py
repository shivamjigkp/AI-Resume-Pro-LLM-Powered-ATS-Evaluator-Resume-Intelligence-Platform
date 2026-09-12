"""Application configuration with zero-dependency fallback."""

import os
from pathlib import Path

class Settings:
    def __init__(self):
        self.groq_api_key = os.getenv("GROQ_API_KEY", "")
        self.llm_model = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")
        self.llm_temperature = float(os.getenv("LLM_TEMPERATURE", "0.3"))

        self.adzuna_app_id = os.getenv("ADZUNA_APP_ID", "")
        self.adzuna_app_key = os.getenv("ADZUNA_APP_KEY", "")

        self.smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
        self.smtp_port = int(os.getenv("SMTP_PORT", "587"))
        self.smtp_user = os.getenv("SMTP_USER", "")
        self.smtp_password = os.getenv("SMTP_PASSWORD", "")
        self.from_email = os.getenv("FROM_EMAIL", "")

        self.linkedin_email = os.getenv("LINKEDIN_EMAIL", "")
        self.linkedin_password = os.getenv("LINKEDIN_PASSWORD", "")

        self.poll_interval_minutes = int(os.getenv("POLL_INTERVAL_MINUTES", "15"))
        self.max_applications_per_day = int(os.getenv("MAX_APPLICATIONS_PER_DAY", "20"))

        self.base_dir = Path(__file__).parent.parent
        self.data_dir = self.base_dir / "data"
        self.output_dir = self.base_dir / "output"
        self.templates_dir = self.base_dir / "templates"
        self.database_url = "sqlite:///data/gate3.db"

    def ensure_dirs(self) -> None:
        """Create required directories if they don't exist."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "jobs_cache").mkdir(exist_ok=True)
        (self.data_dir / "applications").mkdir(exist_ok=True)

settings = Settings()
