"""Adzuna job board API monitor.

Adzuna aggregates jobs from thousands of sources and provides a free API.
Docs: https://developer.adzuna.com/
"""

from datetime import datetime, timedelta

try:
    import httpx
except ImportError:
    httpx = None
    import urllib.request
    import json

from ..config import settings
from ..models import JobPosting, JobSource
from .base import JobMonitor


class AdzunaMonitor(JobMonitor):
    """Monitor jobs via the Adzuna API.

    Adzuna is a job aggregator with a free developer API covering
    multiple countries. It pulls from company career pages, job boards,
    and recruitment agencies.
    """

    BASE_URL = "https://api.adzuna.com/v1/api/jobs"

    def __init__(self, country: str = "us"):
        self.country = country
        self.app_id = settings.adzuna_app_id
        self.app_key = settings.adzuna_app_key

    async def search(
        self,
        keywords: list[str],
        location: str = "",
        remote_only: bool = False,
    ) -> list[JobPosting]:
        query = " ".join(keywords)
        params: dict[str, str | int] = {
            "app_id": self.app_id,
            "app_key": self.app_key,
            "what": query,
            "results_per_page": 50,
            "sort_by": "date",
            "content-type": "application/json",
        }
        if location:
            params["where"] = location
        if remote_only:
            params["what"] = f"{query} remote"

        url = f"{self.BASE_URL}/{self.country}/search/1"

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        return [self._parse_result(r) for r in data.get("results", [])]

    async def check_new(
        self,
        keywords: list[str],
        location: str = "",
        since_minutes: int = 60,
    ) -> list[JobPosting]:
        cutoff = datetime.utcnow() - timedelta(minutes=since_minutes)
        # Adzuna supports max_days_old parameter
        max_days = max(1, since_minutes // (60 * 24) + 1)

        query = " ".join(keywords)
        params: dict[str, str | int] = {
            "app_id": self.app_id,
            "app_key": self.app_key,
            "what": query,
            "results_per_page": 50,
            "sort_by": "date",
            "max_days_old": max_days,
            "content-type": "application/json",
        }
        if location:
            params["where"] = location

        url = f"{self.BASE_URL}/{self.country}/search/1"

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        jobs = []
        for r in data.get("results", []):
            job = self._parse_result(r)
            if job.posted_at and job.posted_at >= cutoff:
                jobs.append(job)
            elif not job.posted_at:
                # If no posted date, include it (might be new)
                jobs.append(job)

        return jobs

    def _parse_result(self, result: dict) -> JobPosting:
        posted_at = None
        if result.get("created"):
            try:
                posted_at = datetime.fromisoformat(
                    result["created"].replace("Z", "+00:00")
                )
            except (ValueError, TypeError):
                pass

        salary_min = None
        salary_max = None
        if result.get("salary_min"):
            salary_min = int(result["salary_min"])
        if result.get("salary_max"):
            salary_max = int(result["salary_max"])

        return JobPosting(
            id=f"adzuna_{result.get('id', '')}",
            title=result.get("title", ""),
            company=result.get("company", {}).get("display_name", "Unknown"),
            location=result.get("location", {}).get("display_name", ""),
            description=result.get("description", ""),
            url=result.get("redirect_url", ""),
            source=JobSource.ADZUNA,
            salary_min=salary_min,
            salary_max=salary_max,
            posted_at=posted_at,
        )
