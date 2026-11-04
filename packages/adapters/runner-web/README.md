# @qajitsu/adapter-runner-web

QAJitsu web UI runner: the trusted parent drives Playwright with screenshots, video, trace, HAR and console log.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add runner-web`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: runner
- Permissions: network, exec, filesystem
- Hosts: config
- Secrets: account credentials, TOTP seeds

## Licence

Apache-2.0
