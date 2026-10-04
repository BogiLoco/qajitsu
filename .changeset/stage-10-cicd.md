---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/report": minor
"@qajitsu/adapter-codehost-github": minor
"@qajitsu/adapter-codehost-gitlab": minor
---

Stage 10: CI/CD. `qajitsu ci detect` finds the trigger (labelled PR/MR with the ticket key in branch or title, `/qa
approve` and `/qa revise` comments from people with write access, manual runs, Jira automation dispatches) and
writes GitHub outputs; `qajitsu ci publish-plan` posts the plan to Jira; `qajitsu ci comment` keeps one updatable
PR/MR comment and sets the `qajitsu/<TICKET>` status check (`upsertComment`, `setCommitStatus` on GitHub and
GitLab). `qajitsu approve --approver` records who approved in CI and `--reuse-from <run|latest>` reuses an approved
plan only when the ticket is unchanged. Every report now includes `junit.xml`; `qajitsu export` writes the pipeline
artifacts. `QAJITSU_WORKSPACE` overrides the workspace root. Ready-made integrations: GitHub Action and workflow,
GitLab CI template, Docker image and Jenkinsfile in `ci/`. REQ-EXEC-05/AC1 reworded to match ADR-0004; the demo
model now uses its full 128k context.
