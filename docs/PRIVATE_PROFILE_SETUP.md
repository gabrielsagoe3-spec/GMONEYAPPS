# Private profiles: activation and validation

The frontend supports email-code sign-in and owner-scoped profiles. The candidate-profile database migration and code email templates are now applied. Live database RLS tests passed with synthetic data rolled back. Frontend release and live email delivery remain unverified.

## Activate in the existing Supabase project

1. The candidate-profile migration is applied. Do not reapply it or the initial migration.
2. Enable the email authentication provider and permit new email signups if needed. In the Magic Link email template include the code variable `{{ .Token }}`. This frontend accepts the code directly and does not process magic-link redirects. Configure production email delivery in Supabase as needed.
3. Project API access is now allowed and tested. Administration is available through the securely configured Management API token, not a browser key.
4. Release the updated static files together, including `assets/profile.js`. GitHub Pages serves main/root; these local frontend changes have not yet been released.

No service-role key belongs in the frontend. The existing publishable key is used with the signed-in user's bearer token. Existing owner-only RLS policies on `agent_preferences` apply to new profile columns. No private data is written to the public report table.

## Check the real service

Request a code using your own email, sign in, save a profile, and reload. Sign in on another device and verify the saved values. Verify a second account cannot read or modify the first account's row; unauthenticated profile access must fail. Check sign-out clears the form. Live email delivery, migration application, and RLS behavior have not been validated by the local mocked test.

Sessions persist in sessionStorage for the browser tab and refresh before profile requests. Private profile values are not cached in localStorage. Old browser preferences are retained and imported only on explicit request; importing does not save them automatically. Signing out clears local tokens and fields and requests server-session revocation. Authenticated writes use the authenticated user ID and existing database policies enforce ownership.

## Local checks

Serve the repository with `python3 -m http.server 8000 --bind 127.0.0.1`.

Run `node --check assets/profile.js`, `node --check assets/app.js`, and `node tests/profile-smoke.cjs`. The browser test uses the environment's Playwright installation and `/usr/bin/chromium`; override `CHROMIUM_PATH` when needed. It uses mocked Supabase responses and covers sign-in, bearer-authenticated save, reload, failure handling, and sign-out. It does not create accounts or change hosted data.

A profile save does not launch job research or applications. Background workers and application integrations remain future work.
