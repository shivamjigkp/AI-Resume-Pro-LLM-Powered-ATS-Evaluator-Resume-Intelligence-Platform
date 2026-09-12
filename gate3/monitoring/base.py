"""Base class for job monitors."""

from abc import ABC, abstractmethod

from ..models import JobPosting


class JobMonitor(ABC):
    """Base class for all job monitoring sources."""

    @abstractmethod
    async def search(
        self,
        keywords: list[str],
        location: str = "",
        remote_only: bool = False,
    ) -> list[JobPosting]:
        """Search for jobs matching the given criteria."""
        ...

    @abstractmethod
    async def check_new(
        self,
        keywords: list[str],
        location: str = "",
        since_minutes: int = 60,
    ) -> list[JobPosting]:
        """Check for new postings within the last N minutes."""
        ...
