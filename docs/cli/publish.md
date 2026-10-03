# `qajitsu publish` and `qajitsu evidence`

Roadmap stage 4. Publishes the results of an executed run to its ticket.

```text
qajitsu publish <TICKET> [--run <id>] [--auto-publish]
qajitsu evidence <TICKET> [--run <id>] [--failed] [--case <TC-xx>]
```

## `publish`

1. **Recomputes everything from disk**: results, evidence manifest (re-hashed) and the approved plan hash. Files
   changed after `qj run` fail the gates and nothing is published (REQ-VER-07).
2. Builds `report/<TICKET>_<RUN-ID>_evidence.zip` (evidence, manifest, `report.html`, matrix); failure screenshots
   and videos are attached individually (REQ-PUB-02). Files above `publish.max_attachment_mb` are listed in the
   comment but not uploaded.
3. Renders the comment from computed results only (REQ-PUB-01): run id, date, environment and deployed SHA,
   tested repository SHAs, executor, plan version, summary and matrix, every failure with expected vs actual, and
   the reproduction command `qajitsu evidence <TICKET> --run <id> --failed`.
4. Secret scan of the comment and the zip; a hit blocks publishing (REQ-CFG-06/AC3).
5. **Preview**: the comment is shown and needs `y` (REQ-VER-10). In CI pass `--auto-publish` or set
   `publish.auto: true`; the choice is stored in `run.json` (`data.publish.preview`).
6. Publishing: Jira Cloud (REST v3, ADF), Jira Data Center (REST v2, wiki markup, personal access token) or, with
   `jira.type: file`, `report/published/` (demo, offline). The comment id is stored in `run.json`; publishing the
   same run again **updates** the comment and uploads only new attachments; a new run adds a new comment (REQ-PUB-04).

```yaml
# .qa/qa.project.yaml
jira:
  type: cloud # cloud | datacenter | file
  base_url: https://example.atlassian.net
  email: secret://env/JIRA_EMAIL # cloud only
  token: secret://env/JIRA_TOKEN # API token (cloud) or personal access token (datacenter)
  project_key: SHOP
publish:
  max_attachment_mb: 10
  auto: false
```

## `evidence`

Prints every case with its status, failed assertions (expected vs actual), evidence files with SHA-256 and the
masked cURL of every recorded call, so a failure can be reproduced locally.

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Published, updated, or the preview was declined                            |
| 3    | Gates failed, secret found, preview required in CI, no results, Jira error |
