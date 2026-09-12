"""CLI interface for the resume agent."""

import asyncio
import json
from pathlib import Path

import typer
from rich.console import Console

from .config import settings
from .orchestrator import Orchestrator

app = typer.Typer(
    name="resume-agent",
    help="AI-powered automated job application agent",
    no_args_is_help=True,
)
console = Console()


def _load_search_config(config_path: str | None) -> dict:
    if config_path:
        with open(config_path) as f:
            return json.load(f)
    default_path = settings.data_dir / "search_config.json"
    if default_path.exists():
        with open(default_path) as f:
            return json.load(f)
    return {}


@app.command()
def scan(
    resume: str = typer.Option("data/resume.json", help="Path to base resume JSON"),
    config: str = typer.Option(None, help="Path to search config JSON"),
    all_jobs: bool = typer.Option(False, "--all", "-a", help="Scan all active open jobs, not just the last hour"),
):
    """Scan job boards for new postings matching your criteria."""
    settings.ensure_dirs()
    search_config = _load_search_config(config)
    orch = Orchestrator(resume_path=resume, search_config=search_config)
    jobs = asyncio.run(orch.scan(check_all=all_jobs))
    console.print(f"\n[bold green]Found {len(jobs)} new jobs.[/bold green]")


@app.command()
def process(
    resume: str = typer.Option("data/resume.json", help="Path to base resume JSON"),
    config: str = typer.Option(None, help="Path to search config JSON"),
    min_score: float = typer.Option(50.0, help="Minimum match score (0-100)"),
):
    """Process discovered jobs: score, customize resumes, generate cover letters."""
    settings.ensure_dirs()
    search_config = _load_search_config(config)
    orch = Orchestrator(resume_path=resume, search_config=search_config)
    apps = asyncio.run(orch.process_jobs(min_score=min_score))
    console.print(f"\n[bold green]Processed {len(apps)} applications.[/bold green]")


@app.command()
def run(
    resume: str = typer.Option("data/resume.json", help="Path to base resume JSON"),
    config: str = typer.Option(None, help="Path to search config JSON"),
    min_score: float = typer.Option(50.0, help="Minimum match score (0-100)"),
    interval: int = typer.Option(None, help="Poll interval in minutes (overrides config)"),
):
    """Run the full pipeline: scan → score → customize → apply (continuous mode)."""
    settings.ensure_dirs()
    search_config = _load_search_config(config)
    if interval:
        settings.poll_interval_minutes = interval

    orch = Orchestrator(resume_path=resume, search_config=search_config)

    async def _loop():
        while True:
            console.print(f"\n[bold]{'='*60}[/bold]")
            console.print(f"[bold blue]Cycle at {__import__('datetime').datetime.now().strftime('%H:%M:%S')}[/bold blue]")

            await orch.scan()
            await orch.process_jobs(min_score=min_score)

            console.print(
                f"\n[dim]Next scan in {settings.poll_interval_minutes} minutes...[/dim]"
            )
            await asyncio.sleep(settings.poll_interval_minutes * 60)

    try:
        asyncio.run(_loop())
    except KeyboardInterrupt:
        console.print("\n[yellow]Stopped.[/yellow]")


@app.command()
def stats(
    resume: str = typer.Option("data/resume.json", help="Path to base resume JSON"),
):
    """Show application statistics."""
    settings.ensure_dirs()
    orch = Orchestrator(resume_path=resume)
    orch.show_stats()
    orch.show_applications()


@app.command()
def init(
    output: str = typer.Option("data/resume.json", help="Output path for resume template"),
):
    """Generate a template resume.json and search_config.json to get started."""
    settings.ensure_dirs()
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not output_path.exists():
        from .models import ResumeData, ContactInfo, Experience, ResumeBullet, Education, Skills

        template = ResumeData(
            contact=ContactInfo(
                name="Your Name",
                email="you@example.com",
                phone="555-123-4567",
                linkedin="linkedin.com/in/yourprofile",
                github="github.com/yourusername",
                location="City, State",
            ),
            summary="Experienced software engineer with X years of expertise in...",
            experience=[
                Experience(
                    company="Company Name",
                    title="Senior Software Engineer",
                    start_date="2022-01",
                    end_date="Present",
                    location="Remote",
                    bullets=[
                        ResumeBullet(
                            text="Led development of X, resulting in Y% improvement in Z",
                            tags=["leadership", "python", "architecture"],
                        ),
                        ResumeBullet(
                            text="Built and deployed scalable microservices handling N requests/day",
                            tags=["backend", "microservices", "aws"],
                        ),
                    ],
                )
            ],
            education=[
                Education(
                    institution="University Name",
                    degree="Bachelor of Science",
                    field_of_study="Computer Science",
                    end_date="2020",
                )
            ],
            skills=Skills(
                languages=["Python", "TypeScript", "Go"],
                frameworks=["FastAPI", "React", "Django"],
                tools=["Docker", "Kubernetes", "Terraform"],
                platforms=["AWS", "GCP"],
                certifications=["AWS Solutions Architect"],
            ),
        )

        output_path.write_text(template.model_dump_json(indent=2))
        console.print(f"[green][OK] Resume template created at {output_path}[/green]")
    else:
        console.print(f"[yellow]Resume already exists at {output_path}[/yellow]")

    # Search config
    config_path = settings.data_dir / "search_config.json"
    if not config_path.exists():
        config = {
            "keywords": ["software engineer", "backend engineer", "python developer"],
            "location": "",
            "remote_only": False,
            "country": "us",
            "greenhouse_companies": [
                "stripe",
                "figma",
                "notion",
                "airbnb",
                "coinbase",
                "datadog",
                "ramp",
            ],
            "lever_companies": [
                "netflix",
                "twitch",
            ],
            "min_score": 50,
        }
        config_path.write_text(json.dumps(config, indent=2))
        console.print(f"[green][OK] Search config created at {config_path}[/green]")
    else:
        console.print(f"[yellow]Search config already exists at {config_path}[/yellow]")

    console.print("\n[bold]Next steps:[/bold]")
    console.print("1. Edit data/resume.json with your real resume data")
    console.print("2. Edit data/search_config.json with your target companies and keywords")
    console.print("3. Copy .env.example to .env and add your API keys")
    console.print("4. Run: resume-agent scan")


@app.command()
def web(
    port: int = typer.Option(8000, help="Port to run web dashboard on"),
    host: str = typer.Option("127.0.0.1", help="Host address"),
):
    """Launch the Web UI Dashboard in your browser."""
    import uvicorn
    console.print(f"\n[bold green]🚀 Starting Resume Agent Dashboard at http://{host}:{port}[/bold green]")
    uvicorn.run("dashboard:app", host=host, port=port, reload=True)


if __name__ == "__main__":
    app()

