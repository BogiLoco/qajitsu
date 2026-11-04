# @qajitsu/adapter-runner-api

QAJitsu API Runner on Playwright APIRequestContext with OpenAPI validation.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add runner-api`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: runner, test data
- Permissions: network, exec, filesystem, environment
- Hosts: config
- Secrets: account credentials

## Licence

Apache-2.0
