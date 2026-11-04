# @qajitsu/adapter-messages-webhooksite

QAJitsu MessageCapture on webhook.site (hosted or self-hosted): an e-mail address and a URL per run and case.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add messages-webhooksite`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: message capture
- Permissions: network
- Hosts: webhook.site, config
- Secrets: API key

## Licence

Apache-2.0
