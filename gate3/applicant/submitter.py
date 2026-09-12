"""Browser automation for submitting job applications.

Uses Playwright to automate form filling across different ATS platforms.
Supports Greenhouse, Lever, and generic application forms.

IMPORTANT: This module requires human oversight. It fills forms and
pauses for review before final submission by default.
"""

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright, Page, Browser

from ..config import settings
from ..models import Application, ResumeData


class ApplicationSubmitter:
    """Automates job application form filling with Playwright.

    Design philosophy: Fill forms accurately, but always allow
    human review before final submission. Speed comes from
    automation of the tedious parts (filling fields), not from
    removing human judgment.
    """

    def __init__(self, headless: bool = False):
        self.headless = headless
        self._browser: Browser | None = None

    async def __aenter__(self):
        pw = await async_playwright().start()
        self._browser = await pw.chromium.launch(headless=self.headless)
        return self

    async def __aexit__(self, *args):
        if self._browser:
            await self._browser.close()

    async def fill_greenhouse(
        self,
        page: Page,
        resume: ResumeData,
        resume_path: Path,
        cover_letter: str = "",
    ) -> None:
        """Fill a Greenhouse application form."""
        # Greenhouse forms have consistent field IDs
        await self._fill_field(page, "#first_name", resume.contact.name.split()[0])
        if len(resume.contact.name.split()) > 1:
            await self._fill_field(
                page, "#last_name", " ".join(resume.contact.name.split()[1:])
            )
        await self._fill_field(page, "#email", resume.contact.email)
        await self._fill_field(page, "#phone", resume.contact.phone)

        # Resume upload
        file_input = page.locator('input[type="file"]').first
        if await file_input.count() > 0:
            await file_input.set_input_files(str(resume_path))

        # LinkedIn
        linkedin_field = page.locator(
            'input[name*="linkedin"], input[id*="linkedin"], input[autocomplete*="url"]'
        ).first
        if await linkedin_field.count() > 0 and resume.contact.linkedin:
            await linkedin_field.fill(resume.contact.linkedin)

        # Cover letter
        if cover_letter:
            cover_field = page.locator(
                'textarea[name*="cover"], textarea[id*="cover"]'
            ).first
            if await cover_field.count() > 0:
                await cover_field.fill(cover_letter)

    async def fill_lever(
        self,
        page: Page,
        resume: ResumeData,
        resume_path: Path,
        cover_letter: str = "",
    ) -> None:
        """Fill a Lever application form."""
        await self._fill_field(
            page, 'input[name="name"]', resume.contact.name
        )
        await self._fill_field(
            page, 'input[name="email"]', resume.contact.email
        )
        await self._fill_field(
            page, 'input[name="phone"]', resume.contact.phone
        )

        # Resume upload
        file_input = page.locator('input[type="file"]').first
        if await file_input.count() > 0:
            await file_input.set_input_files(str(resume_path))

        # LinkedIn and other URLs
        url_fields = page.locator('input[name="urls[LinkedIn]"]')
        if await url_fields.count() > 0 and resume.contact.linkedin:
            await url_fields.fill(resume.contact.linkedin)

        github_fields = page.locator('input[name="urls[GitHub]"]')
        if await github_fields.count() > 0 and resume.contact.github:
            await github_fields.fill(resume.contact.github)

        # Cover letter
        if cover_letter:
            cover_field = page.locator(
                'textarea[name="comments"]'
            ).first
            if await cover_field.count() > 0:
                await cover_field.fill(cover_letter)

    async def apply(
        self,
        application: Application,
        resume: ResumeData,
        resume_path: Path,
        cover_letter: str = "",
        auto_submit: bool = False,
    ) -> bool:
        """Navigate to job URL, fill the application form.

        Args:
            auto_submit: If False (default), pauses before submitting
                         so you can review. Set True for full automation.

        Returns:
            True if the form was filled (and submitted if auto_submit=True)
        """
        if not self._browser:
            raise RuntimeError("Use as async context manager: async with ApplicationSubmitter()")

        context = await self._browser.new_context()
        page = await context.new_page()

        try:
            await page.goto(application.job.url, wait_until="networkidle", timeout=30000)
            await asyncio.sleep(2)

            # Detect ATS and fill accordingly
            current_url = page.url.lower()

            if "greenhouse.io" in current_url or "boards.greenhouse" in current_url:
                await self.fill_greenhouse(page, resume, resume_path, cover_letter)
            elif "lever.co" in current_url or "jobs.lever" in current_url:
                await self.fill_lever(page, resume, resume_path, cover_letter)
            else:
                await self._fill_generic(page, resume, resume_path, cover_letter)

            if auto_submit:
                submit_btn = page.locator(
                    'button[type="submit"], input[type="submit"]'
                ).first
                if await submit_btn.count() > 0:
                    await submit_btn.click()
                    await asyncio.sleep(3)
                    return True
            else:
                # Pause for human review
                print(f"\n{'='*60}")
                print(f"Form filled for: {application.job.title} at {application.job.company}")
                print(f"URL: {application.job.url}")
                print(f"Review the form and submit manually, or press Enter to continue.")
                print(f"{'='*60}\n")
                await asyncio.sleep(0)  # yield control
                input("Press Enter after reviewing/submitting...")
                return True

        except Exception as e:
            print(f"Error filling application for {application.job.company}: {e}")
            return False
        finally:
            await context.close()

    async def _fill_field(self, page: Page, selector: str, value: str) -> None:
        """Safely fill a form field if it exists."""
        try:
            field = page.locator(selector).first
            if await field.count() > 0:
                await field.fill(value)
        except Exception:
            pass

    async def _fill_generic(
        self,
        page: Page,
        resume: ResumeData,
        resume_path: Path,
        cover_letter: str = "",
    ) -> None:
        """Best-effort form filling for unknown ATS platforms."""
        name_parts = resume.contact.name.split()

        # Try common field patterns
        name_selectors = [
            ('input[name*="first" i]', name_parts[0]),
            ('input[name*="last" i]', name_parts[-1] if len(name_parts) > 1 else ""),
            ('input[name*="name" i][name*="full" i]', resume.contact.name),
            ('input[autocomplete="given-name"]', name_parts[0]),
            ('input[autocomplete="family-name"]', name_parts[-1] if len(name_parts) > 1 else ""),
        ]
        for selector, value in name_selectors:
            if value:
                await self._fill_field(page, selector, value)

        # Email
        for selector in ['input[type="email"]', 'input[name*="email" i]']:
            await self._fill_field(page, selector, resume.contact.email)

        # Phone
        for selector in ['input[type="tel"]', 'input[name*="phone" i]']:
            await self._fill_field(page, selector, resume.contact.phone)

        # Resume upload
        file_input = page.locator('input[type="file"]').first
        if await file_input.count() > 0:
            await file_input.set_input_files(str(resume_path))

        # LinkedIn
        for selector in ['input[name*="linkedin" i]', 'input[placeholder*="linkedin" i]']:
            if resume.contact.linkedin:
                await self._fill_field(page, selector, resume.contact.linkedin)
