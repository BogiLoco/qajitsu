---
"@qajitsu/guard": minor
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/adapter-env-compose": patch
"@qajitsu/adapter-env-remote": patch
"@qajitsu/adapter-publish-jira": patch
"@qajitsu/adapter-runner-api": patch
"@qajitsu/adapter-runner-mobile": patch
---

The guard holds every plugin to its manifest (REQ-GEN-11/AC4+AC9, ADR-0015). `@qajitsu/guard` adds
`checkPluginCode`. At install, and again before an installed plugin is loaded, the plugin's own code is checked
against its permissions: Node's network, process and file modules, reads of `process.env` and the global `fetch`. A
plugin that does more than it declares, or that refers to the frozen plan, is refused. Every HTTP call of an
integration plugin goes through a guarded `fetch` that allows only its manifest's hosts and the URLs the project
configures for it. Plugin manifests get the `environment` permission, and five manifests that understated their code
are corrected.
