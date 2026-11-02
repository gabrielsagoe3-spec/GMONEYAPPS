# G Money Job Agent

Assistant-managed job research. The user gives direction; the assistant researches and records findings.

The website reads published research from Supabase with a browser-safe publishable key. Private tables are created with RLS. Email-code sign-in and private profile sync are implemented in the frontend. The profile migration and code-email templates are applied. Live email delivery and frontend release remain unverified; see docs/PRIVATE_PROFILE_SETUP.md.

Serve the site over HTTP. On GitHub the site files are at repository root. See docs/PROJECT_STATUS.md for setup and verification status. No continuous job-search or application agent is running.

Research automation commands, activation requirements and tested limitations are documented in [docs/AUTOMATION.md](docs/AUTOMATION.md).
