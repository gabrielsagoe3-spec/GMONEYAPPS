# G Money Job Agent

G Money researches public employer postings and records source-linked findings. A Supabase worker runs every six hours; the dashboard shows actual run evidence and screening explanations. Research leads remain unverified until sponsorship, qualifications and start dates are checked.

The static website is served by GitHub Pages from main/root. It reads public reports and schedule configuration using a browser-safe Supabase publishable key. Private profiles, uploaded résumé import and application drafts require verified-email sign-in. No administrator credentials or candidate data belong in frontend files or GitHub.

Serve locally with `python3 -m http.server 8000 --bind 127.0.0.1`. There is no frontend build or dependency-install step. See [automation operations](docs/AUTOMATION.md), [project status](docs/PROJECT_STATUS.md) and [private profiles](docs/PRIVATE_PROFILE_SETUP.md) for commands, validation and limitations. Employer application submission is not connected yet.
