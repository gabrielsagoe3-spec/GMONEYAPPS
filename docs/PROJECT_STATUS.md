# Job agent: ownership and next steps

## The agreement
The assistant researches opportunities, evaluates fit, prepares and (where supported) submits applications, and publishes a breakdown. The user gives preferences and supplies missing personal answers. The dashboard is an overview of the assistant's work; it must not require manual job entry.

## Working today
- Assistant-published research report served from Supabase `published_research_reports`, with employer source URLs, check dates, decisions, fit assessments and next actions.
- Website overview, research filters, application-status explanation, connection status and browser-local preferences.
- Source on GitHub. Published report can be read on phone or laptop; local preferences do not sync.

## Not working yet
- No continuous background research, AI backend, form-filling worker, submission integration, Gmail reader, SMS delivery or MCP server is running.
- Supabase private-account sign-in and preference sync are not implemented. The Supabase dashboard account does not automatically sign the user into this website.
- Candidate resumes, contact details, secret API keys and provider credentials must not be committed to this repository.

## Organization
- `index.html`: site shell
- `assets/`: presentation and frontend logic
- `data/research.json`: published research snapshot containing public job information only
- `supabase/migrations/`: applied initial schema source
- `docs/`: product agreement and implementation status

## Supabase connection (November 2, 2026)
Project `gmoney-job-agent` (`awscnughpnerhkslhmln`) was created in the user-selected existing organization on the quoted $0/month setup, us-east-2.

The initial schema is applied. It contains agent_preferences, research_runs, job_findings, application_records and published_research_reports. The browser reads the public-information report with a publishable key. No secret key is in the frontend. Only public job research belongs in the published report; private candidate information must use user-owned tables.

The assistant can update the current report through the authorized Supabase connection. The website loads the latest report on opening or Refresh report, without a code deployment. The research date remains October 30; connecting the database is not a new job-research pass.

Test transactions verified owner-only preference visibility, owner updates, rejection of ownership reassignment, denial of anonymous private reads and denial of client-forged application submissions. Test users and rows were rolled back. Security advisors reported no findings. Frontend reading is tested separately via the public REST endpoint.

Next: implement account sign-in and private preference sync, then private resume storage and application workflow. Local preferences do NOT sync yet. No storage bucket or continuous agent exists yet.

## Application phase
Verify a role is current and eligible, resolve missing profile information, prepare truthful answers and documents, test one authorized employer integration, and preserve actual submission confirmations with duplicate prevention. Human assessments remain for the candidate to complete. LinkedIn access must not be assumed from the existence of an MCP connection.

## Morning briefing (future)
Summarize relevant Gmail recruiter replies, interview requests, deadlines and next steps. Time and delivery method (SMS versus ChatGPT notification) remain unresolved; no schedule configured.

## Validation limits
Frontend script syntax and report consistency checked. Initial migration applied; access-policy assertions and security advisors passed. No actual job application or outreach was sent during this research pass.
