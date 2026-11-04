# @qajitsu/adapter-knowledge-lancedb

QAJitsu VectorStore on LanceDB, embedded in the process, one database per project (ADR-0007).

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add knowledge-lancedb`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: knowledge store
- Permissions: filesystem
- Hosts: none
- Secrets: none

## Licence

Apache-2.0
