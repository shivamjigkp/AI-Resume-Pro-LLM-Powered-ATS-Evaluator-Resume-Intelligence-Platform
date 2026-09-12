"""SQLite database for tracking jobs and applications."""

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from .models import Application, ApplicationStatus, JobPosting


class Database:
    def __init__(self, db_path: str | Path = "data/gate3.db"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._get_conn() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    data JSON NOT NULL,
                    discovered_at TEXT NOT NULL,
                    processed BOOLEAN DEFAULT FALSE
                );

                CREATE TABLE IF NOT EXISTS applications (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    data JSON NOT NULL,
                    status TEXT NOT NULL DEFAULT 'discovered',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (job_id) REFERENCES jobs(id)
                );

                CREATE TABLE IF NOT EXISTS outreach (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    application_id TEXT NOT NULL,
                    data JSON NOT NULL,
                    sent_at TEXT,
                    FOREIGN KEY (application_id) REFERENCES applications(id)
                );

                CREATE INDEX IF NOT EXISTS idx_jobs_discovered ON jobs(discovered_at);
                CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
                CREATE INDEX IF NOT EXISTS idx_apps_job ON applications(job_id);
            """)

    def save_job(self, job: JobPosting) -> bool:
        """Save a job posting. Returns True if it was new."""
        with self._get_conn() as conn:
            existing = conn.execute("SELECT id FROM jobs WHERE id = ?", (job.id,)).fetchone()
            if existing:
                return False
            conn.execute(
                "INSERT INTO jobs (id, data, discovered_at) VALUES (?, ?, ?)",
                (job.id, job.model_dump_json(), job.discovered_at.isoformat()),
            )
            return True

    def get_unprocessed_jobs(self) -> list[JobPosting]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT data FROM jobs WHERE processed = FALSE ORDER BY discovered_at DESC"
            ).fetchall()
            return [JobPosting.model_validate_json(row["data"]) for row in rows]

    def mark_job_processed(self, job_id: str) -> None:
        with self._get_conn() as conn:
            conn.execute("UPDATE jobs SET processed = TRUE WHERE id = ?", (job_id,))

    def save_application(self, app: Application) -> None:
        now = datetime.utcnow().isoformat()
        with self._get_conn() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO applications (id, job_id, data, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM applications WHERE id = ?), ?), ?)""",
                (app.id, app.job.id, app.model_dump_json(), app.status.value, app.id, now, now),
            )

    def get_applications(
        self, status: ApplicationStatus | None = None
    ) -> list[Application]:
        with self._get_conn() as conn:
            if status:
                rows = conn.execute(
                    "SELECT data FROM applications WHERE status = ? ORDER BY updated_at DESC",
                    (status.value,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT data FROM applications ORDER BY updated_at DESC"
                ).fetchall()
            return [Application.model_validate_json(row["data"]) for row in rows]

    def get_application(self, app_id: str) -> Application | None:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT data FROM applications WHERE id = ?", (app_id,)
            ).fetchone()
            if row:
                return Application.model_validate_json(row["data"])
            return None

    def get_todays_application_count(self) -> int:
        today = datetime.utcnow().strftime("%Y-%m-%d")
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*) as cnt FROM applications WHERE status = 'applied' AND updated_at LIKE ?",
                (f"{today}%",),
            ).fetchone()
            return row["cnt"] if row else 0

    def get_stats(self) -> dict[str, int]:
        with self._get_conn() as conn:
            stats = {}
            for status in ApplicationStatus:
                row = conn.execute(
                    "SELECT COUNT(*) as cnt FROM applications WHERE status = ?",
                    (status.value,),
                ).fetchone()
                stats[status.value] = row["cnt"] if row else 0
            row = conn.execute("SELECT COUNT(*) as cnt FROM jobs").fetchone()
            stats["total_jobs_discovered"] = row["cnt"] if row else 0
            return stats

    def get_all_jobs(self, limit: int = 100, offset: int = 0) -> list[JobPosting]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT data FROM jobs ORDER BY discovered_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            return [JobPosting.model_validate_json(row["data"]) for row in rows]

