"""Application configuration using pydantic-settings."""

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # AI
  # AI
    groq_api_key: str = ""
    llm_model: str = "llama-3.3-70b-versatile"
    llm_temperature: float = 0.3

    # Job Board APIs
    adzuna_app_id: str = ""
    adzuna_app_key: str = ""

    # Email
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    from_email: str = ""

    # LinkedIn
    linkedin_email: str = ""
    linkedin_password: str = ""

    # Monitoring
    poll_interval_minutes: int = 15
    max_applications_per_day: int = 20

    # Paths
    base_dir: Path = Field(default_factory=lambda: Path(__file__).parent.parent)
    data_dir: Path = Field(default_factory=lambda: Path(__file__).parent.parent / "data")
    output_dir: Path = Field(default_factory=lambda: Path(__file__).parent.parent / "output")
    templates_dir: Path = Field(
        default_factory=lambda: Path(__file__).parent.parent / "templates"
    )

    # Database
    database_url: str = "sqlite:///data/gate3.db"

    def ensure_dirs(self) -> None:
        """Create required directories if they don't exist."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "jobs_cache").mkdir(exist_ok=True)
        (self.data_dir / "applications").mkdir(exist_ok=True)


settings = Settings()
