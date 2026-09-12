"""Job monitoring scheduler for continuous operation.

Runs the scan → process pipeline on a configurable interval.
Designed to detect new postings within 1 hour of being published.
"""

import asyncio
import signal
from datetime import datetime

from rich.console import Console

from .config import settings
from .orchestrator import Orchestrator

console = Console()


class Scheduler:
    """Runs the job monitoring pipeline on a recurring schedule.

    Architecture for sub-1-hour detection:
    - Default poll interval: 15 minutes (4x/hour)
    - Each poll checks for jobs posted in the last 60 minutes
    - This creates overlap to prevent missed postings
    - Multiple sources are polled in parallel for redundancy
    """

    def __init__(self, orchestrator: Orchestrator):
        self.orchestrator = orchestrator
        self._running = False

    async def start(self, min_score: float = 50.0) -> None:
        """Start the continuous monitoring loop."""
        self._running = True

        # Handle graceful shutdown
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._stop)

        console.print(f"[bold green]Resume Agent started[/bold green]")
        console.print(f"  Poll interval: {settings.poll_interval_minutes} minutes")
        console.print(f"  Min score: {min_score}")
        console.print(f"  Max daily applications: {settings.max_applications_per_day}")
        console.print(f"  Press Ctrl+C to stop\n")

        cycle = 0
        while self._running:
            cycle += 1
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            console.print(f"\n[bold]{'='*50}[/bold]")
            console.print(f"[bold blue]Cycle #{cycle} at {now}[/bold blue]")

            try:
                # Scan for new jobs
                new_jobs = await self.orchestrator.scan()

                # Process and customize for good matches
                if new_jobs:
                    apps = await self.orchestrator.process_jobs(min_score=min_score)
                    if apps:
                        console.print(
                            f"\n[green]Created {len(apps)} new applications[/green]"
                        )

                # Show current stats
                self.orchestrator.show_stats()

            except Exception as e:
                console.print(f"[red]Error in cycle #{cycle}: {e}[/red]")

            if self._running:
                console.print(
                    f"\n[dim]Sleeping {settings.poll_interval_minutes} minutes until next cycle...[/dim]"
                )
                await asyncio.sleep(settings.poll_interval_minutes * 60)

        console.print("[yellow]Scheduler stopped.[/yellow]")

    def _stop(self) -> None:
        console.print("\n[yellow]Shutting down...[/yellow]")
        self._running = False
