---
"@qajitsu/core": minor
"@qajitsu/agents": minor
---

Context manager, first phase (ADR-0014, REQ-CTX-11..17): model input as fragments with kind, source, trust, layout,
priority, pin, tokens and hash (`ContextFragmentSchema`, `fragment()`); `createContextManager()` lays them out in a
fixed order, renders untrusted data in blocks bounded by a marker drawn once per run (content cannot close them, in any
letter case), enforces which kinds a role may see (`ROLE_CONTEXT`), and records a snapshot whose hash goes into the
journal. The auditor and triage are migrated; the auditor never receives analysis, diffs or tool transcripts.
