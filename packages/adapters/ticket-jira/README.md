# @qajitsu/adapter-ticket-jira

QAJitsu TicketSource for Jira Cloud (REST v3).

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add ticket-jira`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: ticket source, document source
- Permissions: network
- Hosts: *.atlassian.net, config
- Secrets: API token

## Licence

Apache-2.0
