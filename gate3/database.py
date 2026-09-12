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
            results = []
            for row in rows:
                try:
                    if hasattr(JobPosting, "model_validate_json"):
                        results.append(JobPosting.model_validate_json(row["data"]))
                    else:
                        results.append(JobPosting.model_validate(json.loads(row["data"])))
                except Exception:
                    pass
            return results

    def mark_job_processed(self, job_id: str) -> None:
        with self._get_conn() as conn:
            conn.execute("UPDATE jobs SET processed = TRUE WHERE id = ?", (job_id,))

    def save_application(self, app: Application) -> None:
        now = datetime.utcnow().isoformat()
        job_id = app.job.id if (app.job and hasattr(app.job, 'id')) else app.job_id
        if app.job:
            app.job_id = getattr(app.job, 'id', '')
            app.company = getattr(app.job, 'company', '')
            app.job_title = getattr(app.job, 'title', '')
            app.job_url = getattr(app.job, 'url', '')
        dump_json = app.model_dump_json() if hasattr(app, "model_dump_json") else json.dumps(app.model_dump(), default=str)
        status_val = app.status.value if hasattr(app.status, 'value') else str(app.status)
        with self._get_conn() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO applications (id, job_id, data, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM applications WHERE id = ?), ?), ?)""",
                (app.id, job_id, dump_json, status_val, app.id, now, now),
            )

    def get_applications(
        self, status: ApplicationStatus | None = None
    ) -> list[Application]:
        with self._get_conn() as conn:
            if status:
                status_val = status.value if hasattr(status, 'value') else str(status)
                rows = conn.execute(
                    "SELECT data FROM applications WHERE status = ? ORDER BY updated_at DESC",
                    (status_val,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT data FROM applications ORDER BY updated_at DESC"
                ).fetchall()
            results = []
            for row in rows:
                try:
                    if hasattr(Application, "model_validate_json"):
                        results.append(Application.model_validate_json(row["data"]))
                    else:
                        results.append(Application.model_validate(json.loads(row["data"])))
                except Exception:
                    pass
            return results

    def get_application(self, app_id: str) -> Application | None:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT data FROM applications WHERE id = ?", (app_id,)
            ).fetchone()
            if row:
                if hasattr(Application, "model_validate_json"):
                    return Application.model_validate_json(row["data"])
                return Application.model_validate(json.loads(row["data"]))
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
                status_val = status.value if hasattr(status, 'value') else str(status)
                row = conn.execute(
                    "SELECT COUNT(*) as cnt FROM applications WHERE status = ?",
                    (status_val,),
                ).fetchone()
                stats[status_val] = row["cnt"] if row else 0
            
            row_jobs = conn.execute("SELECT COUNT(*) as cnt FROM jobs").fetchone()
            total_jobs = row_jobs["cnt"] if row_jobs else 0
            
            row_apps = conn.execute("SELECT COUNT(*) as cnt FROM applications").fetchone()
            total_apps = row_apps["cnt"] if row_apps else 0

            target_boards_cnt = 9
            cfg_path = Path(__file__).parent.parent / "data" / "search_config.json"
            if cfg_path.exists():
                try:
                    with open(cfg_path, "r", encoding="utf-8") as f:
                        cfg = json.load(f)
                        target_boards_cnt = len(cfg.get("greenhouse_companies", [])) + len(cfg.get("lever_companies", []))
                except Exception:
                    pass

            stats["total_jobs"] = total_jobs
            stats["total_jobs_discovered"] = total_jobs
            stats["tailored_resumes"] = total_apps
            stats["target_boards"] = target_boards_cnt
            stats["ready_to_apply"] = total_apps
            return stats

    def get_all_jobs(self, limit: int = 200, offset: int = 0) -> list[JobPosting]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT data FROM jobs ORDER BY discovered_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            results = []
            for row in rows:
                try:
                    if hasattr(JobPosting, "model_validate_json"):
                        results.append(JobPosting.model_validate_json(row["data"]))
                    else:
                        results.append(JobPosting.model_validate(json.loads(row["data"])))
                except Exception:
                    pass
            return results

