---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/adapter-codehost-github": patch
"@qajitsu/adapter-codehost-gitlab": patch
"@qajitsu/adapter-codehost-local": patch
"@qajitsu/adapter-env-compose": patch
"@qajitsu/adapter-env-remote": patch
"@qajitsu/adapter-evidence-local": patch
"@qajitsu/adapter-evidence-s3": patch
"@qajitsu/adapter-knowledge-chroma": patch
"@qajitsu/adapter-knowledge-confluence": patch
"@qajitsu/adapter-knowledge-lancedb": patch
"@qajitsu/adapter-messages-webhooksite": patch
"@qajitsu/adapter-publish-jira": patch
"@qajitsu/adapter-runner-api": patch
"@qajitsu/adapter-runner-mobile": patch
"@qajitsu/adapter-runner-web": patch
"@qajitsu/adapter-secrets-cli": patch
"@qajitsu/adapter-secrets-doppler": patch
"@qajitsu/adapter-secrets-env": patch
"@qajitsu/adapter-secrets-vault": patch
"@qajitsu/adapter-testcases": patch
"@qajitsu/adapter-ticket-jira": patch
---

Plugins installed on demand (REQ-GEN-11). `@qajitsu/core` adds `PLUGIN_API_VERSION`, `PLUGIN_TYPES`,
`parsePluginManifest` and `PluginError`. Every adapter package now carries its plugin manifest under
`qajitsu.plugin`. The CLI adds `qj plugin list|add|remove`, which installs the version a release pins from the npm
registry, checked against its published checksum and without install scripts. `qj doctor` names missing plugins and
`--fix` installs them, `qj setup` installs the plugins a project needs, runs record the plugin versions they used,
and `qj knowledge` loads its stores and sources through the plugin loader.
