---
"@qajitsu/cli": patch
"@qajitsu/adapter-knowledge-chroma": minor
---

The Chroma knowledge store is a plugin (REQ-GEN-11/AC1): `qj plugin add knowledge-chroma`. `qj setup` installs it
for a project with `knowledge.store: chroma`. The adapter now takes `@qajitsu/core` as a peer dependency.
