---
"@qajitsu/core": minor
"@qajitsu/models": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/adapter-publish-jira": minor
"@qajitsu/adapter-codehost-github": minor
"@qajitsu/adapter-codehost-gitlab": minor
"@qajitsu/cli": minor
---

Jira workflow: `workflow:` maps the team's statuses per role; `qj publish` moves the ticket by the computed result
(all PASSED to "passed", FAILED back to the change's author, anything else stays in testing with a label);
`qj workflow sync` takes plan approval from `/qj approve v<N>`, `/qj revise` and `/qj reject` comments by a Jira
group with reminders; one active run per ticket and a daily limit; `qj doctor` checks the mapping. Also: cost per
verified ticket with cache and dated prices, stage timing and budgets, plan quality, agent scorecard and `qj feedback`,
prompt caching and input limits, the ticket readiness gate, and `qj reproduce` for certified runs.
