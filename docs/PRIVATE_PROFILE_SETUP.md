# Private profile and application drafts

Profile storage, verified-email résumé import and private draft listing are implemented. The related database migrations, email-code templates and email-confirmation requirement are applied. Do not reapply the initial schema or the included migrations without checking current state.

Sign in from **Your profile** using the email address on the uploaded résumé. The email must be verified before the staged résumé can be claimed. A different account cannot import it. Existing saved profile fields and résumé edits are preserved. The Applications tab shows only the verified owner's prepared drafts, clearly labeled not submitted. Signing out clears private fields, drafts and tab-local tokens.

Sessions use sessionStorage with refresh before authenticated operations. Résumé and draft contents are not cached in localStorage or committed to GitHub. Old device preferences are retained locally and copied only on explicit request; copying does not save them automatically.

The private import binds the newest matching staged document. If multiple résumé versions are uploaded later, review ownership and existing draft associations before replacing or deleting anything. Deleting a linked auth account cascades to its staged document and associated drafts.

## Email delivery

Code templates are configured for login and new-account confirmation; no test email has been sent. Custom SMTP is not configured. Supabase's built-in mail service restricts recipients and rate. If the first actual sign-in email is rejected or not delivered, configure an approved SMTP provider through secure settings; do not put provider passwords in source or disable verification.

## Validation

`node tests/profile-smoke.cjs` exercises sign-in, authenticated saves, imported résumé, restored sessions, private drafts, safe text/link rendering, failures/retry and sign-out using synthetic responses. `tests/profile-rls.sql`, `tests/application-drafts-rls.sql` and the rolled-back import transaction verify live database ownership restrictions. Real email delivery and cross-device authentication remain unverified.

No prepared draft has been submitted to an employer. The current drafts require role-specific sponsorship and future-start confirmation, work-authorization facts and location answers.
