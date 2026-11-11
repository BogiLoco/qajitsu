# @qajitsu/adapter-env-compose

QAJitsu --build environment: Docker Compose overlay with labels and dynamic ports, managed processes, stubs, health checks and seeding.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add env-compose`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: environment provider
- Permissions: network, exec, filesystem, environment
- Hosts: localhost
- Secrets: service variables

## Licence

Apache-2.0
