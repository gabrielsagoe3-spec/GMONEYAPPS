# Job agent: ownership and next steps

## The agreement
The assistant researches opportunities, evaluates fit, prepares and (where supported) submits applications, and publishes a breakdown. The user gives preferences and supplies missing personal answers. The dashboard is an overview of the assistant's work; it must not require manual job entry.

## Working today
- Assistant-published research report in `data/research.json`, with employer source URLs, check dates, decisions, fit assessments and next actions.
- Website overview, research filters, application-status explanation, connection status and browser-local preferences.
- Source on GitHub. Published report can be read on phone or laptop; local preferences do not sync.

## Not working yet
- No continuous background research, AI backend, form-filling worker, submission integration, Gmail reader, SMS delivery or MCP server is running.
- Supabase account access is unavailable. No Supabase organization/project has been created; no migration has been applied or tested on a database.
- Candidate resumes, contact details, API keys and provider credentials must not be committed to this repository.

## Organization
- `index.html`: site shell
- `assets/`: presentation and frontend logic
- `data/research.json`: published research snapshot containing public job information only
- `supabase/migrations/`: proposed database structure
- `docs/`: product agreement and implementation status

## Supabase plan
Use a user-owned organization named G Money and a dedicated project such as gmoney-job-agent, subject to available account access and plan selection. The organization has NOT been created.

The prepared migration defines agent preferences, research runs, job findings and application records with per-user access. Signed-in users may read their own records and edit their preferences; trusted server code writes findings and application outcomes. Only a confirmed submission may be recorded as submitted. Database behavior and access policies must be integration-tested before the connection is described as working.

After account access: select the organization/project, apply and test the migration, implement login and server-side publication, move private candidate data to protected storage, and replace the static report with authenticated reads. No service-role key belongs in frontend JavaScript.

## Application phase
Verify a role is current and eligible, resolve missing profile information, prepare truthful answers and documents, test one authorized employer integration, and preserve actual submission confirmations with duplicate prevention. Human assessments remain for the candidate to complete. LinkedIn access must not be assumed from the existence of an MCP connection.

## Morning briefing (future)
Summarize relevant Gmail recruiter replies, interview requests, deadlines and next steps. Time and delivery method (SMS versus ChatGPT notification) remain unresolved; no schedule configured.

## Validation limits
Frontend script syntax and report consistency checked. The database migration is prepared only. No actual job application or outreach was sent during this research pass.
