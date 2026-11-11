# @qajitsu/adapter-codehost-github

QAJitsu CodeHost for GitHub and GitHub Enterprise Server.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add codehost-github`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: code host
- Permissions: network
- Hosts: api.github.com, github.com, config
- Secrets: token or GitHub App private key

## Licence

Apache-2.0
