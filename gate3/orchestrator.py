"""Main orchestrator - ties together monitoring, customization, application, and outreach.

This is the brain of the system. It runs the full pipeline:
1. Monitor job boards for new postings matching criteria
2. Score and filter matches
3. Customize resume + generate cover letter for top matches
4. Fill and submit applications (with human review option)
5. Queue recruiter outreach
6. Schedule follow-ups
"""

import asyncio
import json
import uuid
from datetime import datetime
from pathlib import Path

from rich.console import Console
from rich.table import Table

from .config import settings
from .database import Database
from .models import (
    Application,
    ApplicationStatus,
    JobPosting,
    ResumeData,
)
from .monitoring import AdzunaMonitor, GreenhouseMonitor, LeverMonitor
from .customizer import ResumeTailor, CoverLetterGenerator, ResumeRenderer
from .outreach import OutreachMessageGenerator

console = Console()


class Orchestrator:
    """Main pipeline orchestrator."""

    def __init__(
        self,
        resume_path: str | Path,
        search_config: dict | None = None,
    ):
        self.resume = self._load_resume(resume_path)
        self.config = search_config or {}
        self.db = Database()
        self.tailor = ResumeTailor()
        self.cover_gen = CoverLetterGenerator()
        self.renderer = ResumeRenderer()
        self.outreach_gen = OutreachMessageGenerator()

        # Initialize monitors based on config
        self.monitors = self._init_monitors()

    def _load_resume(self, path: str | Path) -> ResumeData:
        path = Path(path)
        with open(path) as f:
            data = json.load(f)
        return ResumeData.model_validate(data)

    def _init_monitors(self) -> list:
        monitors = []

        if settings.adzuna_app_id and settings.adzuna_app_key:
            monitors.append(AdzunaMonitor(country=self.config.get("country", "us")))

        greenhouse_companies = self.config.get("greenhouse_companies", [])
        if greenhouse_companies:
            monitors.append(GreenhouseMonitor(companies=greenhouse_companies))

        lever_companies = self.config.get("lever_companies", [])
        if lever_companies:
            monitors.append(LeverMonitor(companies=lever_companies))

        return monitors

    async def scan(self, check_all: bool = False) -> list[JobPosting]:
        """Scan all sources for new job postings."""
        keywords = self.config.get("keywords", [])
        location = self.config.get("location", "")
        remote_only = self.config.get("remote_only", False)

        console.print(f"\n[bold blue]Scanning {len(self.monitors)} sources...[/bold blue]")

        all_jobs: list[JobPosting] = []
        for monitor in self.monitors:
            try:
                if check_all:
                    jobs = await monitor.search(
                        keywords=keywords,
                        location=location,
                        remote_only=remote_only,
                    )
                else:
                    jobs = await monitor.check_new(
                        keywords=keywords,
                        location=location,
                        since_minutes=settings.poll_interval_minutes * 4,  # overlap window
                    )
                new_count = 0
                for job in jobs:
                    if self.db.save_job(job):
                        new_count += 1
                        all_jobs.append(job)

                console.print(
                    f"  {monitor.__class__.__name__}: {len(jobs)} found, {new_count} new"
                )
            except Exception as e:
                console.print(f"  [red]{monitor.__class__.__name__}: Error - {e}[/red]")

        console.print(f"\n[green]Total new jobs: {len(all_jobs)}[/green]")
        return all_jobs

    async def process_jobs(
        self,
        min_score: float = 50.0,
        auto_apply: bool = False,
    ) -> list[Application]:
        """Process unprocessed jobs: score, customize, and optionally apply."""
        unprocessed = self.db.get_unprocessed_jobs()
        if not unprocessed:
            console.print("[yellow]No unprocessed jobs found.[/yellow]")
            return []

        console.print(f"\n[bold]Processing {len(unprocessed)} jobs...[/bold]")

        # Check daily application limit
        todays_count = self.db.get_todays_application_count()
        remaining_today = settings.max_applications_per_day - todays_count

        applications = []

        for job in unprocessed:
            # Score the match
            score = await self.tailor.score_match(self.resume, job)
            console.print(f"  {job.title} @ {job.company}: score={score:.0f}")

            self.db.mark_job_processed(job.id)

            if score < min_score:
                console.print(f"    [dim]Skipped (below {min_score} threshold)[/dim]")
                continue

            if len(applications) >= remaining_today:
                console.print(f"    [yellow]Daily limit reached ({settings.max_applications_per_day})[/yellow]")
                break

            # Customize resume
            console.print(f"    [cyan]Customizing resume...[/cyan]")
            customized_resume, analysis = await self.tailor.tailor(self.resume, job)

            # Generate cover letter
            console.print(f"    [cyan]Generating cover letter...[/cyan]")
            cover_letter = await self.cover_gen.generate(customized_resume, job)

            # Render outputs
            app_id = f"{job.company.lower().replace(' ', '-')}_{uuid.uuid4().hex[:8]}"
            output_dir = settings.output_dir / app_id

            pdf_path = self.renderer.render_pdf(customized_resume, output_dir / "resume.pdf")
            docx_path = self.renderer.render_docx(customized_resume, output_dir / "resume.docx")

            # Save cover letter
            cover_path = output_dir / "cover_letter.txt"
            cover_path.write_text(cover_letter, encoding="utf-8")

            # Save customized resume JSON
            (output_dir / "resume.json").write_text(
                customized_resume.model_dump_json(indent=2), encoding="utf-8"
            )

            # Save analysis
            (output_dir / "analysis.json").write_text(
                json.dumps(analysis, indent=2), encoding="utf-8"
            )

            # Create application record
            app = Application(
                id=app_id,
                job=job,
                status=ApplicationStatus.RESUME_CUSTOMIZED,
                resume_path=str(pdf_path or docx_path),
                cover_letter_path=str(cover_path),
                match_score=score,
                customization_summary=", ".join(analysis.get("changes_made", [])),
            )

            self.db.save_application(app)
            applications.append(app)

            console.print(
                f"    [green]✓ Resume customized. Match: {analysis.get('recommendation', 'N/A')}[/green]"
            )

        return applications

    def show_stats(self) -> None:
        """Display application statistics."""
        stats = self.db.get_stats()

        table = Table(title="Application Statistics")
        table.add_column("Metric", style="cyan")
        table.add_column("Count", style="green", justify="right")

        for key, value in stats.items():
            table.add_row(key.replace("_", " ").title(), str(value))

        console.print(table)

    def show_applications(self, status: ApplicationStatus | None = None) -> None:
        """Display applications in a table."""
        apps = self.db.get_applications(status)

        table = Table(title="Applications")
        table.add_column("ID", style="dim")
        table.add_column("Company")
        table.add_column("Role")
        table.add_column("Score", justify="right")
        table.add_column("Status", style="cyan")

        for app in apps:
            table.add_row(
                app.id[:20],
                app.job.company,
                app.job.title,
                f"{app.match_score:.0f}",
                app.status.value,
            )

        console.print(table)
