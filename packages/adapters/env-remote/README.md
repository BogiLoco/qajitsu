# @qajitsu/adapter-env-remote

QAJitsu EnvProvider for an existing environment given by profile or URL.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

This plugin comes with the CLI: `npm install -g @qajitsu/cli` installs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: environment provider
- Permissions: network, exec, environment
- Hosts: config
- Secrets: account credentials, TOTP seeds

## Licence

Apache-2.0
