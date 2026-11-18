---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/report": minor
"@qajitsu/adapter-evidence-s3": minor
"@qajitsu/adapter-publish-jira": minor
---

Oversized attachments in object storage (REQ-PUB-02/AC3, first part): the attachment limit is
`publish.max_attachment_mb`, lowered to the Jira instance's own upload limit when it reports one. With
`publish.oversized` (`type: s3`: AWS, MinIO and other S3-compatible stores, plugin `evidence-s3`), a file over the
limit is uploaded after the preview is confirmed and the comment links it under "Stored outside the ticket" with its
size, SHA-256 and a presigned link that expires after `link_hours`. A refused upload stops publishing; `run.json` and
the journal name stored files by key and hash. New plugin type `attachment store`; `Publisher.attachmentLimit()`.
