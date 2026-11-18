# @qajitsu/adapter-evidence-s3

QAJitsu on S3 (AWS, MinIO and other S3-compatible storage): write-once evidence and certificates on Object Lock, and oversized ticket attachments with expiring links.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add evidence-s3`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: evidence archive, attachment store
- Permissions: network
- Hosts: config
- Secrets: access key id, secret access key

## Licence

Apache-2.0
