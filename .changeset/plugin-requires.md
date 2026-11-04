---
"@qajitsu/cli": minor
---

A plugin can need other plugins (REQ-GEN-11/AC3). It declares them as `@qajitsu/adapter-*` peer dependencies.
`qj plugin add`, `qj setup` and `qj doctor --fix` install them along with it, and the loader links them, from this
installation or its installed plugins, before the plugin loads. A missing one is named with its install command. Every
other QAJitsu package is removed from a plugin's folder, so plugins always share the installation's copies.
