# @qajitsu/adapter-publish-jira

QAJitsu Publisher: Jira comment (ADF on Cloud, wiki markup on Data Center) with attachments.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add publish-jira`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: publisher, ticket workflow, bug tracker
- Permissions: network, filesystem
- Hosts: *.atlassian.net, config
- Secrets: API token

## Licence

Apache-2.0
