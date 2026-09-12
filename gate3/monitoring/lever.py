"""Lever ATS job board monitor.

Lever exposes a public API for each company's job postings.
Endpoint: https://api.lever.co/v0/postings/{company}
No authentication required.
"""

from datetime import datetime, timedelta

import httpx

from ..models import JobPosting, JobSource
from .base import JobMonitor


class LeverMonitor(JobMonitor):
    """Monitor jobs from companies using Lever ATS.

    Many startups and mid-size tech companies use Lever.
    Each company has a public API endpoint.

    Usage:
        monitor = LeverMonitor(companies=["netflix", "twitch"])
    """

    BASE_URL = "https://api.lever.co/v0/postings"

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
        url = f"{self.BASE_URL}/{company}"
        resp = await client.get(url)
        resp.raise_for_status()
        postings = resp.json()

        jobs = []
        for posting in postings:
            posted_at = None
            if posting.get("createdAt"):
                try:
                    posted_at = datetime.fromtimestamp(posting["createdAt"] / 1000)
                except (ValueError, TypeError, OSError):
                    pass

            location_name = ""
            categories = posting.get("categories", {})
            if categories.get("location"):
                location_name = categories["location"]

            description_parts = []
            if posting.get("descriptionPlain"):
                description_parts.append(posting["descriptionPlain"])
            for lst in posting.get("lists", []):
                if lst.get("text"):
                    description_parts.append(lst["text"])
                if lst.get("content"):
                    description_parts.append(lst["content"])

            jobs.append(
                JobPosting(
                    id=f"lever_{company}_{posting.get('id', '')}",
                    title=posting.get("text", ""),
                    company=company.replace("-", " ").title(),
                    location=location_name,
                    description="\n".join(description_parts),
                    url=posting.get("hostedUrl", ""),
                    source=JobSource.LEVER,
                    posted_at=posted_at,
                    remote="remote" in location_name.lower() if location_name else None,
                    tags=list(categories.values()) if categories else [],
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
