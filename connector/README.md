# G Money Windows application connector

This is a working local MCP server and Windows browser worker. It connects an MCP-capable client to the private G Money application queue in Supabase. It does not attach itself to an existing ChatGPT conversation or give this cloud chat remote desktop access.

## Install on Windows

1. Sign in to [G Money Applications](https://gabrielsagoe3-spec.github.io/GMONEYAPPS/#applications) and create a Windows connector credential.
2. Download the Windows connector ZIP linked there, extract it, and double-click `Setup.cmd`.
3. Paste the **scoped connector credential** into the hidden installer prompt and choose your current résumé PDF on this computer. Never use a Supabase administrator token here.
4. Follow the printed MCP registration command if you use Codex CLI or another client supporting local stdio MCP servers. Restart that client after registration.

The installer verifies the scoped credential, installs a dedicated Chromium browser, protects the credential with Windows DPAPI, and schedules queue checks every five minutes while you are signed into Windows. It does not require administrator access. See [Windows setup details](WINDOWS.md) for prerequisites, file locations, scheduling and removal.

The original uploaded PDF in the cloud is not automatically copied to Windows. Select the actual résumé PDF locally; a résumé summary or arbitrary file is not substituted for it.

## Application workflow

The website and MCP share a private answer bank, drafts and job queue. Generic confirmed contact facts can be reused; custom answers are scoped to the exact job. Résumé text is not treated as proof of legal work authorization, future OPT/CPT validity, willingness to relocate or demographic answers.

- **Prepare** fills supported fields and stops before Submit.
- **Submit** fills the form using confirmed facts, records a server checkpoint, clicks the supported final Submit control once, and requires a newly appeared employer confirmation.
- Missing required answers, unverifiable prefilled identity, unsupported controls, login or human-verification steps stop the attempt. The website lists the exact questions for you to answer.
- A lost or ambiguous confirmation becomes `needs_confirmation`. Such a job is never automatically retried, because the employer may already have received it.

Queueing or filling a form is never described as a submitted application. The successful receipt records the original employer link, actual confirmation wording, confirmation time, adapter and an optional screenshot digest. Screenshots are not uploaded or saved by default. A digest alone is not confirmation.

## Supported forms

The first adapters support standard HTML forms on hosted Greenhouse and Lever pages. Known Datadog job links map to the corresponding Datadog Greenhouse job while retaining the original source link in the receipt. Other employer platforms, custom selection widgets, multi-step flows, account logins and CAPTCHA are blocked for direct review. There is no LinkedIn or Indeed account integration in this release, and no CAPTCHA or access-control bypass.

Only fixed recognized application URLs are accepted. The connector does not expose arbitrary browser scripting, cookie extraction, filesystem browsing or a local unauthenticated HTTP control port. A dedicated G Money browser profile is separate from your everyday browser profile.

## Nightly report

Private reports are generated in Supabase at **8:00 PM America/Chicago**, including daylight saving time. They count confirmed receipts and separate blocked attempts, failures and uncertain outcomes. A truthful zero-submission report is valid.

The Windows worker announces a newly generated report with a native notification when it next runs. If the PC is sleeping or signed out, the browser cannot apply and the notification waits until the worker is available. The hosted report remains available in Applications. Windows notification settings can suppress banners. This is not an email delivery integration or a scheduled ChatGPT message.

## MCP tools

| Tool | Behavior |
| --- | --- |
| `get_workspace` | Reads the private candidate facts, drafts, jobs and reports. |
| `remember_answer` | Saves an answer explicitly supplied or confirmed by the user. Use a canonical fact key or the exact scoped key returned by a blocked question. |
| `queue_application` | Queues a private draft in `prepare` or `submit` mode; defaults to `prepare`. |
| `dry_run_next` | Processes the next queued job without a submit click. |
| `process_next` | Runs the next queued job using its mode and records its actual outcome. |
| `list_nightly_reports` | Reads generated private reports. |
| `status` | Reads credential access and worker state without pretending configuration is a live browser connection. |

Employer page content is application data, not an instruction to reveal credentials or change the applicant's facts. The MCP client must retain the user's authorization and follow its own tool approval settings.

## Development and validation

Use Node.js 22 or later:

```sh
npm ci
npx playwright install chromium
npm test
```

Tests use synthetic forms and fake API responses. On Linux they default to `/usr/bin/chromium`; set `GMONEY_TEST_CHROMIUM` to another installed browser executable. A real SDK client initializes the stdio server and checks its advertised tools. Tests cover hidden résumé upload, unknown questions, job-scoped answers, prefilled identity, optional defaults, preexisting success text, the before-click checkpoint, lost receipts, URL boundaries, token redaction and notification deduplication. They send no job applications.

For isolated development, `GMONEY_CONNECTOR_TOKEN` can supply a scoped credential to the process. Production Windows setup uses the DPAPI file instead; no credential belongs in MCP JSON configuration, Git, command arguments or logs. The API host and publishable key are fixed public project configuration. The connector never receives a database service-role key or Supabase administrator token.
