---
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/agents": minor
"@qajitsu/verifier": minor
"@qajitsu/report": minor
"@qajitsu/adapter-publish-jira": minor
---

Approval flow with model approvers (REQ-PLAN-10, ADR-0010): `approval.flow` lists person and model steps; a model
approver (another model than the planner) approves, asks for a revision or hands over to a person, and code hands
over plans with flagged values or open questions without asking it. Every decision is kept in `run.json`
(`approvals`) and the journal with the plan, prompt and answer hashes; `qj approve --person` lets a person decide at
once. Plans approved by a model only are marked in the matrix, report, junit and Jira comment, `approval.model_only:
review` turns their PASSED into NEEDS_REVIEW, the `approval-intact` gate and `qj audit verify` check the records, and
`approval.jira: comment` posts the plan and each decision as separate comments. The file publisher keeps named
comments in their own files.
