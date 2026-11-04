# @qajitsu/adapter-secrets-doppler

QAJitsu SecretProvider 'doppler': Doppler secrets over HTTP.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add secrets-doppler`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: secret provider
- Permissions: network
- Hosts: api.doppler.com
- Secrets: Doppler service token

## Licence

Apache-2.0
