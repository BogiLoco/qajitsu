# @qajitsu/adapter-testcases

QAJitsu TestCaseSource adapters: manual test cases from Xray Cloud, Zephyr Scale, TestRail and CSV/Excel files.

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add testcases`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: test-case source
- Permissions: network, filesystem
- Hosts: xray.cloud.getxray.app, api.zephyrscale.smartbear.com, config
- Secrets: client secret, API token

## Licence

Apache-2.0
