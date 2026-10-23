---
"@qajitsu/core": minor
"@qajitsu/models": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/adapter-publish-jira": minor
"@qajitsu/adapter-codehost-github": minor
"@qajitsu/adapter-codehost-gitlab": minor
"@qajitsu/adapter-evidence-s3": minor
"@qajitsu/cli": minor
---

Jira workflow: `workflow:` maps the team's statuses per role; `qj publish` moves the ticket by the computed result
(all PASSED to "passed", FAILED back to the change's author, anything else stays in testing with a label);
`qj workflow sync` takes plan approval from `/qj approve v<N>`, `/qj revise` and `/qj reject` comments by a Jira
group with reminders; one active run per ticket and a daily limit; `qj doctor` checks the mapping. Also: cost per
verified ticket with cache and dated prices, stage timing and budgets, plan quality, agent scorecard and `qj feedback`,
prompt caching and input limits, the ticket readiness gate, and `qj reproduce` for certified runs.

Tickets are picked up from the start status (`qj workflow poll`, `qj workflow serve` with a signed webhook).
Certificates get trusted RFC 3161 timestamps (`certificate.timestamp`, `qj audit timestamp`, checked by
`qj verify-report --tsa-ca` and `tools/verify-certificate.mjs`), and certified runs can be kept in write-once storage
on S3 Object Lock (`archive`, new plugin `@qajitsu/adapter-evidence-s3`, `qj audit archive`); locked runs are kept by
cleanup.
