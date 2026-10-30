# G Money Job Agent

An assistant-managed research dashboard. The assistant finds and evaluates jobs; the user supplies direction rather than entering jobs manually.

Serve this directory over HTTP (for example, `python3 -m http.server 8000`). The report is loaded from `data/research.json`; opening index.html via file:// may block that request.

See docs/PROJECT_STATUS.md for scope, data organization, what is working and the remaining Supabase/agent setup. This release is a published research snapshot, not a continuously running job application agent.
