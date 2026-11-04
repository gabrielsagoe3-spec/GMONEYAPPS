# Windows application connector and nightly reports

The application connector gives an MCP-capable Windows client tools for the private answer bank, application queue, supported browser forms and receipts. The website remains the private place to review missing answers and outcomes. A local installation is required: publishing the website does not install software on a computer or add tools to this chat.

## Setup

1. Sign in to [G Money Applications](https://gabrielsagoe3-spec.github.io/GMONEYAPPS/#applications) with the résumé's verified email. Create a Windows connector credential in the private connector panel. Keep that credential out of chat and GitHub.
2. Download [G Money Windows Connector](https://gabrielsagoe3-spec.github.io/GMONEYAPPS/downloads/GMoney-Windows-Connector.zip), extract it, and follow its Windows setup instructions. The package includes the local MCP server and worker; Node.js and a browser download are required.
3. The installer asks for the scoped connector credential and a local copy of the résumé PDF. It protects the credential with Windows DPAPI for the current Windows account. It uses a dedicated browser profile rather than the personal Chrome profile.
4. Register the local server in the Windows MCP client using the command or configuration printed by setup. The [connector guide](../connector/README.md) contains the exact paths, tools and troubleshooting steps. Registering it in that client does not attach it to this ChatGPT conversation.

A private hosted ChatGPT connector would require a reachable HTTPS MCP server and supported authentication. This release supplies a local stdio MCP server and a private cloud queue; it does not expose an unauthenticated browser-control port or claim that a hosted chat connector has been installed.

## Answers and applications

The worker reads only its verified owner's profile, approved answers, drafts and application records. The original résumé and confirmed instructions remain private. A scoped connector can be revoked from the website and expires after 30 days; it cannot administer Supabase or read another account.

Global answers are limited to explicit reusable facts such as name, contact details and availability. Custom answers are scoped to the job so that an answer to “Why work here?” cannot be reused for another employer. Unknown authorization details, residency, qualifications, required questions and consent fields remain questions. The worker does not infer citizenship, OPT approval dates, willingness to relocate or sensitive demographic answers from search preferences.

Queueing, preparing, filling and submitting have separate statuses. The worker records a submission checkpoint before its final click, then records a submission only when the supported employer form returns confirmation. A lost connection or crash after that checkpoint produces an uncertain outcome for manual review and is never retried automatically. Employer login challenges, CAPTCHA and unsupported controls stop the attempt. The current adapters target supported Greenhouse and Lever forms; custom employer sites can still require manual work.

## Nightly report

The requested report time is **8:00 PM America/Chicago (Houston)**. A private database schedule checks for due reports every minute and creates one report per account and local date. Houston daylight saving changes are handled by the timezone. Confirmed receipts supply the applications list; blocked and failed attempts remain separate. Zero confirmed submissions is a valid report.

The cloud report can be generated while Windows is off. The Windows notification requires the installed worker and a logged-in running computer; the report remains available in the website. This release does not configure email delivery or a ChatGPT scheduled message. Supabase's sign-in email service is not used for activity reports.

## Operations

The migration is `supabase/migrations/20261104010000_application_connector.sql`. Check live state before applying it. Candidate facts, scoped tokens, leases and receipts must never be committed to the repository or placed in the public research report.

```sh
python3 automation/application_admin.py status
python3 automation/application_admin.py enable-reports
python3 automation/application_admin.py build-reports
python3 automation/application_admin.py disable-reports
```

Enabling the report cron does not opt other accounts into reporting. Per-account preferences control the local time and enabled state. Existing research scheduling remains independent. Database rollback tests exercise owner isolation, scoped credentials and submission transitions; browser fixtures exercise form filling and receipt detection without applying to an employer. Windows-specific installation and notifications require verification on Windows.

Run `python3 automation/package_windows_connector.py` after connector source changes and commit the regenerated `downloads/` ZIP and checksum with the source. The packager includes only the explicit installer/runtime file list, excluding tests, dependencies, credentials, browser profiles and candidate documents. GitHub Pages serves this code-only download directly.
