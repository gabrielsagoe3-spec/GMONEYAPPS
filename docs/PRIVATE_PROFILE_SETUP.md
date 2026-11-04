# Private profile and application drafts

Profile storage, verified-email résumé import and private draft listing are implemented. The related database migrations and email-confirmation requirement are applied. The default free email provider uses sign-in links, with PKCE binding the return to the browser that requested it. Do not reapply the initial schema or the included migrations without checking current state.

Sign in from **Your profile** using the email address on the uploaded résumé. Select **Send sign-in link**, then open the newest email link on the same device and browser. Link sign-in uses a short-lived browser verifier; links requested elsewhere cannot establish a session here. The email must be verified before the staged résumé can be claimed. A different account cannot import it. Existing saved profile fields and résumé edits are preserved. The Applications tab shows only the verified owner's prepared drafts, clearly labeled not submitted. Signing out clears private fields, drafts and tab-local tokens.

Sessions use sessionStorage with refresh before authenticated operations. Résumé and draft contents are not cached in localStorage or committed to GitHub. Old device preferences are retained locally and copied only on explicit request; copying does not save them automatically.

The private import binds the newest matching staged document. If multiple résumé versions are uploaded later, review ownership and existing draft associations before replacing or deleting anything. Deleting a linked auth account cascades to its staged document and associated drafts.

## Email delivery and redirects

The free Supabase default provider does not permit custom numeric-code email templates. Both built-in confirmation and magic-link templates remain enabled. A separate SMTP provider would be needed to opt into numeric-code mode. Do not attempt to patch the unsupported bare template names; the official content fields end in `_content`.

The site URL and redirect allowlist must include `https://gabrielsagoe3-spec.github.io/GMONEYAPPS/`, never localhost for production. Run `python3 automation/configure_email_auth.py --apply --mode link` to apply supported redirect settings and verify them by GET readback. Running the helper without `--apply` checks only; neither command sends email. Code mode is gated behind configured SMTP.

A request stores one pending email/verifier record in localStorage for at most one hour. The callback authorization code is removed from the URL before backend requests and exchanged using that verifier. The returned email must match the requested one before a session or private data is adopted. Pending state is removed after consumption; raw URL access tokens are never accepted as a login. Session tokens remain tab-local in sessionStorage. No code or email link needs to be shared in chat.

The default sender has recipient and rate restrictions, including a project-wide limit of two emails per hour. An hourly rejection means no new message was sent; refreshing cannot reset it. The UI distinguishes this from the one-minute resend guard and honors readable Retry-After headers when provided. Real email was reported delivered by the user; the earlier link failed because of incorrect redirects and missing callback handling. After this fix, a fresh user-initiated email is needed to confirm end-to-end delivery and login. Older links may be expired, consumed or tied to the old flow. Do not disable verification or increase quotas to bypass provider restrictions.

## Validation

`node tests/email-link-smoke.cjs` exercises the default PKCE email-link flow. `node tests/profile-smoke.cjs` exercises optional code-mode recovery plus authenticated saves, imported résumé, restored sessions, private drafts, safe text/link rendering, failures/retry and sign-out using synthetic responses. `tests/profile-rls.sql`, `tests/application-drafts-rls.sql` and the rolled-back import transaction verify live database ownership restrictions. `python3 tests/live_pkce_check.py` is an explicit administrator-only live protocol check using an isolated synthetic account and issued-code fixture; it sends no email and removes all test state. It verifies the real token exchange, profile save/read, draft isolation and consumed-code rejection. Real end-user email-link login remains to be confirmed; opening a requested link in another browser is intentionally rejected.

No prepared draft has been submitted to an employer. The current drafts require role-specific sponsorship and future-start confirmation, work-authorization facts and location answers.
