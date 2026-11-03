---
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/adapter-knowledge-lancedb": minor
---

LanceDB, the default knowledge store, is no longer part of the CLI installation (REQ-GEN-11/AC1). It is installed
with `qj plugin add knowledge-lancedb`, or by `qj setup` for a project with a knowledge base. This takes the
published CLI from 389 MB to 141 MB. The adapter takes `@qajitsu/core` as a peer dependency. Plugin manifests can
list `omit_optional`: optional dependencies the plugin never loads, which are installed as empty packages. LanceDB
uses it for its own embedding helpers, so the installed plugin is 245 MB instead of 607 MB. A plugin's manifest is
read from its tarball and checked before npm runs.
