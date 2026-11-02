# G Money Job Agent status

The assistant researches opportunities and records findings; the user supplies preferences and missing personal answers. Manual job entry is not required.

## Implemented

- Static dashboard with overview, research, Automation, applications, private-profile and connection tabs.
- Public published research read from Supabase. The existing report contains seven previously researched entries; it is not an automated run.
- Research worker for six configured employer feeds, transparent rule-based screening and sponsorship evidence, source failures, retrieval timestamps and deduplication.
- Restricted report publication endpoint, private report archive and scoped credential provisioning script.
- Prepared GitHub Actions workflow for manual research and an opt-in six-hour schedule.
- Email-code sign-in and private profile form for résumé text, titles, locations, minimum salary and sponsorship needs.

## Verified on the existing Supabase project

Private-profile fields and research-publication function are installed. Live transaction tests passed for owner reads/writes, cross-account isolation, anonymous denial, ownership protection, worker authorization, idempotency, stale-run rejection, validation and archival. All synthetic test changes were rolled back. Code email templates are configured; delivery has not been tested. No custom SMTP is configured.

## Not activated or unverified

- Employer feeds are blocked by environment proxy policy until the saved network additions are applied. No real automated research run has yet completed or been published.
- The new frontend and workflow are local changes awaiting release; GitHub Pages currently serves main/root.
- GitHub Actions secret management is denied to the current integration. A repository administrator must add the separately provisioned worker credential. No scheduled worker is enabled.
- Browser profile and automation tests use mocked API responses. Live email delivery and cross-device sign-in remain unverified.
- Matching uses public criteria in automation/config.json, not private résumé analysis. No application submission, continuous AI research, Gmail reader, SMS delivery, storage bucket, or LinkedIn/Indeed account integration is running.

See [AUTOMATION.md](AUTOMATION.md) for commands, activation and exact limitations. See [PRIVATE_PROFILE_SETUP.md](PRIVATE_PROFILE_SETUP.md) for account setup. Candidate contact information, secret keys and private résumés must stay out of source control and public reports.
