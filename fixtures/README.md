# Fixtures

Recorded, scrubbed responses used by contract tests of adapters (Jira, GitHub, GitLab) and by mock models.

```text
fixtures/
  jira/cloud/        issue, dev-status, attachment responses (REQ-CTX-01, REQ-PUB-03)
  jira/datacenter/
  github/            PRs, files, reviews (REQ-CTX-02)
  gitlab/            MRs, diffs, notes, self-hosted variants
  models/            recorded model outputs for agent tests (no real calls in tests)
```

Rules (see `.claude/rules/security.md`):

- Every fixture is fictional or scrubbed: tokens, cookies, `Authorization`, emails, account ids and internal hosts replaced
  by placeholders such as `<TOKEN>`, `user@example.com`, `https://jira.example.com`.
- One folder per adapter; file names describe the scenario (`issue-with-two-prs.json`).
- A fixture changes only together with the contract test that uses it.
