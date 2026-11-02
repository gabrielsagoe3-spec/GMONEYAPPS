# Research automation

This version automates public employer-feed research. It screens titles, locations, seniority and sponsorship statements; it does not evaluate a private résumé, submit applications, or read LinkedIn/Indeed accounts. Unknown sponsorship and qualifications remain explicit verification tasks. The configurable starting criteria come from the existing public report, including Houston preference and an unconfirmed post-May-2027 full-time start window.

## What runs

`automation/research_worker.py` reads four Greenhouse boards and two Lever boards configured in `automation/config.json`. It creates a report compatible with the dashboard, with run IDs, retrieval times, source results, explanations, exclusions and deduplication. The source listing is evidence of retrieval, not proof of a new posting or confirmed eligibility.

Use the existing isolated checkout at `/workspace/GMONEYAPPS`; no extra worktree is needed. Python 3 standard library is sufficient.

```sh
python3 automation/fetch_previous.py automation/previous-report.json
python3 automation/research_worker.py --once --previous automation/previous-report.json
python3 automation/publish_report.py automation/latest-report.json
```

The first two steps use public data only. The last needs the separate `GMONEY_RESEARCH_KEY` environment variable. Never use the seven-day Supabase administration token as the workflow credential. A failed source is reported. Complete source failure, and partial coverage with no selected findings, stop without replacing the prior output. Other partial runs show responding sources only; the prior published report is archived privately rather than mixed with unverified current results. Repeated identical publication is safe; stale runs and conflicting run IDs are rejected.

## Hosted database

The private-profile migration and restricted publisher migration have been applied to the existing project. The initial migration was not reapplied. Owner-only profile rules and publisher authorization/archival protections were verified with transaction-local synthetic test data, all rolled back. No automated research report has been published by these tests.

`public.publish_automated_research` accepts only the public research contract and requires a dedicated high-entropy key. It cannot read candidate profiles. The database stores only a SHA-256 digest in a private table. The worker key authorizes publication, so keep it secure even though it is narrower than an administrator key.

## Remaining activation

1. Save the environment network additions `boards-api.greenhouse.io` and `api.lever.co`. The initial live requests were denied by proxy CONNECT 403; a real search must succeed before claiming automation works with current employer data.
2. The GitHub integration can read/write source, but Actions-secret management returns `403 Resource not accessible by integration`. A repository administrator must provision the scoped worker key: run `automation/provision_worker.sql` in Supabase SQL editor and copy its result directly into GitHub repository **Settings → Secrets and variables → Actions**, secret name **GMONEY_RESEARCH_KEY**. The SQL file contains no key; running it generates one and stores its digest. Re-running rotates the credential.
3. Review and release the frontend and `.github/workflows/research.yml` to the default branch. They remain local changes until that release; the live GitHub Pages site does not automatically include this workspace.
4. First run **Job research** manually in Actions and inspect real report counts and source outcomes. Then set repository Actions variable **GMONEY_AUTOMATION_ENABLED** to **true** to opt into the six-hour schedule. Scheduling is not currently enabled. GitHub schedules may be delayed and do not survive an inactive/disabled workflow setting automatically.

GitHub Pages serves the existing site from main, root: https://gabrielsagoe3-spec.github.io/GMONEYAPPS/. Report publication goes to Supabase; later research updates need no website redeployment once the new UI is released. No application submission or outbound-message integration is included.

## Validation

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/automation-smoke.cjs
node tests/profile-smoke.cjs
```

Browser tests use mocked service responses and installed Playwright/system Chromium. `tests/profile-rls.sql` and `tests/research-publisher-rls.sql` are live database assertions with rollback. Email-code templates are configured for login and account confirmation; no email has been sent and delivery is unverified. Custom SMTP is not configured.
