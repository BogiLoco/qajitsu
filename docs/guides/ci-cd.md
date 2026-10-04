# QAJitsu in CI/CD (stage 10)

The same commands as on a laptop, split into two pipeline steps with a human approval in between:

```text
labelled PR/MR or /qa comment or manual or Jira
        │
   qj ci detect ──► run? ticket? mode?
        │
   plan step:  qj fetch → qj plan → qj ci publish-plan (Jira) → qj ci comment (PR/MR, status "pending")
        │
   approval:   GitHub protected environment │ GitLab manual job │ /qa approve │ Jenkins input
        │      (/qa revise <text> → plan step again, new version)
   run step:   qj approve --approver <who> → qj run → qj export → qj ci comment (results, status check)
```

New plans are never approved automatically (REQ-PLAN-07/AC4). New commits on the same PR reuse the approved plan
only when the ticket text is unchanged (`qj approve --reuse-from latest`); otherwise a person approves again.

## Ready-made integrations (REQ-CI-01)

| CI                 | Files                                                                                                | Approval                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GitHub Actions     | `ci/github/action.yml` (the action), `ci/github/qajitsu.workflow.yml` (copy to `.github/workflows/`) | environment `qa-approval` with required reviewers, or a `/qa approve` comment from someone with write access |
| GitLab CI          | `ci/gitlab/qajitsu.gitlab-ci.yml` (include, extend `.qa-plan` and `.qa-run`)                         | the manual `qa-run` job; whoever starts it approves                                                          |
| Jenkins and others | `ci/docker/Dockerfile` (image with Node.js 22, git, Chromium, `qajitsu`), `ci/jenkins/Jenkinsfile`   | the `input` step                                                                                             |

All of them call `ci/qajitsu-ci.sh plan|run <TICKET>`, configured through environment variables (see the header
of the script). Build the image with `docker build -f ci/docker/Dockerfile -t qajitsu .`.

## Triggers (REQ-CI-02)

- **Label** (default `qa-agent`, `qj ci detect --label`): the ticket key comes from the branch name or the title.
- **Jira status change**: a Jira automation rule "When status changes to Ready for QA" sends a web request:
  - GitHub: `POST https://api.github.com/repos/<org>/<repo>/dispatches` with
    `{"event_type":"qajitsu","client_payload":{"ticket":"{{issue.key}}","status":"{{issue.status.name}}"}}`;
  - GitLab: `POST https://gitlab.example.com/api/v4/projects/<id>/trigger/pipeline` with `token`, `ref`,
    `variables[QA_TICKET]={{issue.key}}` and `variables[QA_TRIGGER]=jira`.
- **Manual**: GitHub `workflow_dispatch` inputs `ticket`, `env`, `mode`; GitLab "Run pipeline" with `QA_TICKET`,
  `QA_ENV`, `QA_MODE`; Jenkins parameters.

## Outputs (REQ-CI-04)

- Exit codes: 0 all passed, 1 any failed, 2 blocked/flaky/not run/needs review, 3 error.
- `qa-artifacts/`: `report.html`, `junit.xml` (FAILED as failures, other non-passed as skipped), `matrix.md`,
  `matrix.csv`, `gates.json` and `<TICKET>_<RUN>_evidence.zip` (from the manifest, secret-scanned).
- One updatable comment on the PR/MR (plan while waiting, results afterwards) and the status check
  `qajitsu/<TICKET>`.

## Rolling out gradually (REQ-CI-05)

1. **Informational first.** Run on labelled PRs only, do not make `qajitsu/<TICKET>` a required check, and read
   the results next to your own testing for a few weeks. Track false FAILED with `qj metrics`
   (`qajitsu_false_failed_ratio` on benchmark runs) and with reviewers' feedback on FAILED cases.
2. **Required once false FAILED is low.** When FAILED results are reliably real bugs, make the status check
   required on the protected branch.
3. **Limit cost.** Start only on the label, and only for relevant paths (`qj ci detect --paths 'src/**'`). Use
   job timeouts (`timeout-minutes`, `timeout:`), `models.token_budget` per run, and cache the git mirrors
   (`.qa-cache/`) and Playwright browsers between pipelines.

## Secrets and runners

- Secrets come from the CI secret store as environment variables (`secret://env/NAME` in `.qa/`): GitHub
  secrets, GitLab masked and protected variables, Jenkins credentials. For cloud secret managers use OIDC in
  the pipeline (e.g. `aws-actions/configure-aws-credentials`, `google-github-actions/auth`, GitLab ID tokens) to
  read the values into the job environment; QAJitsu then reads them like any other env secret.
- Run folders move between steps through artifacts or caches (`QAJITSU_WORKSPACE` points at them).
- Mobile: Android emulators need KVM on Linux runners (`/dev/kvm`, e.g. GitHub larger runners) or macOS
  runners; iOS needs macOS runners with Xcode or a device farm.
