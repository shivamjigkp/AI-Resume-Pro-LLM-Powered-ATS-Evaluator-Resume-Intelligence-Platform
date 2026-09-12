"""Greenhouse ATS job board monitor.

Greenhouse exposes a public JSON API for each company's job board.
No authentication required for public job listings.
Endpoint: https://boards-api.greenhouse.io/v1/boards/{company}/jobs
"""

from datetime import datetime, timedelta

import httpx

from ..models import JobPosting, JobSource
from .base import JobMonitor


class GreenhouseMonitor(JobMonitor):
    """Monitor jobs from specific companies using Greenhouse ATS.

    Many tech companies use Greenhouse. Each company has a public job board
    API at boards-api.greenhouse.io that requires no API key.

    Usage:
        monitor = GreenhouseMonitor(companies=["stripe", "figma", "notion"])
    """

    BASE_URL = "https://boards-api.greenhouse.io/v1/boards"

    def __init__(self, companies: list[str] | None = None):
        self.companies = companies or []

    async def search(
        self,
        keywords: list[str],
        location: str = "",
        remote_only: bool = False,
    ) -> list[JobPosting]:
        all_jobs: list[JobPosting] = []

        async with httpx.AsyncClient(timeout=30) as client:
            for company in self.companies:
                try:
                    jobs = await self._fetch_company_jobs(client, company)
                    filtered = self._filter_jobs(jobs, keywords, location, remote_only)
                    all_jobs.extend(filtered)
                except httpx.HTTPError:
                    continue

        return all_jobs

    async def check_new(
        self,
        keywords: list[str],
        location: str = "",
        since_minutes: int = 60,
    ) -> list[JobPosting]:
        cutoff = datetime.utcnow() - timedelta(minutes=since_minutes)
        all_jobs = await self.search(keywords, location)
        return [
            j for j in all_jobs
            if j.posted_at and j.posted_at.replace(tzinfo=None) >= cutoff
        ]

    async def _fetch_company_jobs(
        self, client: httpx.AsyncClient, company: str
    ) -> list[JobPosting]:
        url = f"{self.BASE_URL}/{company}/jobs"
        resp = await client.get(url, params={"content": "true"})
        resp.raise_for_status()
        data = resp.json()

        jobs = []
        for job_data in data.get("jobs", []):
            posted_at = None
            if job_data.get("updated_at"):
                try:
                    posted_at = datetime.fromisoformat(
                        job_data["updated_at"].replace("Z", "+00:00")
                    )
                except (ValueError, TypeError):
                    pass

            location_name = ""
            if job_data.get("location", {}).get("name"):
                location_name = job_data["location"]["name"]

            # Strip HTML from content
            description = job_data.get("content", "")

            jobs.append(
                JobPosting(
                    id=f"greenhouse_{company}_{job_data.get('id', '')}",
                    title=job_data.get("title", ""),
                    company=company.replace("-", " ").title(),
                    location=location_name,
                    description=description,
                    url=job_data.get("absolute_url", ""),
                    source=JobSource.GREENHOUSE,
                    posted_at=posted_at,
                    remote="remote" in location_name.lower() if location_name else None,
                )
            )

        return jobs

    def _filter_jobs(
        self,
        jobs: list[JobPosting],
        keywords: list[str],
        location: str,
        remote_only: bool,
    ) -> list[JobPosting]:
        filtered = []
        keywords_lower = [k.lower() for k in keywords]

        for job in jobs:
            searchable = f"{job.title} {job.description}".lower()
            if not any(kw in searchable for kw in keywords_lower):
                continue
            if location and location.lower() not in job.location.lower():
                continue
            if remote_only and not job.remote:
                continue
            filtered.append(job)

        return filtered
