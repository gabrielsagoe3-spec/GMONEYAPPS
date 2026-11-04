# G Money research automation

The production worker is a Supabase Edge Function scheduled by pg_cron every six hours. It keeps running independently of this chat. It uses scoped publication credentials; the seven-day setup token is not required for scheduled execution. No GitHub Actions secret is needed.

The confirmed search is for business roles, Houston preferred with wider U.S. locations considered, sponsorship needed, and full-time availability from May 1, 2027 onward. Public configuration is in `automation/config.json`. Profile edits do not yet update this configuration automatically; changes confirmed in chat can be deployed with the administration helper.

## What works

The hosted worker has completed live manual and automatic runs. A verified run retrieved 1,110 postings from all six feeds, screened 208 title-relevant records and recorded 30 leads under the display limit. Repeated runs correctly reported existing selected jobs as not new. Counts change with employer feeds; consult the dashboard for current evidence.

The source feeds are SoFi, Affirm, Datadog, HubSpot, Palantir and Wealthfront on Greenhouse/Lever. Matching is transparent rule-based screening, not a full résumé assessment. Unknown sponsorship and start dates remain verification tasks. The worker does not access LinkedIn/Indeed accounts or submit applications.

Start-date screening compares explicit work-start wording with `criteria.available_from`. Compatible date evidence raises a lead's rank; earlier generic or immediate starts lower it. Only a clear mandatory earlier start excludes a role. Ambiguous dates, flexible timing, conflicting cues and future start deadlines remain unverified. Posting, application-deadline, graduation and benefit dates do not establish a work start. A cohort year in a title is only a weak, labeled signal. Date evidence and short employer quotes stay in the existing fit explanations; they do not verify graduation eligibility or work authorization.

An unspecified employer start date does not prevent preparing or pursuing an otherwise suitable role. Applications should disclose actual expected graduation and earliest availability upfront. The system retains sponsorship, qualifications and location checks, and does not mark research leads as submitted applications.

## Runtime and security

- `supabase/functions/gmoney-research/index.ts` fetches public feeds, normalizes descriptions, screens roles and publishes through `public.publish_automated_research`.
- Publication uses a dedicated scoped key. It can write validated public research and public posting evidence; it cannot read candidate profiles. Public reports never contain résumé text, contact details or private drafts.
- Prior reports are archived privately. Conflicting run IDs, stale runs, complete source failure, and empty partial coverage cannot replace current results. Other partial runs clearly identify failed sources.
- The scheduler stores an invocation key in encrypted Supabase Vault and the worker secret store. Queued requests contain a timestamped HMAC signature and a one-use nonce, never a reusable key. Signatures expire after five minutes and consumed nonces cannot be replayed. PostgreSQL extension queue visibility is not trusted as a credential boundary.
- Selected original employer requirements are cached privately to ground application drafts. This cache is public employer information, not candidate data.
- `public.research_automation_status` exposes configuration only. The dashboard distinguishes configured scheduling from the latest actual run evidence.

## Administration

Use the existing isolated checkout at `/workspace/GMONEYAPPS`; no extra worktree is needed. Python 3 standard library is sufficient. An authorized, securely injected Supabase Management API token is needed only for administration:

```sh
python3 automation/native_admin.py status
python3 automation/native_admin.py deploy
python3 automation/native_admin.py sync-config
python3 automation/native_admin.py trigger
python3 automation/native_admin.py disable-schedule
python3 automation/native_admin.py enable-schedule
```

`deploy` uploads worker code; `sync-config` updates confirmed public search criteria; `trigger` queues one manual run. Enable/disable are explicit scheduling operations. None print keys or private documents. Existing schema and credentials must be inspected before migrations or key rotation. Migrations in this release have already been applied to the existing project; do not reapply them blindly.

The original Python worker remains available for local research/testing:

```sh
python3 automation/fetch_previous.py automation/previous-report.json
python3 automation/research_worker.py --once --previous automation/previous-report.json
```

Direct feed requests from the coding environment still need the saved network additions `boards-api.greenhouse.io` and `api.lever.co` applied there. This does not prevent the deployed native worker from running. The local publisher is an advanced tool requiring the scoped worker key; ordinary administration should use the native helper rather than extracting keys.

## Private profile and application preparation

The uploaded résumé is staged in a private table. Sign-in must verify its matching email before the résumé and candidate-specific drafts can be accessed. Drafts contain truthful summaries, cover letters, fit notes and explicit missing answers; they are not submission records. Existing profile edits are preserved during import. No emails, applications or employer messages have been sent by this setup.

Default-provider email-link sign-in uses PKCE and the production site redirect; the user confirmed successful sign-in after the repair. Custom numeric-code templates require a separate SMTP provider, which is not configured. Supabase's built-in mail service has recipient and rate restrictions; reliable delivery to other addresses may require an approved SMTP provider. Do not disable email verification to bypass those restrictions.

## Validation

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/edge-research.test.mjs
node tests/automation-smoke.cjs
node tests/profile-smoke.cjs
node tests/email-link-smoke.cjs
```

Python tests and Edge tests cover failure preservation, source parsing, screening, deduplication, scoped publication, signatures, nonce replay and evidence caching. Browser tests use synthetic API fixtures. SQL tests in `tests/*rls.sql` verify live database ownership, résumé import, draft isolation, publication and invocation protections with all fixtures rolled back. Live hosted research and an actual automatic cron run were verified separately.
