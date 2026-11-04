# @qajitsu/adapter-secrets-vault

QAJitsu SecretProvider 'vault': HashiCorp Vault KV v2 over HTTP.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add secrets-vault`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: secret provider
- Permissions: network
- Hosts: config
- Secrets: Vault token

## Licence

Apache-2.0
