# @qajitsu/adapter-knowledge-chroma

QAJitsu VectorStore on a shared Chroma server over its HTTP API, one collection per project.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add knowledge-chroma`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: knowledge store
- Permissions: network
- Hosts: config
- Secrets: Chroma token

## Licence

Apache-2.0
