# @qajitsu/adapter-runner-mobile

QAJitsu mobile Runner on WebdriverIO and Appium (Android UiAutomator2, iOS XCUITest).

A [QAJitsu](https://github.com/BogiLoco/qajitsu) plugin (REQ-GEN-11).

## Install

Install it into a QAJitsu installation with `qj plugin add runner-mobile`; `qj doctor` names it when a project needs it.

## What it may do

The guard holds the plugin to this manifest at install and before every load (ADR-0015).

- Types: runner, device provider
- Permissions: network, exec, filesystem, environment
- Hosts: localhost, config
- Secrets: account credentials, device farm access key

## Licence

Apache-2.0
