# @qajitsu/adapter-secrets-cli

QAJitsu SecretProviders through official CLIs: 1Password (op), AWS Secrets Manager (aws), GCP Secret Manager (gcloud).

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add secrets-cli`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: secret provider
- Permissions: exec
- Hosts: none
- Secrets: none

## Licence

Apache-2.0
