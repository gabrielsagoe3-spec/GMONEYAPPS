# G Money Job Agent

## Product goal
The agent does the work; the dashboard records it. The user speaks or types job-search instructions from a phone or laptop. Do not require the user to add jobs manually.

## Current implementation
A single static index.html. Preferences and job records use browser localStorage. No server, Supabase project, job-search agent, application submission, Gmail integration, SMS service, or MCP server is connected. GitHub stores source only. Do not present planned functionality as working.

## Required behavior
- User sets role types, location, salary and sponsorship requirements through preferences or conversation.
- Agent discovers opportunities, evaluates resume fit, records evidence for sponsorship, and adds jobs to the tracker.
- Agent uses a verified candidate profile and resume to fill supported application forms.
- Initially show prepared applications for review. Eventually support explicitly configured automatic submission on supported sites, with confirmed results, duplicate prevention, audit history and escalation for unknown answers.
- Never invent qualifications, employment facts or work-authorization answers.
- Plan a morning Gmail briefing focused on recruiter replies, interview requests, deadlines and next steps rather than application counts. Delivery time and SMS versus ChatGPT notification are unresolved. No schedule is currently configured.
- The user requests Supabase for persistence and has supplied this GitHub repository for source.
- Explore MCP tools for interacting with the application. MCP does not itself grant LinkedIn messaging or application permissions. LinkedIn automation must use authorized capabilities; the currently available people-search connector cannot send messages or apply.

## Next implementation steps
1. Connect a user-selected Supabase project with authentication, private resume storage and per-user access policies. Do not commit secrets or resumes.
2. Implement a real job-source adapter and record sources, matching reasons and sponsorship evidence.
3. Add an authenticated agent backend and a task queue; report pending, failed and confirmed outcomes truthfully.
4. Implement and verify one permitted application integration before expanding coverage.
5. Add Gmail connection and briefing delivery after the user selects delivery details.

## UI direction
Preserve the green visual identity. Put agent instructions, activity, application progress and items needing user input first. Explain development status in plain language.

## Validation
The first dashboard correction removes manual job entry and passes a JavaScript syntax check. Browser interaction testing and live integration testing remain to be performed.
