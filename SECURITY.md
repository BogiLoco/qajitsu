# Security policy

QAJitsu handles credentials for Jira, code hosts, model providers and test environments, and it drives LLM agents
that read untrusted content (tickets, pull requests, web pages). Security reports are welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"). Include the version, a description, reproduction steps and impact.
You will get an acknowledgement within 7 days.

## Supported versions

Pre-alpha: only the latest `main` is supported.

## In scope

- Secrets leaking into model context, logs, evidence, reports or Jira (INV-8)
- Agents escaping the guard: writing results or evidence, calling hosts outside the allowlist, reaching production (INV-2, INV-10)
- Prompt injection from tickets, PRs or web pages that changes a test status or publishes content
- A real failure reported as PASSED (INV-1); we treat this as a security-grade defect
- Command injection through configuration, ticket keys or repository names

## Out of scope

- Vulnerabilities in the system under test that QAJitsu happens to find
- Issues requiring a malicious `.qa/` configuration committed by the project owner
