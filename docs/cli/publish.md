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
   and videos are attached individually (REQ-PUB-02). The limit is `publish.max_attachment_mb`, lowered to the
   instance's own upload limit when Jira reports one (`/attachment/meta`). Files above it are listed in the comment
   and stay in the run folder, or, with `publish.oversized`, go to object storage (see below).
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

### Oversized attachments in object storage (REQ-PUB-02/AC3)

With `publish.oversized`, a file over the limit (a long video, a large evidence zip) is uploaded to S3 (AWS, MinIO,
SeaweedFS or another S3-compatible store) and the comment links it under "Stored outside the ticket (links
expire)" with its size, SHA-256 and the time the link stops working:

```yaml
publish:
  max_attachment_mb: 10
  oversized:
    type: s3
    endpoint: https://s3.eu-central-1.amazonaws.com
    region: eu-central-1
    bucket: qa-attachments
    prefix: qajitsu/attachments/ # objects go to <prefix><TICKET>/<run id>/<file>
    path_style: false # true for MinIO and most self-hosted stores
    access_key_id: secret://env/QA_FILES_KEY_ID
    secret_access_key: secret://env/QA_FILES_SECRET
    link_hours: 72 # 1 to 168 (7 days, the most a presigned link lasts)
```

- Files are uploaded only after the preview is confirmed; a declined preview sends nothing anywhere.
- The link is presigned for reading that one object. It carries the access key id (that is how S3 links work), never
  the secret; everywhere else (logs, journal, `run.json`, model context) the key id stays masked. Give the store a
  key of its own that can only write and read this bucket prefix; temporary credentials are refused, their session
  token would be in every link. The endpoint must be https (plain http only on localhost, for a lab MinIO).
- Each object's key holds the first 16 hex characters of its SHA-256 (`<prefix><TICKET>/<run id>/<hash>/<file>`), so
  a later upload never changes what an older link reads.
- Nothing goes to the store when the Jira instance takes no attachments at all (switched off on purpose), and a file
  over 2 GB stays in the run folder.
- A store that refuses the upload stops publishing with the storage's error code; no comment links a file that is not
  there. Files uploaded before such a stop stay in the store under the run's prefix. `run.json` and the journal (`attachment.stored`) name each stored file by key and SHA-256; the signed link is
  only in the comment.
- Publishing the run again uploads the file again and the updated comment gets fresh links.
- `qj doctor` names the `evidence-s3` plugin when a project sets `publish.oversized`.

## `evidence`

Prints every case with its status, failed assertions (expected vs actual), evidence files with SHA-256 and the
masked cURL of every recorded call, so a failure can be reproduced locally.

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Published, updated, or the preview was declined                            |
| 3    | Gates failed, secret found, preview required in CI, no results, Jira error |
