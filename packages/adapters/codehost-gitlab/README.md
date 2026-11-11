# @qajitsu/adapter-codehost-gitlab

QAJitsu CodeHost for GitLab.com and GitLab self-managed.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add codehost-gitlab`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: code host
- Permissions: network
- Hosts: gitlab.com, config
- Secrets: access token

## Licence

Apache-2.0
